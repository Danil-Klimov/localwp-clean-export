'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { finished } = require('node:stream/promises');
const { createExcluder } = require('./exclusions');
const { abortError } = require('./database');

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function* walkFiles(root, excluded, signal, summary, directory = '') {
  const handle = await fsp.opendir(path.join(root, directory));
  for await (const entry of handle) {
    signal?.throwIfAborted();
    const relative = path.join(directory, entry.name);
    const absolute = path.join(root, relative);
    const stat = await fsp.lstat(absolute);
    if (excluded(relative, stat.isDirectory())) {
      summary.excluded += 1;
      continue; // Prune excluded directories, including all of their descendants.
    }
    const name = relative.split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      let resolved;
      try { resolved = await fsp.realpath(absolute); }
      catch (error) {
        if (['ENOENT', 'ELOOP'].includes(error.code)) { summary.skippedLinks += 1; continue; }
        throw error;
      }
      if (!isInside(root, resolved)) { summary.skippedLinks += 1; continue; }
      yield { type: 'symlink', name, target: path.relative(path.dirname(absolute), resolved).split(path.sep).join('/'), stat };
    } else if (stat.isDirectory()) {
      yield { type: 'directory', name: `${name}/`, stat };
      yield* walkFiles(root, excluded, signal, summary, relative);
    } else if (stat.isFile()) {
      yield { type: 'file', name, absolute, stat };
    } else {
      throw new Error(`Непідтримуваний тип файлу: ${name}. Архів не збережено.`);
    }
  }
}

async function chooseSqlName(root) {
  const names = new Set((await fsp.readdir(root)).map(name => name.toLowerCase()));
  for (let i = 0; ; i += 1) {
    const name = i ? `database-${i}.sql` : 'database.sql';
    if (!names.has(name)) return name;
  }
}

async function writeZip({ root, sqlPath, sqlName, destination, excluded, archiver, signal, onProgress, summary }) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let failure;
  const stop = error => {
    failure ||= error;
    archive.abort();
    archive.destroy();
    output.destroy(error);
  };
  const onAbort = () => stop(abortError());
  archive.on('error', stop);
  // A missing/unreadable file must fail the export, never silently disappear.
  archive.on('warning', stop);
  output.on('error', stop);
  const completed = finished(output);
  // Attach immediately; an output error can happen while walking the tree.
  completed.catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  archive.pipe(output);
  try {
    signal?.throwIfAborted();
    for await (const entry of walkFiles(root, excluded, signal, summary)) {
      if (failure) throw failure;
      if (entry.type === 'directory') {
        archive.append(null, { name: entry.name, date: entry.stat.mtime, mode: entry.stat.mode });
      } else if (entry.type === 'symlink') {
        archive.symlink(entry.name, entry.target, entry.stat.mode);
        summary.files += 1;
      } else {
        archive.file(entry.absolute, { name: entry.name, stats: entry.stat });
        summary.files += 1;
      }
      onProgress({ stage: 'files', files: summary.files, excluded: summary.excluded });
    }
    if (failure) throw failure;
    signal?.throwIfAborted();
    // The fresh database is mandatory and is not subject to file exclusions.
    archive.file(sqlPath, { name: sqlName });
    onProgress({ stage: 'compressing', files: summary.files, excluded: summary.excluded });
    await Promise.all([archive.finalize(), completed]);
    if (failure) throw failure;
  } catch (error) {
    stop(error);
    await completed.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function exportWordPress({ webRoot, siteRoot, destination, filter, archiver, micromatch,
  dump, signal, onProgress = () => {}, tempParent = os.tmpdir() }) {
  const root = await fsp.realpath(webRoot);
  const selected = path.resolve(destination);
  const parent = await fsp.realpath(path.dirname(selected));
  const finalPath = path.join(parent, path.basename(selected));
  // Prevent recursively archiving our output or putting a backup among Local's
  // own config/SQL files. The save dialog can select any other directory.
  const realSiteRoot = await fsp.realpath(siteRoot);
  if (isInside(realSiteRoot, finalPath) || isInside(root, finalPath)) {
    throw new Error('Виберіть місце для ZIP поза папкою сайту Local.');
  }
  try {
    const existing = await fsp.lstat(finalPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Місце збереження має бути звичайним ZIP-файлом.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const excluded = createExcluder(filter, micromatch);
  signal?.throwIfAborted();
  const temp = await fsp.mkdtemp(path.join(tempParent, 'local-clean-export-'));
  let stagingDirectory;
  try {
    await fsp.chmod(temp, 0o700);
    const sqlPath = path.join(temp, 'database.sql');
    const sqlName = await chooseSqlName(root);
    const summary = { files: 0, excluded: 0, skippedLinks: 0, sqlName, filter };
    onProgress({ stage: 'database' });
    await dump(sqlPath, signal);
    signal?.throwIfAborted();
    const sqlStat = await fsp.stat(sqlPath);
    if (!sqlStat.isFile() || sqlStat.size === 0) throw new Error('Не отримано непорожній SQL-дамп.');
    // Write beside the destination, then rename on success. An existing backup
    // survives a failed or cancelled export; incomplete ZIPs are never published.
    stagingDirectory = await fsp.mkdtemp(path.join(parent, '.local-clean-export-'));
    await fsp.chmod(stagingDirectory, 0o700);
    const stagingPath = path.join(stagingDirectory, 'export.zip');
    await writeZip({ root, sqlPath, sqlName, destination: stagingPath, excluded,
      archiver, signal, onProgress, summary });
    signal?.throwIfAborted();
    await fsp.rename(stagingPath, finalPath);
    return { ...summary, destination: finalPath, bytes: (await fsp.stat(finalPath)).size };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
    if (stagingDirectory) await fsp.rm(stagingDirectory, { recursive: true, force: true });
  }
}

module.exports = { exportWordPress, isInside };
