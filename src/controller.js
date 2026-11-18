'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { PREFIX, DEFAULT_FILTER } = require('./constants');
const { dumpDatabase } = require('./database');
const { exportWordPress } = require('./export');
const { prepareDomainReplacement, replaceDomainInDump } = require('./domain-replacement');

function createController({ services, electron, archiver, micromatch }) {
  const jobs = new Map();
  const lastExports = new Map();
  const getFilter = () => {
    const value = services.userData.get('settings-exporting', { filter: DEFAULT_FILTER });
    if (!value || typeof value.filter !== 'string') {
      throw new Error('Не вдалося прочитати File exclusion filter у налаштуваннях Local.');
    }
    return value.filter;
  };
  const getSite = siteId => {
    if (typeof siteId !== 'string') throw new Error('Не вказано сайт Local.');
    const site = services.siteData.getSite(siteId);
    if (!site) throw new Error('Сайт більше не існує в Local.');
    return site;
  };
  const status = site => services.siteProcessManager.getSiteStatus(site);
  return {
    async info(_event, siteId) {
      const site = getSite(siteId);
      return { filter: getFilter(), sourceDomain: site.domain || '', status: status(site), busy: jobs.has(siteId),
        lastExport: lastExports.get(siteId) || null };
    },
    async start(event, siteId, options = {}) {
      if (jobs.has(siteId)) throw new Error('Для цього сайту вже виконується експорт.');
      const site = getSite(siteId);
      if (status(site) !== 'running') throw new Error('Запустіть сайт у Local перед експортом.');
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Некоректні параметри експорту.');
      prepareDomainReplacement(site.domain, options.targetDomain);
      const controller = new AbortController();
      jobs.set(siteId, { controller, sender: event.sender });
      let lastProgress = 0;
      const report = (progress, force = false) => {
        const now = Date.now();
        if (!force && progress.stage === 'files' && now - lastProgress < 200) return;
        lastProgress = now;
        if (!event.sender.isDestroyed()) event.sender.send(`${PREFIX}:progress`, { siteId, ...progress });
      };
      try {
        const filename = `${site.name.replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'wordpress'}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
        const saveOptions = { title: 'Експорт WordPress', defaultPath: filename,
          buttonLabel: 'Зберегти ZIP', filters: [{ name: 'ZIP archive', extensions: ['zip'] }] };
        const owner = electron.BrowserWindow.fromWebContents(event.sender);
        const selected = owner
          ? await electron.dialog.showSaveDialog(owner, saveOptions)
          : await electron.dialog.showSaveDialog(saveOptions);
        if (selected.canceled || !selected.filePath || controller.signal.aborted) {
          report({ stage: 'canceled' }, true);
          return { canceled: true };
        }
        let destination = selected.filePath;
        if (path.extname(destination).toLowerCase() !== '.zip') destination += '.zip';
        // The native dialog only confirmed the exact name it returned. If we
        // appended .zip, do not overwrite a different existing file silently.
        if (destination !== selected.filePath && fs.existsSync(destination)) {
          const overwriteOptions = { type: 'question', title: 'Замінити ZIP?',
            message: 'Архів із такою назвою вже існує.', detail: destination,
            buttons: ['Замінити', 'Скасувати'], defaultId: 1, cancelId: 1 };
          const answer = owner
            ? await electron.dialog.showMessageBox(owner, overwriteOptions)
            : await electron.dialog.showMessageBox(overwriteOptions);
          if (answer.response !== 0 || controller.signal.aborted) {
            report({ stage: 'canceled' }, true);
            return { canceled: true };
          }
        }
        // Read after the dialog, so changes saved in Preferences are used now.
        const filter = getFilter();
        const currentSite = getSite(siteId);
        if (status(currentSite) !== 'running') throw new Error('Сайт зупинено. Запустіть його та повторіть експорт.');
        const dbService = services.lightningServices.getSiteServiceByRole(currentSite, 'db');
        const replacement = prepareDomainReplacement(currentSite.domain, options.targetDomain);
        const result = await exportWordPress({
          webRoot: currentSite.paths.webRoot, siteRoot: currentSite.longPath,
          destination, filter, archiver, micromatch, signal: controller.signal,
          dump: (file, signal) => dumpDatabase(dbService, currentSite.mysql.database, file, signal),
          transformDump: replacement ? (file, signal) => replaceDomainInDump(file, replacement, signal) : undefined,
          onProgress: report,
        });
        lastExports.set(siteId, result);
        report({ stage: 'done', result }, true);
        return result;
      } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') {
          report({ stage: 'canceled' }, true);
          return { canceled: true };
        }
        report({ stage: 'error', error: error.message }, true);
        throw error;
      } finally {
        jobs.delete(siteId);
      }
    },
    async cancel(event, siteId) {
      const job = jobs.get(siteId);
      if (job?.sender === event.sender) job.controller.abort();
    },
    async reveal(_event, siteId) {
      const result = lastExports.get(siteId);
      if (result) electron.shell.showItemInFolder(result.destination);
    },
    shutdown() {
      for (const job of jobs.values()) job.controller.abort();
    },
  };
}

module.exports = { createController };
