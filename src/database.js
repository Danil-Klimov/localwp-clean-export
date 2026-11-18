'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

function abortError() {
  const error = new Error('Експорт скасовано.');
  error.name = 'AbortError';
  return error;
}

async function dumpDatabase(service, database, destination, signal) {
  if (!service?.bin?.mysqldump || !service.configPath || !database || database.startsWith('-')) {
    throw new Error('Local не надав параметри mysqldump для цього сайту.');
  }
  signal?.throwIfAborted();
  // Use Local's bundled client and configuration. No shell, WP bootstrap,
  // credentials on the command line, or writes to the site's app/sql directory.
  const child = spawn(service.bin.mysqldump, [
    '--single-transaction', '--quick', '--extended-insert=FALSE', database,
  ], {
    env: { ...process.env, ...service.env, MYSQL_HOME: service.configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  let killTimer;
  const stop = () => {
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    killTimer.unref();
  };
  signal?.addEventListener('abort', stop, { once: true });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, killedBy) => {
      if (signal?.aborted) reject(abortError());
      else if (code !== 0) reject(new Error(`mysqldump завершився з кодом ${code ?? killedBy}. ${stderr.trim()}`));
      else resolve();
    });
  });
  const write = pipeline(child.stdout, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  try {
    // Wait for both process completion and the file stream to finish flushing.
    await Promise.all([exit, write]);
  } catch (error) {
    stop();
    await Promise.allSettled([exit, write]);
    throw error;
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', stop);
  }
  if ((await fs.promises.stat(destination)).size === 0) {
    throw new Error('mysqldump створив порожній файл. Архів не збережено.');
  }
}

module.exports = { dumpDatabase, abortError };
