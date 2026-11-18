'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const resources = process.env.LOCAL_APP_PATH || path.join(process.resourcesPath || path.join(path.dirname(process.execPath), 'resources'), 'app.asar');
const localRequire = createRequire(path.join(resources, 'package.json'));
const archiver = localRequire('archiver');
const micromatch = localRequire('micromatch');
const StreamZip = localRequire('node-stream-zip');
const { exportWordPress } = require('../src/export');
const { createExcluder } = require('../src/exclusions');
const { dumpDatabase } = require('../src/database');
const { createController } = require('../src/controller');

async function zipContents(filename) {
  const zip = new StreamZip.async({ file: filename });
  try {
    const entries = await zip.entries();
    const data = {};
    for (const entry of Object.values(entries)) {
      if (!entry.isDirectory) data[entry.name] = (await zip.entryData(entry.name)).toString();
    }
    return { names: Object.keys(entries), data };
  } finally { await zip.close(); }
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'clean-export-test-'));
  let passed = 0;
  const check = async (name, run) => { await run(); passed += 1; console.log(`PASS ${name}`); };
  try {
    const siteRoot = path.join(temp, 'site with spaces');
    const webRoot = path.join(siteRoot, 'app/public');
    const files = {
      'app/public/index.php': '<?php /* WordPress */',
      'app/public/wp-config.php': '<?php /* config */',
      'app/public/.htaccess': '# hidden file',
      'app/public/.well-known/example': 'hidden directory contents',
      'app/public/wp-includes/version.php': '<?php $wp_version = "6.0";',
      'app/public/wp-content/uploads/2026/зображення.txt': 'Тест',
      'app/public/wp-content/cache/nested/object.txt': 'exclude cache contents',
      'app/public/wp-content/themes/custom/node_modules/nested/lib.js': 'exclude nested node_modules',
      'app/public/wp-content/debug.log': 'exclude extension',
      'app/public/wp-content/plugins/legacy/data.txt': 'exclude Local-root pattern',
      'app/public/backup.zip': 'exclude default extension',
      'app/public/database.sql': '-- preserve an existing WordPress file',
      'app/public/local-site.json': 'exclude metadata even inside webroot',
      'conf/nginx/site.conf': 'NEVER export Local configuration',
      'logs/php/error.log': 'NEVER export Local logs',
      'local-site.json': 'NEVER export Local metadata',
      'app/sql/stale.sql': 'NEVER export a stale database',
    };
    for (const [relative, value] of Object.entries(files)) {
      const filename = path.join(siteRoot, relative);
      await fsp.mkdir(path.dirname(filename), { recursive: true });
      await fsp.writeFile(filename, value);
    }
    await fsp.mkdir(path.join(webRoot, 'wp-content/empty'), { recursive: true });
    await fsp.symlink(path.join(temp, 'outside'), path.join(webRoot, 'external-link'));
    await fsp.writeFile(path.join(temp, 'outside'), 'NEVER follow external symlinks');
    await fsp.symlink(path.join(webRoot, 'index.php'), path.join(webRoot, 'internal-link'));
    const destination = path.join(temp, 'wordpress.zip');
    const sql = '-- fresh SQL\nCREATE TABLE wp_test (id int);\n';
    const options = { webRoot, siteRoot, destination, archiver, micromatch, tempParent: temp,
      filter: '*.zip, *.log, node_modules, wp-content/cache/, /app/public/wp-content/plugins/legacy/**',
      dump: async file => fsp.writeFile(file, sql, { mode: 0o600 }) };

    await check('ZIP contains only WordPress and a fresh SQL dump; hidden files, Unicode and empty directories survive', async () => {
      const result = await exportWordPress(options);
      assert.equal(result.sqlName, 'database-1.sql');
      assert.equal(result.skippedLinks, 1);
      const zip = await zipContents(destination);
      assert.equal(zip.data['index.php'], files['app/public/index.php']);
      assert.equal(zip.data['wp-config.php'], files['app/public/wp-config.php']);
      assert.equal(zip.data['.htaccess'], '# hidden file');
      assert.equal(zip.data['.well-known/example'], 'hidden directory contents');
      assert.equal(zip.data['wp-content/uploads/2026/зображення.txt'], 'Тест');
      assert.equal(zip.data['database-1.sql'], sql);
      assert.equal(zip.data['database.sql'], '-- preserve an existing WordPress file');
      assert(zip.names.includes('wp-content/empty/'));
      assert.equal(zip.data['internal-link'], 'index.php');
      for (const name of zip.names) {
        assert(!name.startsWith('/') && !name.includes('..'));
        assert(!/^(app|conf|logs)\//.test(name), name);
        assert(!/cache|node_modules|debug\.log|backup\.zip|local-site\.json|external-link|legacy\//.test(name), name);
      }
      assert.equal((await fsp.stat(destination)).mode & 0o777, 0o600);
    });
    await check('native basename, absolute Local paths and relative WordPress paths match, including dotfiles', async () => {
      for (const pattern of ['node_modules', '**/node_modules/**', '/app/public/wp-content/**', 'wp-content/**']) {
        const excluded = createExcluder(pattern, micromatch);
        assert(excluded('wp-content/themes/x/node_modules', true), pattern);
      }
      assert(createExcluder('.git', micromatch)('.git', true));
      assert(createExcluder('*.log', micromatch)('wp-content/.private.log'));
      assert(!createExcluder('', micromatch)('wp-content/uploads/file.jpg'));
      assert.throws(() => createExcluder(null, micromatch));
    });
    await check('a fresh SQL dump is mandatory even when *.sql is excluded', async () => {
      await exportWordPress({ ...options, filter: '*.sql' });
      const zip = await zipContents(destination);
      assert.equal(zip.data['database-1.sql'], sql);
      assert(!Object.hasOwn(zip.data, 'database.sql'));
    });
    await check('a failed database export preserves the previous ZIP and removes temporary data', async () => {
      const previous = await fsp.readFile(destination);
      await assert.rejects(exportWordPress({ ...options, dump: async file => {
        await fsp.writeFile(file, 'partial SQL'); throw new Error('database unavailable');
      } }), /database unavailable/);
      assert.deepEqual(await fsp.readFile(destination), previous);
      assert(!(await fsp.readdir(temp)).some(name => name.startsWith('local-clean-export-')));
    });
    await check('empty dumps fail instead of producing a misleading backup', async () => {
      await assert.rejects(exportWordPress({ ...options, dump: async file => fsp.writeFile(file, '') }), /SQL/);
    });
    await check('cancellation during file collection preserves the previous ZIP and cleans staging files', async () => {
      const previous = await fsp.readFile(destination);
      const controller = new AbortController();
      await assert.rejects(exportWordPress({ ...options, signal: controller.signal,
        onProgress: value => { if (value.stage === 'files') controller.abort(); } }), { name: 'AbortError' });
      assert.deepEqual(await fsp.readFile(destination), previous);
      assert(!(await fsp.readdir(temp)).some(name => name.startsWith('.local-clean-export-') || name.startsWith('local-clean-export-')));
    });
    await check('a file disappearing while archiving fails promptly and preserves the existing backup', async () => {
      const vanishing = path.join(webRoot, 'vanishing.txt');
      await fsp.writeFile(vanishing, 'test');
      const previous = await fsp.readFile(destination);
      const brokenArchiver = (...args) => {
        const archive = archiver(...args);
        const file = archive.file.bind(archive);
        archive.file = (filename, metadata) => {
          if (filename === vanishing) fs.unlinkSync(filename);
          return file(filename, metadata);
        };
        return archive;
      };
      let timer;
      try {
        await assert.rejects(Promise.race([
          exportWordPress({ ...options, archiver: brokenArchiver }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('archive hung')), 5000); }),
        ]), error => error.message !== 'archive hung');
      } finally { clearTimeout(timer); }
      assert.deepEqual(await fsp.readFile(destination), previous);
    });
    await check('output inside the site, symlink destinations and invalid filters are rejected', async () => {
      await assert.rejects(exportWordPress({ ...options, destination: path.join(webRoot, 'recursive.zip') }), /поза папкою/);
      const link = path.join(temp, 'symlink.zip');
      await fsp.symlink(destination, link);
      await assert.rejects(exportWordPress({ ...options, destination: link }), /звичайним/);
      await assert.rejects(exportWordPress({ ...options, filter: null }), /filter/);
    });
    await check('mysqldump output is flushed, nonzero exit codes and empty output fail', async () => {
      const script = path.join(temp, 'fake-mysqldump');
      const file = path.join(temp, 'streamed.sql');
      await fsp.writeFile(script, '#!/bin/sh\nprintf "CREATE TABLE wp_ok (id int);\\n"\n', { mode: 0o700 });
      const service = { bin: { mysqldump: script }, configPath: temp };
      await dumpDatabase(service, 'local', file);
      assert.equal(await fsp.readFile(file, 'utf8'), 'CREATE TABLE wp_ok (id int);\n');
      await fsp.writeFile(script, '#!/bin/sh\nprintf "failure" >&2\nexit 2\n', { mode: 0o700 });
      await assert.rejects(dumpDatabase(service, 'local', path.join(temp, 'failure.sql')), /failure/);
      await fsp.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await assert.rejects(dumpDatabase(service, 'local', path.join(temp, 'empty.sql')), /порожній/);
      await assert.rejects(dumpDatabase({ bin: { mysqldump: path.join(temp, 'missing') }, configPath: temp }, 'local', path.join(temp, 'missing.sql')), /ENOENT/);
    });
    await check('cancelling an active mysqldump terminates it and reports cancellation', async () => {
      const script = path.join(temp, 'slow-mysqldump');
      await fsp.writeFile(script, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
      const controller = new AbortController();
      const pending = dumpDatabase({ bin: { mysqldump: script }, configPath: temp }, 'local', path.join(temp, 'slow.sql'), controller.signal);
      const timer = setTimeout(() => controller.abort(), 30);
      try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
    });
    await check('controller reads saved exclusions each time and handles stopped sites, concurrent starts and dialog cancellation', async () => {
      let filter = '*.zip';
      let running = true;
      let closeDialog;
      const services = {
        userData: { get: () => ({ filter }) }, siteData: { getSite: id => id === 'test' ? { id, name: 'Example' } : null },
        siteProcessManager: { getSiteStatus: () => running ? 'running' : 'halted' },
      };
      const sender = { isDestroyed: () => false, send() {} };
      const controller = createController({ services, archiver, micromatch,
        electron: { BrowserWindow: { fromWebContents: () => null },
          dialog: { showSaveDialog: () => new Promise(resolve => { closeDialog = resolve; }) } } });
      assert.equal((await controller.info({}, 'test')).filter, '*.zip');
      filter = 'node_modules';
      assert.equal((await controller.info({}, 'test')).filter, 'node_modules');
      running = false;
      await assert.rejects(controller.start({ sender }, 'test'), /Запустіть/);
      running = true;
      const pending = controller.start({ sender }, 'test');
      await assert.rejects(controller.start({ sender }, 'test'), /вже/);
      closeDialog({ canceled: true });
      assert.deepEqual(await pending, { canceled: true });
      assert.equal((await controller.info({}, 'test')).busy, false);
    });
    await check('main and renderer entry points register with Local and render their tool panel', async () => {
      const Module = require('node:module');
      const originalLoad = Module._load;
      const channels = new Map();
      Module._load = function (request, parent, isMain) {
        if (request === '@getflywheel/local/main') return { getServiceContainer: () => ({ cradle: {} }) };
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        const Main = require('../src/main');
        new Main({ environment: { appPath: resources }, electron: {
          ipcMain: { handle: (channel, listener) => channels.set(channel, listener) }, app: new EventEmitter(),
        } });
      } finally { Module._load = originalLoad; }
      assert.equal(channels.size, 4);
      let filter;
      const Renderer = require('../src/renderer');
      const React = localRequire('react');
      new Renderer({ React, electron: { ipcRenderer: {} }, hooks: { addFilter: (name, callback) => {
        assert.equal(name, 'siteInfoToolsItem'); filter = callback;
      } } });
      const items = filter([], { routeChildrenProps: { site: { id: 'test' } } });
      assert.equal(items[0].path, '/clean-wordpress-export');
      const panel = items[0].render();
      const html = localRequire('react-dom/server').renderToStaticMarkup(panel);
      assert(html.includes('Clean WordPress Export') && html.includes('File exclusion filter'));
    });
    await check('appending .zip never bypasses confirmation before replacing an existing archive', async () => {
      let prompted = false;
      const sender = { isDestroyed: () => false, send() {} };
      const controller = createController({ archiver, micromatch, services: {
        siteData: { getSite: () => ({ id: 'test', name: 'Example' }) },
        siteProcessManager: { getSiteStatus: () => 'running' },
      }, electron: { BrowserWindow: { fromWebContents: () => null }, dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: destination.slice(0, -4) }),
        showMessageBox: async options => {
          prompted = true; assert.equal(options.detail, destination); return { response: 1 };
        },
      } } });
      const previous = await fsp.readFile(destination);
      assert.deepEqual(await controller.start({ sender }, 'test'), { canceled: true });
      assert(prompted);
      assert.deepEqual(await fsp.readFile(destination), previous);
    });
    await require('./domain-replacement')({ check, temp, options, zipContents, archiver, micromatch });
    console.log(`\n${passed} integration checks passed with Local ${localRequire('./package.json').version}.`);
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
