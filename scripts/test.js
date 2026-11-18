'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const candidates = [process.env.LOCAL_EXECUTABLE, '/opt/Local/local',
  '/Applications/Local.app/Contents/MacOS/Local',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Local', 'Local.exe')].filter(Boolean);
const executable = candidates.find(value => fs.existsSync(value));
if (!executable) throw new Error('Set LOCAL_EXECUTABLE to the Local executable to test against its bundled libraries.');
const result = spawnSync(executable, [path.resolve(__dirname, '../test/integration.js')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
