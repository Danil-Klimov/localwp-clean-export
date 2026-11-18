'use strict';

// Parse PHP's byte-oriented serialization without instantiating PHP objects or
// changing reference IDs. Only string payloads and their byte lengths change.
function rewriteSerialized(input, replaceString, depth = 0) {
  let offset = 0;
  let replacements = 0;
  const invalid = () => { throw new Error('Неможливо безпечно змінити серіалізовані дані WordPress. Експорт зупинено.'); };
  const expect = text => {
    const bytes = Buffer.from(text);
    if (!input.subarray(offset, offset + bytes.length).equals(bytes)) invalid();
    offset += bytes.length;
  };
  const number = delimiter => {
    const end = input.indexOf(delimiter, offset, 'ascii');
    if (end < 0 || end === offset) invalid();
    const text = input.subarray(offset, end).toString('ascii');
    if (!/^\d+$/.test(text)) invalid();
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value > input.length) invalid();
    offset = end + 1;
    return value;
  };
  const sizedName = () => {
    const length = number(':');
    expect('"');
    const name = input.subarray(offset, offset + length);
    if (name.length !== length) invalid();
    offset += length;
    expect('"');
  };
  const parse = level => {
    if (depth + level > 256 || offset >= input.length) invalid();
    const start = offset;
    const type = String.fromCharCode(input[offset++]);
    if (type === 'N') {
      expect(';');
      return input.subarray(start, offset);
    }
    expect(':');
    if ('bidrR'.includes(type)) {
      const end = input.indexOf(59, offset);
      if (end < 0) invalid();
      const value = input.subarray(offset, end).toString('ascii');
      const valid = type === 'b' ? /^[01]$/.test(value)
        : type === 'd' ? /^(?:-?(?:\d+(?:\.\d*)?(?:E[+-]?\d+)?|INF)|NAN)$/i.test(value)
          : /^-?\d+$/.test(value);
      if (!valid) invalid();
      offset = end + 1;
      return input.subarray(start, offset);
    }
    if (type === 's' || type === 'E') {
      const length = number(':');
      expect('"');
      const body = input.subarray(offset, offset + length);
      if (body.length !== length) invalid();
      offset += length;
      expect('";');
      if (type === 'E') return input.subarray(start, offset);
      const changed = replaceString(body, depth + level + 1);
      replacements += changed.replacements;
      return changed.replacements ? Buffer.concat([
        Buffer.from(`s:${changed.value.length}:"`), changed.value, Buffer.from('";'),
      ]) : input.subarray(start, offset);
    }
    if (type === 'a' || type === 'O') {
      if (type === 'O') { sizedName(); expect(':'); }
      const count = number(':');
      expect('{');
      const parts = [input.subarray(start, offset)];
      for (let i = 0; i < count * 2; i += 1) parts.push(parse(level + 1));
      expect('}');
      parts.push(Buffer.from('}'));
      return Buffer.concat(parts);
    }
    if (type === 'C') {
      sizedName();
      expect(':');
      const length = number(':');
      expect('{');
      const header = input.subarray(start, offset);
      const body = input.subarray(offset, offset + length);
      if (body.length !== length) invalid();
      offset += length;
      expect('}');
      const changed = replaceString(body, depth + level + 1);
      if (!changed.replacements) return input.subarray(start, offset);
      // Custom Serializable payloads have arbitrary formats. Only rewrite
      // payloads that are themselves standard PHP serialization.
      if (!looksSerialized(body)) {
        throw new Error('Домен знайдено у нестандартному Serializable-об’єкті. Його неможливо безпечно змінити; експорт зупинено.');
      }
      replacements += changed.replacements;
      return Buffer.concat([
        Buffer.from(header.toString('latin1').replace(/:\d+:\{$/, `:${changed.value.length}:{`), 'latin1'),
        changed.value, Buffer.from('}'),
      ]);
    }
    invalid();
  };
  const value = parse(0);
  if (offset !== input.length) invalid();
  return { value, replacements };
}

function looksSerialized(value) {
  return /^(?:N;|[abdisOCRrE]:)/.test(value.subarray(0, 3).toString('ascii'));
}

module.exports = { rewriteSerialized, looksSerialized };
