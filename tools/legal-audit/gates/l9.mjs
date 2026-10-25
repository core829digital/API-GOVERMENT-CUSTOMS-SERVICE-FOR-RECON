// L9 - E-invoice conformance fixtures (Workflow.md 4.2).
//
// Only rule packs with `enabled: true` are inspected (every pack starts disabled; enabling needs human sign-off, L8/L11).
// An enabled pack must declare
//   fixtures:         list of paths relative to the repository root (string, or mapping {path, schema})
//   schema_versions:  list of mappings { id?, root_ns, root_element?, valid_from?, valid_to? }
// and the gate checks, per fixture, that it exists inside the repository, is well-formed XML (DOCTYPE is rejected: no
// entity expansion), and that its root element matches a schema version (`root_ns` = namespace URI of the root,
// `root_element` = local name when given; a fixture mapping with `schema: <id>` is bound to that version). Per enabled
// jurisdiction at least one fixture must exist, and every schema version that is current on ctx.now (valid_from <= now
// <= valid_to, open ends allowed) needs at least one fixture that matches it.
//
// OUT OF SCOPE until a country is enabled: EN 16931 / CIUS XSD validation and Schematron rule execution. They need the
// official validation artefacts of that country (versions read from the pack), which this repository does not ship yet.
// Today the gate therefore proves well-formedness and the root/namespace identity only, and says so in an info finding.
//
// Waiver subjects: fixture-level `<fixture path>`, pack-level `<pack>` (waivers allowed for L9).
// Options: --skip-reason <text>
// Evidence: einvoice-validation-report.json
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyWaivers, hashInputs, isoDay, loadWaivers, nonEmpty, parseIsoDate, skipRequested, today } from '../lib/common.mjs';
import { error, info, result, statusFromFindings, writeJson } from '../lib/result.mjs';
import { parseYaml, YamlError } from '../lib/miniyaml.mjs';
import { discoverPacks } from './l8.mjs';

export const id = 'L9';
export const name = 'E-invoice conformance fixtures';

// ---------------------------------------------------------------------------------------------------------------
// Minimal well-formedness checker (XML 1.0, no DTD) that also resolves the root element's namespace.
// ---------------------------------------------------------------------------------------------------------------

export class XmlError extends Error {
  constructor(message, offset, text) {
    const upto = text.slice(0, offset);
    const line = upto.split('\n').length;
    const col = offset - upto.lastIndexOf('\n');
    super(`${message} (line ${line}, column ${col})`);
  }
}

