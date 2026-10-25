// Small YAML subset parser (no dependencies). Supports exactly what docs/waivers.yml, CODEOWNERS-adjacent config and the
// privacy front matter need:
//   * block mappings and block sequences (indentation with spaces; tabs rejected)
//   * sequences of mappings (`- key: v` followed by more keys at deeper indent)
//   * scalars: plain, 'single', "double" (basic escapes), integers, true/false, null/~
//   * flow `[]`, `{}` and flow sequences of scalars `[a, b]`
//   * `#` comments (full line and trailing, outside quotes)
// Unsupported YAML (anchors, tags, multi-line scalars `|`/`>`, multi-document) throws instead of misparsing.
// Dates stay strings (`2026-10-23`); callers validate them.

export class YamlError extends Error {}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      // a quote only opens a string at the start of a token
      if (i === 0 || /[\s:\-[{,]/.test(line[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function scalar(raw, ln) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(`line ${ln}: unterminated double-quoted string`);
    return JSON.parse(s.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1'));
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`line ${ln}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError(`line ${ln}: unterminated flow sequence`);
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : splitFlow(inner, ln).map((x) => scalar(x, ln));
  }
  if (/^[&*!|>{]/.test(s)) throw new YamlError(`line ${ln}: unsupported YAML construct "${s[0]}"`);
  return s;
}

function splitFlow(s, ln) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else if (c === '[' || c === '{') {
      throw new YamlError(`line ${ln}: nested flow collections are not supported`);
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function splitKey(text, ln) {
  // key: value  (key may be quoted); returns [key, rest] or null when `text` is not a mapping entry
  let key;
  let rest;
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0];
    let i = 1;
    for (; i < text.length; i++) {
      if (text[i] === '\\' && q === '"') i++;
      else if (text[i] === q) break;
    }
    if (text[i + 1] !== ':') return null;
    key = scalar(text.slice(0, i + 1), ln);
    rest = text.slice(i + 2);
  } else {
    const m = /^([^\s:#][^:#]*?|[^\s:#]):(?:\s+(.*))?$/.exec(text);
    if (!m) return null;
    key = m[1].trim();
    rest = m[2] ?? '';
  }
  return [String(key), rest];
}

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const ln = idx + 1;
    if (/^\t/.test(raw.match(/^\s*/)[0])) throw new YamlError(`line ${ln}: tabs are not allowed for indentation`);
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') return;
    if (line === '---' || line === '...') throw new YamlError(`line ${ln}: multi-document YAML is not supported`);
    lines.push({ ln, indent: line.length - line.trimStart().length, text: line.trim() });
  });
  if (lines.length === 0) return null;
  let pos = 0;

  function parseBlock(indent) {
    const first = lines[pos];
    if (first.text.startsWith('- ') || first.text === '-') return parseSeq(first.indent);
    return parseMap(first.indent, null);
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const cur = lines[pos];
      const rest = cur.text === '-' ? '' : cur.text.slice(2).trim();
      if (rest === '') {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) arr.push(parseBlock(lines[pos].indent));
        else arr.push(null);
      } else if (splitKey(rest, cur.ln) && !/^["'].*["']$/.test(rest)) {
        // inline first key of a mapping: treat `- k: v` as a mapping whose indent is indent+2 (position of `k`)
        const childIndent = indent + (cur.text.length - rest.length);
        lines[pos] = { ln: cur.ln, indent: childIndent, text: rest };
        arr.push(parseMap(childIndent, null));
      } else {
        pos++;
        arr.push(scalar(rest, cur.ln));
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(`line ${lines[pos].ln}: unexpected indentation`);
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const cur = lines[pos];
      if (cur.text.startsWith('- ')) break;
      const kv = splitKey(cur.text, cur.ln);
      if (!kv) throw new YamlError(`line ${cur.ln}: expected "key: value", got "${cur.text}"`);
      const [key, rest] = kv;
      if (Object.hasOwn(obj, key)) throw new YamlError(`line ${cur.ln}: duplicate key "${key}"`);
      pos++;
      if (rest.trim() === '') {
        if (pos < lines.length && (lines[pos].indent > indent || (lines[pos].indent === indent && lines[pos].text.startsWith('- ')))) {
          obj[key] = parseBlock(lines[pos].indent);
        } else obj[key] = null;
      } else {
        if (/^[|>]/.test(rest.trim())) throw new YamlError(`line ${cur.ln}: block scalars are not supported`);
        obj[key] = scalar(rest, cur.ln);
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(`line ${lines[pos].ln}: unexpected indentation`);
    return obj;
  }

  const value = parseBlock(lines[0].indent);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].ln}: unexpected content`);
  return value;
}
