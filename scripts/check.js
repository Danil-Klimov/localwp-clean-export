'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
for (const directory of ['src', 'scripts', 'test']) {
  if (!fs.existsSync(path.join(root, directory))) continue;
  for (const name of fs.readdirSync(path.join(root, directory))) {
    if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit' });
  }
}
const manifest = require('../package.json');
for (const key of ['main', 'renderer']) {
  if (!fs.existsSync(path.join(root, manifest[key]))) throw new Error(`Missing ${key} entry point`);
}
console.log('Syntax and manifest checks passed.');
