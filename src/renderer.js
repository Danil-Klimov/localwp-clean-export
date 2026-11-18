'use strict';

const { PREFIX } = require('./constants');

module.exports = function CleanWordPressExportUI(context) {
  const { React, hooks } = context;
  const { ipcRenderer } = context.electron;
  const h = React.createElement;
  const invoke = (action, siteId, ...args) => ipcRenderer.invoke(`${PREFIX}:${action}`, siteId, ...args);
  const stages = {
    database: 'Експорт бази даних…', domain: 'Заміна домену в SQL-дампі…', files: 'Додавання файлів WordPress…',
    compressing: 'Стиснення ZIP…', done: 'Архів створено.',
  };
  const style = { padding: '24px', maxWidth: '820px', lineHeight: 1.6 };
  const button = { padding: '9px 18px', cursor: 'pointer', marginRight: '10px' };

  function ExportPanel({ site, siteStatus }) {
    const [info, setInfo] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [progress, setProgress] = React.useState(null);
    const [error, setError] = React.useState('');
    const [result, setResult] = React.useState(null);
    const [targetDomain, setTargetDomain] = React.useState('');
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      let active = true;
      const refresh = () => invoke('info', site.id).then(value => {
        if (active) { setInfo(value); setBusy(value.busy); if (!value.busy && value.lastExport) setResult(value.lastExport); }
      }).catch(value => { if (active) setError(value.message); });
      const update = (_event, value) => {
        if (!active || value.siteId !== site.id) return;
        setProgress(value);
        if (['done', 'canceled', 'error'].includes(value.stage)) setBusy(false);
        if (value.stage === 'done') { setResult(value.result); setBusy(false); }
        if (value.stage === 'error') setError(value.error);
      };
      refresh();
      window.addEventListener('focus', refresh);
      ipcRenderer.on(`${PREFIX}:progress`, update);
      return () => {
        active = false; mounted.current = false;
        window.removeEventListener('focus', refresh);
        ipcRenderer.removeListener(`${PREFIX}:progress`, update);
      };
    }, [site.id, siteStatus]);
    const start = async () => {
      setBusy(true); setError(''); setResult(null);
      setProgress({ stage: 'selecting' });
      try {
        const value = await invoke('start', site.id, { targetDomain });
        if (mounted.current) {
          setResult(value.canceled ? null : value);
          setProgress(value.canceled ? { stage: 'canceled' } : { stage: 'done' });
          if (value.filter !== undefined) setInfo(old => ({ ...old, filter: value.filter }));
        }
      } catch (value) {
        if (mounted.current) { setError(value.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); setProgress(null); }
      } finally {
        if (mounted.current) setBusy(false);
      }
    };
    const refresh = async () => {
      try { setInfo(await invoke('info', site.id)); setError(''); }
      catch (value) { setError(value.message); }
    };
    return h('section', { style },
      h('h2', null, 'Clean WordPress Export'),
      h('p', null, 'ZIP із файлами WordPress у корені та свіжим SQL-дампом бази даних.'),
      h('p', null, 'Виключення з Preferences → Exporting → File exclusion filter:'),
      h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '12px', border: '1px solid currentColor', borderRadius: '4px' } },
        info ? (info.filter || 'Виключення не задані') : 'Завантаження…'),
      h('p', null, 'Папка, що відповідає виключенню, пропускається разом з усім вмістом. Дамп бази додається завжди, зокрема при виключенні *.sql.'),
      h('div', { style: { margin: '18px 0' } },
        h('label', { htmlFor: 'clean-export-target-domain', style: { display: 'block', marginBottom: '6px' } }, 'Новий домен (необов’язково)'),
        h('input', { id: 'clean-export-target-domain', type: 'text', value: targetDomain, disabled: busy,
          onChange: event => setTargetDomain(event.target.value), placeholder: 'example.com або https://example.com',
          autoCapitalize: 'none', autoComplete: 'off', spellCheck: false, 'aria-describedby': 'clean-export-domain-help',
          style: { width: '100%', maxWidth: '520px', boxSizing: 'border-box', padding: '9px 12px',
            color: 'inherit', backgroundColor: 'transparent', caretColor: 'currentColor',
            border: '1px solid currentColor', borderRadius: '4px' } }),
        info?.sourceDomain && h('p', { style: { margin: '6px 0' } }, `Поточний домен: ${info.sourceDomain}`),
        h('p', { id: 'clean-export-domain-help', style: { margin: '6px 0' } },
          'Порожнє поле — звичайний експорт. Новий домен зміниться лише в експортованій базі. Для переходу на HTTPS вкажіть https://example.com.')),
      info?.status !== 'running' && h('p', null, 'Перед експортом запустіть сайт у Local.'),
      h('div', null,
        h('button', { type: 'button', style: button, onClick: start, disabled: busy || !info || info.status !== 'running' }, busy ? 'Експорт триває…' : 'Експортувати WordPress'),
        busy ? h('button', { type: 'button', style: button, onClick: () => invoke('cancel', site.id).catch(value => setError(value.message)) }, 'Скасувати')
          : h('button', { type: 'button', style: button, onClick: refresh }, 'Оновити виключення')),
      h('p', { role: 'status', 'aria-live': 'polite' },
        progress && (stages[progress.stage] || ({ selecting: 'Виберіть місце збереження ZIP…', canceled: 'Експорт скасовано.' })[progress.stage]),
        progress?.stage === 'files' && ` Файлів: ${progress.files}. Виключень: ${progress.excluded}.`),
      error && h('p', { role: 'alert', style: { color: '#d9534f', whiteSpace: 'pre-wrap' } }, error),
      result && h('div', null,
        h('p', null, `Збережено ${result.files} файлів WordPress і ${result.sqlName}. Розмір: ${(result.bytes / 1024 / 1024).toFixed(1)} МБ.`),
        result.domainReplacement && h('p', null,
          `Домен: ${result.domainReplacement.sourceDomain} → ${result.domainReplacement.targetDomain}. Замін: ${result.domainReplacement.replacements}.`,
          result.domainReplacement.replacements === 0 && ' Поточний домен не знайдено в даних SQL-дампу.'),
        h('p', { style: { overflowWrap: 'anywhere' } }, result.destination),
        result.skippedLinks > 0 && h('p', null, `Пропущено зовнішніх або пошкоджених символічних посилань: ${result.skippedLinks}.`),
        h('button', { type: 'button', style: button, onClick: () => invoke('reveal', site.id).catch(value => setError(value.message)) }, 'Показати архів')));
  }

  hooks.addFilter('siteInfoToolsItem', (items, { routeChildrenProps }) => [
    ...items,
    { path: '/clean-wordpress-export', menuItem: 'Clean WordPress Export',
      render: () => h(ExportPanel, { key: routeChildrenProps.site.id, site: routeChildrenProps.site, siteStatus: routeChildrenProps.siteStatus }) },
  ]);
};
