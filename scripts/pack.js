'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
// Local's Install from disk accepts the npm .tgz format (package/ prefix).
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', dist], { cwd: root, stdio: 'inherit' });
console.log(path.join(dist, `${manifest.name}-${manifest.version}.tgz`));
