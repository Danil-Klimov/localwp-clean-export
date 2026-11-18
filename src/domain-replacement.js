'use strict';

const fs = require('node:fs');
const { isIP } = require('node:net');
const { pipeline } = require('node:stream/promises');
const { rewriteSerialized, looksSerialized } = require('./serialization');

function parseDomain(value) {
  const explicitProtocol = /^https?:\/\//i.test(value);
  let url;
  try { url = new URL(explicitProtocol ? value : `http://${value}`); }
  catch { throw new Error('Вкажіть коректний домен, наприклад example.com або https://example.com.'); }
  const hostname = url.hostname.replace(/\.$/, '');
  const validHost = isIP(hostname.replace(/^\[|\]$/g, '')) || (hostname.length <= 253
    && hostname.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(label)));
  if (!validHost || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || /[\s\\]/.test(value)
    || (!explicitProtocol && /[/?#@]/.test(value))) {
    throw new Error('Вкажіть лише домен або HTTP/HTTPS-адресу без шляху, параметрів і пароля.');
  }
  return { host: url.host, protocol: explicitProtocol ? url.protocol : null };
}

function prepareDomainReplacement(sourceDomain, targetDomain = '') {
  if (typeof targetDomain !== 'string') throw new Error('Новий домен має бути текстовим значенням.');
  if (!targetDomain.trim()) return null;
  if (typeof sourceDomain !== 'string' || !sourceDomain.trim()) throw new Error('Local не надав поточний домен сайту.');
  const source = parseDomain(sourceDomain.trim());
  const target = parseDomain(targetDomain.trim());
  const escapedHost = source.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the host with an optional URL protocol. Include JSON's escaped
  // slashes, and replace in one pass so a new subdomain cannot be replaced twice.
  const pattern = new RegExp(`(?:https?:(?://|\\\\/\\\\/))?${escapedHost}`, 'gi');
  return {
    sourceDomain: source.host,
    targetDomain: target.protocol ? `${target.protocol}//${target.host}` : target.host,
    hasMatch: bytes => { pattern.lastIndex = 0; return pattern.test(bytes.toString('latin1')); },
    replace: bytes => {
      let replacements = 0;
      const text = bytes.toString('latin1').replace(pattern, match => {
        let prefix = match.slice(0, -source.host.length);
        if (target.protocol && prefix) prefix = prefix.replace(/^https?:/i, target.protocol);
        const replacement = prefix + target.host;
        if (replacement !== match) replacements += 1;
        return replacement;
      });
      return { value: replacements ? Buffer.from(text, 'latin1') : bytes, replacements };
    },
  };
}

function replaceValue(value, plan, depth = 0) {
  if (depth > 256) throw new Error('Надто глибока структура серіалізованих даних. Експорт зупинено.');
  if (!plan.hasMatch(value)) return { value, replacements: 0 };
  let start = 0;
  let end = value.length;
  const whitespace = byte => [9, 10, 13, 32].includes(byte);
  while (start < end && whitespace(value[start])) start += 1;
  while (end > start && whitespace(value[end - 1])) end -= 1;
  const body = value.subarray(start, end);
  if (!looksSerialized(body)) return plan.replace(value);
  const changed = rewriteSerialized(body, (bytes, level) => replaceValue(bytes, plan, level), depth);
  return { value: changed.replacements ? Buffer.concat([value.subarray(0, start), changed.value, value.subarray(end)]) : value,
    replacements: changed.replacements };
}

// MySQL's single-quoted string literal format, as emitted by mysqldump.
function readSqlString(line, start) {
  const chunks = [];
  let segment = start + 1;
  let offset = segment;
  const escapes = { 48: 0, 98: 8, 110: 10, 114: 13, 116: 9, 90: 26 };
  while (offset < line.length) {
    if (line[offset] === 92) {
      chunks.push(line.subarray(segment, offset));
      offset += 1;
      if (offset >= line.length) break;
      const byte = line[offset];
      // MySQL retains the backslash in \% and \_ outside LIKE expressions.
      chunks.push(Buffer.from(byte === 37 || byte === 95 ? [92, byte] : [escapes[byte] ?? byte]));
      offset += 1;
      segment = offset;
    } else if (line[offset] === 39) {
      chunks.push(line.subarray(segment, offset));
      if (line[offset + 1] === 39) {
        chunks.push(Buffer.from("'"));
        offset += 2;
        segment = offset;
      } else return { value: Buffer.concat(chunks), end: offset + 1 };
    } else offset += 1;
  }
  throw new Error('Неповний SQL-рядок у дампі. Експорт зупинено.');
}

function quoteSqlString(value) {
  const chunks = [Buffer.from("'")];
  const escapes = { 0: '\\0', 8: '\\b', 9: '\\t', 10: '\\n', 13: '\\r', 26: '\\Z', 39: "\\'", 92: '\\\\' };
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (escapes[value[i]]) {
      chunks.push(value.subarray(start, i), Buffer.from(escapes[value[i]]));
      start = i + 1;
    }
  }
  chunks.push(value.subarray(start), Buffer.from("'"));
  return Buffer.concat(chunks);
}

