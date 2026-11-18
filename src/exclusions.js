'use strict';

const path = require('node:path');

// Local uses comma-separated micromatch patterns, against the basename and the
// path from the site directory (including /app/public). Also accept paths from
// the WordPress root, since that is the root of this export.
function createExcluder(filter, micromatch) {
  if (typeof filter !== 'string') {
    throw new Error('Не вдалося прочитати File exclusion filter у налаштуваннях Local.');
  }
  const patterns = ['local-site.json', 'pressmatic-site.json',
    ...filter.split(',').map(value => value.trim()).filter(Boolean)];
  return function excluded(relativePath, isDirectory = false) {
    const name = relativePath.split(path.sep).join('/').replace(/^\/+/, '');
    const candidates = [path.posix.basename(name), name, `/${name}`,
      `app/public/${name}`, `/app/public/${name}`];
    if (isDirectory) candidates.push(...candidates.map(value => `${value}/`));
    return candidates.some(value => micromatch([value], patterns, { dot: true }).length > 0);
  };
}

module.exports = { createExcluder };
