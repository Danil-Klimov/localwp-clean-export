'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareDomainReplacement, replaceDomainInDump, replaceValue,
  replaceSqlLine, quoteSqlString, readSqlString } = require('../src/domain-replacement');
const { exportWordPress } = require('../src/export');
const { createController } = require('../src/controller');

module.exports = async function domainTests({ check, temp, options, zipContents, archiver, micromatch }) {
  const php = (code, input) => execFileSync(process.env.TEST_PHP || 'php', ['-n', '-d', 'error_reporting=1', '-r', code], { input });
  const plan = prepareDomainReplacement('site.local', 'https://example-production.com');
  const serialize = value => Buffer.from(`s:${Buffer.byteLength(value)}:"${value}";`);
  const makeSql = (...values) => Buffer.concat([Buffer.from('INSERT INTO `wp_options` VALUES ('),
    ...values.flatMap((value, index) => [index ? Buffer.from(',') : Buffer.alloc(0), quoteSqlString(Buffer.from(value))]), Buffer.from(');\n')]);
  const sql = makeSql('siteurl', 'http://site.local', 'home', 'http://site.local');

  await check('an empty domain bypasses replacement and preserves the exact exported SQL bytes', async () => {
    for (const input of ['', '  ', undefined]) assert.equal(prepareDomainReplacement(undefined, input), null);
    const result = await exportWordPress({ ...options, dump: file => fsp.writeFile(file, sql) });
    assert.equal(result.domainReplacement, undefined);
    assert.equal((await zipContents(options.destination)).data[result.sqlName], sql.toString());
    const file = path.join(temp, 'unchanged.sql');
    await fsp.writeFile(file, sql);
    assert.equal(await replaceDomainInDump(file, null), null);
    assert.deepEqual(await fsp.readFile(file), sql);
  });
  await check('a bare domain preserves URL protocols; an explicit protocol updates normal and JSON-escaped URLs', async () => {
    const source = Buffer.from('http://site.local/path https://site.local/path http:\\/\\/site.local/x site.local user@site.local');
    const bare = replaceValue(source, prepareDomainReplacement('site.local', 'example.com')).value.toString();
    assert.equal(bare, 'http://example.com/path https://example.com/path http:\\/\\/example.com/x example.com user@example.com');
    const explicit = replaceValue(source, plan).value.toString();
    assert.equal(explicit, 'https://example-production.com/path https://example-production.com/path https:\\/\\/example-production.com/x example-production.com user@example-production.com');
    assert.equal(replaceValue(Buffer.from('http://site.local'), prepareDomainReplacement('site.local', 'preview.site.local')).value.toString(), 'http://preview.site.local');
    assert.equal(prepareDomainReplacement('site.local', 'https://приклад.укр').targetDomain, 'https://xn--80aikifvh.xn--j1amh');
    for (const target of ['https://example.com/path', 'https://user:password@example.com', 'ftp://example.com', 'example.com?x=1', 'example.com/#test', 'bad host', '--example', 42, null]) {
      assert.throws(() => prepareDomainReplacement('site.local', target), undefined, String(target));
    }
    assert.throws(() => prepareDomainReplacement('', 'example.com'));
  });
  await check('real PHP confirms byte-correct nested serialization, objects, references, enums and custom serialized payloads', async () => {
    const fixture = php(`
      class Payload {
        private string $private;
        protected string $protected;
        public function __construct(public string $url) { $this->private=$url; $this->protected=$url; }
      }
      enum State { case Ready; }
      class Wrapped implements Serializable {
        public function __construct(private array $data) {}
        public function serialize(): string { return serialize($this->data); }
        public function unserialize(string $data): void { $this->data=unserialize($data); }
      }
      function fixture($host, $protocol) {
        $url=$protocol . '://' . $host . '/шлях/😀';
        $ref=$url;
        return [
          'url'=>$url, 'object'=>new Payload($url), 'null'=>null, 'bool'=>true,
          'int'=>42, 'double'=>1.25, 'infinity'=>INF, 'enum'=>State::Ready,
          'nested'=>serialize(['url'=>$url, 'double'=>serialize([$url])]),
          'json'=>json_encode(['url'=>$url], JSON_UNESCAPED_UNICODE),
          'nul'=>chr(0).$url.chr(10).chr(39).chr(92).'end', 'references'=>[&$ref, &$ref],
          'custom'=>new Wrapped(['url'=>$url]),
        ];
      }
      echo json_encode([base64_encode(serialize(fixture('site.local','http'))), base64_encode(serialize(fixture('example-production.com','https')))]);
    `);
    const [source, expected] = JSON.parse(fixture).map(value => Buffer.from(value, 'base64'));
    const changed = replaceValue(source, plan);
    assert(changed.replacements > 8);
    assert.deepEqual(changed.value, expected);
    assert.equal(php('enum State { case Ready; } $v=unserialize(stream_get_contents(STDIN),["allowed_classes"=>false]); echo is_array($v)?"valid":"invalid";', changed.value).toString(), 'valid');
    const spaced = Buffer.concat([Buffer.from('\n '), source, Buffer.from(' \r\n')]);
    assert.deepEqual(replaceValue(spaced, plan).value, Buffer.concat([Buffer.from('\n '), expected, Buffer.from(' \r\n')]));
  });
  await check('SQL quoting preserves nulls, control bytes, binary bytes, Unicode and doubled quotes', async () => {
    const original = Buffer.concat([Buffer.from([0, 8, 9, 10, 13, 26, 255]), Buffer.from("http://site.local/шлях'\\%\\_")]);
    const quoted = quoteSqlString(original);
    assert.deepEqual(readSqlString(quoted, 0).value, original);
    const changed = replaceSqlLine(Buffer.concat([Buffer.from('INSERT INTO `table` VALUES ('), quoted, Buffer.from(');\n')]), plan);
    const first = changed.value.indexOf(39);
    assert.deepEqual(readSqlString(changed.value, first).value,
      Buffer.concat([Buffer.from([0, 8, 9, 10, 13, 26, 255]), Buffer.from("https://example-production.com/шлях'\\%\\_")]));
    const doubled = replaceSqlLine(Buffer.from("INSERT INTO `site.local``table` VALUES ('it''s http://site.local');\n"), plan);
    assert(doubled.value.toString().startsWith('INSERT INTO `site.local``table`'));
    assert.equal(readSqlString(doubled.value, doubled.value.indexOf(39)).value.toString(), "it's https://example-production.com");
    assert.equal(replaceSqlLine(Buffer.from('-- http://site.local\n'), plan).replacements, 0);
    assert.equal(replaceSqlLine(Buffer.from("CREATE TABLE `table` (`url` text DEFAULT 'http://site.local');\n"), plan).replacements, 0);
  });
  await check('hexadecimal BLOB values are migrated with serialization lengths intact; unrelated binary data stays exact', async () => {
    const value = serialize('http://site.local/😀');
    const line = Buffer.from(`INSERT INTO \`wp_options\` VALUES (0x${value.toString('hex')},0x00FF1A);\n`);
    const changed = replaceSqlLine(line, plan);
    const hex = /VALUES \(0x([A-F0-9]+)/.exec(changed.value.toString())[1];
    assert.deepEqual(Buffer.from(hex, 'hex'), serialize('https://example-production.com/😀'));
    assert(changed.value.toString().includes(',0x00FF1A)'));
  });
  await check('large SQL fields spanning stream chunks are replaced and only the temporary dump is rewritten', async () => {
    const filename = path.join(temp, 'large-domain.sql');
    const payload = `prefix-${'x'.repeat(65530)}-http://site.local/😀-${'y'.repeat(150000)}`;
    await fsp.writeFile(filename, makeSql(serialize(payload)));
    const result = await replaceDomainInDump(filename, plan);
    assert.equal(result.replacements, 1);
    const data = await fsp.readFile(filename);
    assert.equal(php('echo unserialize(stream_get_contents(STDIN));', readSqlString(data, data.indexOf(39)).value).toString(), payload.replace('http://site.local', 'https://example-production.com'));
    assert(!(await fsp.readdir(temp)).includes('large-domain.sql.replaced'));
  });
  await check('the export archive receives the migrated SQL and the source dump and WordPress files remain unchanged', async () => {
    const source = path.join(temp, 'source-database.sql');
    await fsp.writeFile(source, sql);
    const originalConfig = await fsp.readFile(path.join(options.webRoot, 'wp-config.php'));
    const stages = [];
    const result = await exportWordPress({ ...options,
      dump: file => fsp.copyFile(source, file), transformDump: (file, signal) => replaceDomainInDump(file, plan, signal),
      onProgress: value => stages.push(value.stage),
    });
    const zip = await zipContents(options.destination);
    assert(zip.data[result.sqlName].includes('https://example-production.com'));
    assert(!zip.data[result.sqlName].includes('site.local'));
    assert.equal(result.domainReplacement.replacements, 2);
    assert(stages.includes('domain'));
    assert.deepEqual(await fsp.readFile(source), sql);
    assert.deepEqual(await fsp.readFile(path.join(options.webRoot, 'wp-config.php')), originalConfig);
  });
  await check('invalid serialized data fails safely, preserves the previous ZIP and leaves no rewritten dump', async () => {
    const previous = await fsp.readFile(options.destination);
    const filename = path.join(temp, 'invalid-domain.sql');
    const invalid = makeSql('s:2:"http://site.local";');
    await fsp.writeFile(filename, invalid);
    await assert.rejects(replaceDomainInDump(filename, plan), /серіалізовані/);
    assert.deepEqual(await fsp.readFile(filename), invalid);
    assert(!fs.existsSync(`${filename}.replaced`));
    await assert.rejects(exportWordPress({ ...options, dump: file => fsp.writeFile(file, invalid),
      transformDump: (file, signal) => replaceDomainInDump(file, plan, signal) }), /серіалізовані/);
    assert.deepEqual(await fsp.readFile(options.destination), previous);
    assert(!(await fsp.readdir(temp)).some(name => name.startsWith('local-clean-export-') || name.startsWith('.local-clean-export-')));
    const custom = Buffer.from('C:7:"Example":10:{site.local}');
    assert.throws(() => replaceValue(custom, plan), /Serializable/);
  });
  await check('a missing source domain reports zero replacements and preserves the exact SQL bytes', async () => {
    const filename = path.join(temp, 'no-domain.sql');
    const data = makeSql('https://unrelated.example.com');
    await fsp.writeFile(filename, data);
    const result = await replaceDomainInDump(filename, plan);
    assert.equal(result.replacements, 0);
    assert.deepEqual(await fsp.readFile(filename), data);
    const unchanged = replaceValue(serialize('http://site.local'), prepareDomainReplacement('site.local', 'site.local'));
    assert.equal(unchanged.replacements, 0);
  });
  await check('cancelling domain replacement preserves the original temporary dump and removes partial output', async () => {
    const filename = path.join(temp, 'cancel-domain.sql');
    await fsp.writeFile(filename, Buffer.concat(Array.from({ length: 10000 }, () => sql)));
    const original = await fsp.readFile(filename);
    const controller = new AbortController();
    const pending = replaceDomainInDump(filename, plan, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(await fsp.readFile(filename), original);
    assert(!fs.existsSync(`${filename}.replaced`));
  });
  await check('stored routines and comments are preserved during domain replacement', async () => {
    const filename = path.join(temp, 'routines.sql');
    const data = Buffer.concat([Buffer.from('-- site.local\nDELIMITER ;;\n'), sql, Buffer.from('DELIMITER ;\n'), sql]);
    await fsp.writeFile(filename, data);
    const result = await replaceDomainInDump(filename, plan);
    assert.equal(result.replacements, 2);
    assert((await fsp.readFile(filename)).subarray(0, data.length - sql.length).equals(data.subarray(0, data.length - sql.length)));
  });
  await check('the controller passes the optional target domain into the export and validates it before the dialog', async () => {
    const client = path.join(temp, 'domain-mysqldump');
    await fsp.writeFile(client, '#!/bin/sh\ncat "$MYSQL_HOME/source-database.sql"\n', { mode: 0o700 });
    const site = { id: 'test', name: 'Test', domain: 'site.local', longPath: options.siteRoot,
      paths: { webRoot: options.webRoot }, mysql: { database: 'local' } };
    const sender = { isDestroyed: () => false, send() {} };
    let dialogs = 0;
    const controller = createController({ archiver, micromatch, services: {
      siteData: { getSite: () => site }, siteProcessManager: { getSiteStatus: () => 'running' },
      userData: { get: () => ({ filter: '*.zip' }) },
      lightningServices: { getSiteServiceByRole: () => ({ bin: { mysqldump: client }, configPath: temp }) },
    }, electron: { BrowserWindow: { fromWebContents: () => null }, dialog: {
      showSaveDialog: async () => { dialogs += 1; return { canceled: false, filePath: options.destination }; },
    } } });
    assert.equal((await controller.info({}, 'test')).sourceDomain, 'site.local');
    await assert.rejects(controller.start({ sender }, 'test', { targetDomain: 'https://example.com/path' }));
    assert.equal(dialogs, 0);
    const result = await controller.start({ sender }, 'test', { targetDomain: 'https://example-production.com' });
    assert.equal(result.domainReplacement.replacements, 2);
    assert((await zipContents(options.destination)).data[result.sqlName].includes('https://example-production.com'));
    const plain = await controller.start({ sender }, 'test', { targetDomain: '' });
    assert.equal(plain.domainReplacement, undefined);
    assert.equal((await zipContents(options.destination)).data[plain.sqlName], sql.toString());
  });
};
