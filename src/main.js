'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { createController } = require('./controller');
const { PREFIX } = require('./constants');

module.exports = function CleanWordPressExport(context) {
  const { getServiceContainer } = require('@getflywheel/local/main');
  // Reuse the exact archiver and micromatch shipped with Local. The installable
  // package has no npm downloads, build step, or platform-specific binaries.
  const localRequire = createRequire(path.join(context.environment.appPath, 'package.json'));
  const controller = createController({ services: getServiceContainer().cradle,
    electron: context.electron, archiver: localRequire('archiver'), micromatch: localRequire('micromatch') });
  for (const action of ['info', 'start', 'cancel', 'reveal']) {
    context.electron.ipcMain.handle(`${PREFIX}:${action}`, controller[action]);
  }
  context.electron.app.once('before-quit', controller.shutdown);
};