const NAME_START = /[A-Za-z_:\u00C0-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/u;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00B7\u00C0-\u02FF\u0300-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/u;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * @param {Buffer|string} input
 * @returns {{local:string, prefix:string|null, ns:string|null, elements:number}} the root element
 * @throws {XmlError}
 */
export function parseXmlRoot(input) {
  let text;
  if (typeof input === 'string') text = input;
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      throw new XmlError('document is not valid UTF-8', 0, '');
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let i = 0;
  const fail = (m, at = i) => {
    throw new XmlError(m, at, text);
  };
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = () => {
    while (i < text.length && isWs(text[i])) i++;
  };
  const readName = () => {
    const start = i;
    if (!NAME_START.test(text[i] ?? '')) fail('name expected');
    i++;
    while (i < text.length && NAME_CHAR.test(text[i])) i++;
    return text.slice(start, i);
  };
  const checkChars = (s, base) => {
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) fail(`illegal control character U+${c.toString(16).padStart(4, '0')}`, base + k);
      if (c === 0xfffe || c === 0xffff) fail('illegal character U+FFFE/U+FFFF', base + k);
    }
  };
  const checkRefs = (s, base) => {
    const re = /&([^;\s&<]*)(;?)/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const ref = m[1];
      if (m[2] !== ';' || !/^(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+)$/.test(ref)) fail(`undefined or malformed entity reference "&${ref}${m[2]}" (only the five predefined entities and character references are allowed)`, base + m.index);
      if (ref.startsWith('#')) {
        const cp = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
        if (!(cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) fail(`character reference &${ref}; is not a legal XML character`, base + m.index);
      }
    }
    if (/&(?![^;\s&<]*;)/.test(s)) fail('bare "&" in character data', base);
  };
  const skipComment = () => {
    const end = text.indexOf('-->', i + 4);
    if (end < 0) fail('unterminated comment');
    const body = text.slice(i + 4, end);
    if (body.includes('--') || body.endsWith('-')) fail('"--" is not allowed inside a comment');
    checkChars(body, i);
    i = end + 3;
  };
  const skipPI = () => {
    const end = text.indexOf('?>', i + 2);
    if (end < 0) fail('unterminated processing instruction');
    const target = /^[^\s?]+/.exec(text.slice(i + 2, end))?.[0] ?? '';
    if (!target) fail('processing instruction without target');
    if (/^xml$/i.test(target)) fail('XML declaration is only allowed at the very start of the document');
    i = end + 2;
  };

  // XML declaration
  if (text.startsWith('<?xml') && /\s|\?/.test(text[5] ?? '')) {
    const end = text.indexOf('?>');
    if (end < 0) fail('unterminated XML declaration', 0);
    const decl = text.slice(0, end);
    if (!/^<\?xml\s+version\s*=\s*(["'])1\.[0-9]+\1/.test(decl)) fail('XML declaration must start with version="1.x"', 0);
    const enc = /encoding\s*=\s*(["'])([^"']+)\1/.exec(decl);
    if (enc && !/^utf-?8$/i.test(enc[2])) fail(`unsupported encoding "${enc[2]}" (fixtures must be UTF-8)`, 0);
    i = end + 2;
  }

  // prolog
  for (;;) {
    skipWs();
    if (text.startsWith('<!--', i)) skipComment();
    else if (text.startsWith('<?', i)) skipPI();
    else if (text.startsWith('<!DOCTYPE', i)) fail('DOCTYPE declarations are not allowed (no DTD / entity expansion in invoice fixtures)');
    else break;
  }
  if (text[i] !== '<') fail(i >= text.length ? 'document has no root element' : 'root element expected');

  const stack = []; // {name, scope}
  let root = null;
  let elements = 0;
  let scope = new Map([['xml', XML_NS]]);

  const resolveName = (qname, isAttr, at) => {
    const colon = qname.indexOf(':');
    if (colon < 0) return { prefix: null, local: qname, ns: isAttr ? null : (scope.get('') ?? null) };
    const prefix = qname.slice(0, colon);
    const local = qname.slice(colon + 1);
    if (!local || local.includes(':')) fail(`malformed qualified name "${qname}"`, at);
    if (!scope.has(prefix)) fail(`namespace prefix "${prefix}" is not bound`, at);
    return { prefix, local, ns: scope.get(prefix) };
  };

  for (;;) {
    if (text.startsWith('<!--', i)) {
      skipComment();
    } else if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) fail('CDATA outside the root element');
      const end = text.indexOf(']]>', i);
      if (end < 0) fail('unterminated CDATA section');
      checkChars(text.slice(i + 9, end), i + 9);
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      skipPI();
    } else if (text.startsWith('</', i)) {
      const at = i;
      i += 2;
      const qname = readName();
      skipWs();
      if (text[i] !== '>') fail('">" expected in end tag');
      i++;
      const top = stack.pop();
      if (!top) fail(`unexpected end tag </${qname}>`, at);
      if (top.name !== qname) fail(`end tag </${qname}> does not match start tag <${top.name}>`, at);
      scope = top.outer;
      if (stack.length === 0) break;
    } else if (text[i] === '<') {
      const at = i;
      if (stack.length === 0 && root) fail('content after the root element', at);
      i++;
      const qname = readName();
      const attrs = [];
      for (;;) {
        const hadWs = i < text.length && isWs(text[i]);
        skipWs();
        if (text[i] === '>' || text.startsWith('/>', i)) break;
        if (!hadWs) fail('whitespace expected between attributes');
        const aAt = i;
        const an = readName();
        skipWs();
        if (text[i] !== '=') fail(`"=" expected after attribute ${an}`);
        i++;
        skipWs();
        const q = text[i];
        if (q !== '"' && q !== "'") fail(`quoted value expected for attribute ${an}`);
        const end = text.indexOf(q, i + 1);
        if (end < 0) fail(`unterminated value of attribute ${an}`);
        const val = text.slice(i + 1, end);
        if (val.includes('<')) fail(`"<" is not allowed in the value of attribute ${an}`, i);
        checkChars(val, i + 1);
        checkRefs(val, i + 1);
        if (attrs.some((a) => a.name === an)) fail(`duplicate attribute ${an}`, aAt);
        attrs.push({ name: an, value: val, at: aAt });
        i = end + 1;
      }
      const outer = scope;
      scope = new Map(scope);
      for (const a of attrs) {
        if (a.name === 'xmlns') scope.set('', a.value);
        else if (a.name.startsWith('xmlns:')) {
          const pfx = a.name.slice(6);
          if (a.value === '') fail(`namespace prefix "${pfx}" cannot be undeclared`, a.at);
          scope.set(pfx, a.value);
        }
      }
      const el = resolveName(qname, false, at);
      const seenAttr = new Set();
      for (const a of attrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const r = resolveName(a.name, true, a.at);
        const key = `${r.ns ?? ''}|${r.local}`;
        if (seenAttr.has(key)) fail(`duplicate attribute ${a.name} (same expanded name)`, a.at);
        seenAttr.add(key);
      }
      elements++;
      if (!root) root = { local: el.local, prefix: el.prefix, ns: el.ns };
      if (text.startsWith('/>', i)) {
        i += 2;
        scope = outer;
        if (stack.length === 0) break;
      } else {
        i++;
        stack.push({ name: qname, outer });
      }
    } else {
      if (stack.length === 0) fail('text outside the root element');
      const end = text.indexOf('<', i);
      if (end < 0) fail(`unclosed element <${stack[stack.length - 1].name}>`);
      const chunk = text.slice(i, end);
      if (chunk.includes(']]>')) fail('"]]>" is not allowed in character data', i + chunk.indexOf(']]>'));
      checkChars(chunk, i);
      checkRefs(chunk, i);
      i = end;
    }
    if (i >= text.length) fail(`unclosed element <${stack[stack.length - 1]?.name ?? root?.local}>`);
  }

  // epilog
  for (;;) {
    skipWs();
    if (i >= text.length) break;
    if (text.startsWith('<!--', i)) skipComment();
    else if (text.startsWith('<?', i)) skipPI();
    else fail('content after the root element');
  }
  return { ...root, elements };
}

// ---------------------------------------------------------------------------------------------------------------

function isCurrent(sv, day) {
  const from = sv.valid_from ? parseIsoDate(sv.valid_from) : null;
  const to = sv.valid_to ? parseIsoDate(sv.valid_to) : null;
  if (from && from > day) return false;
  if (to && to < day) return false;
  return true;
}

export async function run(ctx) {
  const skipped = skipRequested(id, name, ctx);
  if (skipped) return skipped;

  const day = today(ctx.now);
  const findings = [];
  const { packs, notes } = discoverPacks(ctx.root);
  findings.push(...notes.filter(() => false)); // stray-file notes belong to L8
  const report = { generated_at: ctx.now.toISOString(), as_of: isoDay(day), enabled_packs: [], fixtures: [] };
  const consumed = [];
  const coverage = new Map(); // jurisdiction -> valid fixture count
  const rootReal = resolve(ctx.root);

  for (const p of packs) {
    let doc;
    try {
      doc = parseYaml(readFileSync(join(ctx.root, p.rel), 'utf8'));
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      findings.push(error(`${p.rel}: cannot be parsed, so it is unknown whether the pack is enabled: ${e.message}`, p.base));
      continue;
    }
    if (!doc || typeof doc !== 'object' || doc.enabled !== true) continue;
    consumed.push(p.rel);
    const err = (msg, subject = p.base) => findings.push(error(`${p.rel}: ${msg}`, subject));
    const jur = typeof doc.jurisdiction === 'string' ? doc.jurisdiction : p.jurisdiction;
    if (!coverage.has(jur)) coverage.set(jur, 0);

    const versions = Array.isArray(doc.schema_versions) ? doc.schema_versions : [];
    if (versions.length === 0 || versions.some((v) => !v || typeof v !== 'object' || !nonEmpty(v.root_ns))) {
      err('enabled pack must list "schema_versions" (each with a root_ns)');
    }
    const svs = versions.filter((v) => v && typeof v === 'object' && nonEmpty(v.root_ns)).map((v, idx) => ({ ...v, key: nonEmpty(v.id) ? v.id : `#${idx + 1}`, matched: 0 }));
    const fixtureList = Array.isArray(doc.fixtures) ? doc.fixtures : [];
    if (fixtureList.length === 0) err(`enabled pack for ${jur} lists no "fixtures": adding a country requires fixtures first`);

    for (const entry of fixtureList) {
      const path = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.path : null;
      const bound = entry && typeof entry === 'object' ? entry.schema : null;
      if (!nonEmpty(path)) {
        err(`fixture entry ${JSON.stringify(entry)} has no path`);
        continue;
      }
      const abs = resolve(rootReal, path);
      const rel = relative(rootReal, abs).replaceAll(sep, '/');
      const rec = { pack: p.base, jurisdiction: jur, path: rel, status: 'invalid' };
      report.fixtures.push(rec);
      if (isAbsolute(path) || rel.startsWith('..') || abs === rootReal) {
        err(`fixture ${path} must be a relative path inside the repository`, path);
        rec.reason = 'outside repository';
        continue;
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        err(`fixture ${rel} does not exist`, rel);
        rec.reason = 'missing';
        continue;
      }
      consumed.push(rel);
      let root;
      try {
        root = parseXmlRoot(readFileSync(abs));
      } catch (e) {
        if (!(e instanceof XmlError)) throw e;
        err(`fixture ${rel} is not well-formed XML: ${e.message}`, rel);
        rec.reason = e.message;
        continue;
      }
      rec.root = { local: root.local, ns: root.ns };
      const candidates = bound ? svs.filter((s) => s.key === bound) : svs;
      if (bound && candidates.length === 0) {
        err(`fixture ${rel} is bound to unknown schema version "${bound}"`, rel);
        rec.reason = 'unknown schema binding';
        continue;
      }
      const hit = candidates.find((s) => s.root_ns === root.ns && (!nonEmpty(s.root_element) || s.root_element === root.local));
      if (!hit) {
        err(`fixture ${rel} has root {${root.ns ?? 'no namespace'}}${root.local}, which matches none of the pack's schema versions (${svs.map((s) => `${s.key}: {${s.root_ns}}${s.root_element ?? '*'}`).join('; ') || 'none'})`, rel);
        rec.reason = 'root does not match a schema version';
        continue;
      }
      hit.matched++;
      rec.status = 'ok';
      rec.schema_version = hit.key;
      coverage.set(jur, coverage.get(jur) + 1);
    }

    for (const s of svs) {
      if (isCurrent(s, day) && s.matched === 0) {
        err(`current schema version ${s.key} ({${s.root_ns}}) has no valid fixture`);
      }
    }
    report.enabled_packs.push({ pack: p.base, file: p.rel, jurisdiction: jur, schema_versions: svs.map((s) => ({ id: s.key, root_ns: s.root_ns, current: isCurrent(s, day), fixtures: s.matched })) });
  }

  for (const [jur, n] of coverage) {
    if (n === 0) findings.push(error(`enabled jurisdiction ${jur} has no valid e-invoice fixture`, jur));
  }
  if (report.enabled_packs.length === 0 && !findings.some((f) => f.severity === 'error')) {
    findings.push(info('no enabled countries: nothing to validate (all rule packs are disabled)'));
  } else {
    findings.push(info('EN 16931 / CIUS schema and Schematron execution is not performed by this gate (out of scope until a country is enabled); fixtures were checked for well-formedness and root/namespace identity only'));
  }

  const evidence = [writeJson(ctx.outDir, 'einvoice-validation-report.json', report)];
  const wv = loadWaivers(ctx.root, id, ctx.now);
  const applied = applyWaivers(findings, wv.waivers);
  const all = [...applied.findings, ...wv.findings];
  const okCount = report.fixtures.filter((f) => f.status === 'ok').length;
  return result(id, statusFromFindings(all), {
    summary: `${report.enabled_packs.length} enabled pack(s), ${okCount}/${report.fixtures.length} fixture(s) valid`,
    findings: all,
    evidence,
    metrics: { enabled_packs: report.enabled_packs.length, fixtures: report.fixtures.length, fixtures_valid: okCount },
    inputs: hashInputs(ctx.root, [...new Set([...consumed, 'docs/waivers.yml'])]),
    tools: {},
    waived: applied.waived,
  });
}