function replaceSqlLine(line, plan) {
  if (!/^\s*(?:INSERT|REPLACE)\s/i.test(line.subarray(0, 40).toString('ascii'))) return { value: line, replacements: 0 };
  const chunks = [];
  let replacements = 0;
  let last = 0;
  for (let offset = 0; offset < line.length; offset += 1) {
    if (line[offset] === 96) {
      for (offset += 1; offset < line.length; offset += 1) {
        if (line[offset] !== 96) continue;
        if (line[offset + 1] === 96) offset += 1;
        else break;
      }
    } else if (line[offset] === 39) {
      const parsed = readSqlString(line, offset);
      const changed = replaceValue(parsed.value, plan);
      if (changed.replacements) {
        chunks.push(line.subarray(last, offset), quoteSqlString(changed.value));
        last = parsed.end;
        replacements += changed.replacements;
      }
      offset = parsed.end - 1;
    } else if (line[offset] === 48 && [88, 120].includes(line[offset + 1])) {
      let end = offset + 2;
      while (end < line.length && /[0-9a-f]/i.test(String.fromCharCode(line[end]))) end += 1;
      if (end > offset + 2 && (end - offset - 2) % 2 === 0) {
        const original = Buffer.from(line.subarray(offset + 2, end).toString('ascii'), 'hex');
        const changed = replaceValue(original, plan);
        if (changed.replacements) {
          chunks.push(line.subarray(last, offset), Buffer.from(`0x${changed.value.toString('hex').toUpperCase()}`));
          last = end;
          replacements += changed.replacements;
        }
        offset = end - 1;
      }
    }
  }
  if (!replacements) return { value: line, replacements: 0 };
  chunks.push(line.subarray(last));
  return { value: Buffer.concat(chunks), replacements };
}

async function replaceDomainInDump(filename, plan, signal) {
  if (!plan) return null;
  signal?.throwIfAborted();
  const outputPath = `${filename}.replaced`;
  let replacements = 0;
  let routine = false;
  const transform = line => {
    const delimiter = /^DELIMITER\s+(\S+)/i.exec(line.subarray(0, 60).toString('ascii'));
    if (delimiter) routine = delimiter[1] !== ';';
    if (routine) return line;
    const changed = replaceSqlLine(line, plan);
    replacements += changed.replacements;
    return changed.value;
  };
  try {
    await pipeline(fs.createReadStream(filename), async function* (source) {
      let pending = [];
      for await (const chunk of source) {
        signal?.throwIfAborted();
        let start = 0;
        let end;
        while ((end = chunk.indexOf(10, start)) >= 0) {
          const part = chunk.subarray(start, end + 1);
          yield transform(pending.length ? Buffer.concat([...pending, part]) : part);
          pending = [];
          start = end + 1;
          signal?.throwIfAborted();
        }
        if (start < chunk.length) pending.push(chunk.subarray(start));
      }
      if (pending.length) yield transform(Buffer.concat(pending));
    }, fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    await fs.promises.rename(outputPath, filename);
    return { sourceDomain: plan.sourceDomain, targetDomain: plan.targetDomain, replacements };
  } finally { await fs.promises.rm(outputPath, { force: true }); }
}

module.exports = { prepareDomainReplacement, replaceDomainInDump, replaceValue, replaceSqlLine, readSqlString, quoteSqlString };
