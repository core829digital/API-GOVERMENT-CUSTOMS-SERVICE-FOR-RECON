// L5 - Privacy docs freshness (Workflow.md 4.2; R-PRIV-4, R-PRIV-6, R-PRIV-7).
//
// 1. docs/privacy/{DPIA,ROPA,TIA,SUBPROCESSORS}.md exist and start with front matter containing exactly the keys
//    doc, status (draft|reviewed), reviewed_at, reviewer, next_review. Missing file / next_review < today = error;
//    status draft or reviewer UNREVIEWED = warning (error for release builds).
// 2. The machine-managed block of ROPA.md equals the rows L4 derived from the migrated schema (read from
//    <outDir>/classification.json, listed in <outDir>/L4.json). Absent => fails ("run L4 first"). If the plan skipped
//    L4 (schema untouched) the comparison is reported as not re-verified (never for release builds: they cannot skip).
// 3. Every annotation `recon.core829.eu/subprocessor: <name>` found in infra/**/*.{yaml,yml,tf,rego} and in .github/**
//    (markdown excluded: documentation) names a row of the SUBPROCESSORS.md table `| name | purpose | region | dpa_ref |`
//    whose region is an EU/EEA token: `eu`, `eea` or an EU member-state code/name (a first word followed by
//    -/space, e.g. `eu-central-1`, `de-frankfurt`; parenthesised text ignored; multi-valued cells need every
//    entry valid). EEA countries other than via the `eea` token are deliberately not accepted individually.
//
// Options: --skip-reason <text> (ignored for release builds).
// Evidence: privacy-docs.json (doc status table).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { YamlError, parseYaml } from '../lib/miniyaml.mjs';
import { error, info, result, statusFromFindings, warning, writeJson } from '../lib/result.mjs';
import { inputLabel, sha256Buffer, sha256File, skipOrNull } from '../lib/proc.mjs';
import { diffRopa, parseRopaBlock, ropaRowLine } from './l4.mjs';

export const id = 'L5';
export const name = 'Privacy docs freshness';

export const DOCS = Object.freeze(['DPIA', 'ROPA', 'TIA', 'SUBPROCESSORS']);
export const FRONT_MATTER_KEYS = Object.freeze(['doc', 'status', 'reviewed_at', 'reviewer', 'next_review']);
export const SUBPROCESSOR_KEY = 'recon.core829.eu/subprocessor';

const EU_CODES = 'at be bg hr cy cz dk ee fi fr de gr el hu ie it lv lt lu mt nl pl pt ro sk si es se'.split(' ');
const EU_NAMES = [
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'czech republic', 'denmark', 'estonia', 'finland',
  'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'malta',
  'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden',
];
const REGION_TOKENS = ['eu', 'eea', ...EU_CODES, ...EU_NAMES];

/** True when every entry of a `region` cell starts with an EU/EEA token (see header comment). */
export function isEuEeaRegion(cell) {
  const segments = cell
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;/]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => REGION_TOKENS.some((t) => seg === t || (seg.startsWith(t) && /[\s\-_]/.test(seg[t.length]))));
}

const validDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** @returns {{data?:object, problems:string[]}} */
export function parseFrontMatter(text) {
  const t = text.replace(/^\uFEFF/, '');
  const lines = t.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { problems: ['file does not start with a `---` front matter block'] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { problems: ['front matter block is not closed with `---`'] };
  let data;
  try {
    data = parseYaml(lines.slice(1, end).join('\n'));
  } catch (e) {
    return { problems: [`front matter is not parseable: ${e instanceof YamlError ? e.message : e}`] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { problems: ['front matter is not a mapping'] };
  const problems = [];
  for (const k of FRONT_MATTER_KEYS) if (!(k in data)) problems.push(`front matter key "${k}" is missing`);
  for (const k of Object.keys(data)) if (!FRONT_MATTER_KEYS.includes(k)) problems.push(`unexpected front matter key "${k}"`);
  return { data, problems };
}

/** Evaluate one document's front matter. */
export function evaluateDoc(docName, data, today, release) {
  const findings = [];
  const subject = `docs/privacy/${docName}.md`;
  if (!['draft', 'reviewed'].includes(data.status)) findings.push(error(`status must be "draft" or "reviewed" (found ${JSON.stringify(data.status)})`, subject));
  if (typeof data.reviewer !== 'string' || data.reviewer.trim() === '') findings.push(error('reviewer must be a name or UNREVIEWED', subject));
  if (typeof data.doc !== 'string' || data.doc.trim() === '') findings.push(error('doc must be a non-empty string', subject));
  const nr = data.next_review;
  if (!validDate(nr)) findings.push(error(`next_review must be YYYY-MM-DD (found ${JSON.stringify(nr)})`, subject));
  else if (nr < today) findings.push(error(`next_review ${nr} has passed (today ${today})`, subject));
  const ra = data.reviewed_at;
  if (data.status === 'reviewed') {
    if (!validDate(ra)) findings.push(error(`reviewed_at must be YYYY-MM-DD when status is reviewed (found ${JSON.stringify(ra)})`, subject));
    else if (ra > today) findings.push(error(`reviewed_at ${ra} is in the future`, subject));
  } else if (data.status === 'draft' && ra !== null && ra !== undefined && !validDate(ra)) {
    findings.push(error(`reviewed_at must be empty or YYYY-MM-DD (found ${JSON.stringify(ra)})`, subject));
  }
  const unreviewed = data.status === 'draft' || data.reviewer === 'UNREVIEWED';
  if (unreviewed) {
    const msg = `not human-reviewed (status ${data.status}, reviewer ${data.reviewer}); a draft for the DPO/counsel, not an approved record`;
    findings.push(release ? error(msg, subject) : warning(msg, subject));
  }
  return findings;
}

/** @returns {{header:boolean, rows:Array<{name:string,purpose:string,region:string,dpa_ref:string}>}} */
export function parseSubprocessors(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const want = ['name', 'purpose', 'region', 'dpa_ref'];
  const h = lines.findIndex((l) => l.startsWith('|') && cells(l).map((c) => c.toLowerCase()).join('|') === want.join('|'));
  if (h < 0) return { header: false, rows: [] };
  const rows = [];
  for (let i = h + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const c = cells(lines[i]);
    if (c.length === want.length) rows.push(Object.fromEntries(want.map((k, j) => [k, c[j]])));
  }
  return { header: true, rows };
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Text of the Helm values*.yaml files next to the nearest ancestor Chart.yaml below root, or null if not in a chart. */
function chartValues(root, file) {
  for (let d = dirname(file); d.startsWith(root) && d !== root; d = dirname(d)) {
    if (existsSync(join(d, 'Chart.yaml'))) {
      return readdirSync(d).filter((n) => /^values.*\.ya?ml$/.test(n)).map((n) => readFileSync(join(d, n), 'utf8'));
    }
  }
  return null;
}

/**
 * Scalar at a dotted key path of a block-style YAML text, by indentation. Tolerant of constructs the miniyaml subset
 * rejects elsewhere in the file (flow mappings etc.). Returns undefined when the path or a scalar is not found.
 */
export function yamlScalarAt(text, path) {
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^( *)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2] });
    if (stack.length === path.length && stack.every((e, i) => e.key === path[i])) {
      let v = (m[3] ?? '').trim();
      if (v === '' || v.startsWith('#')) return undefined;
      const q = v[0];
      if (q === '"' || q === "'") return v.slice(1, v.indexOf(q, 1) < 0 ? undefined : v.indexOf(q, 1));
      return v.replace(/\s+#.*$/, '').trim();
    }
  }
  return undefined;
}

/**
 * Scan IaC/CI files for subprocessor annotations. A Helm template value `{{ .Values.a.b [| quote] }}` is resolved
 * against the chart's values*.yaml files: non-empty defaults are annotations; an empty default is reported in
 * `templated` (value supplied at deploy time, which this static scan cannot see); any other template expression is
 * reported in `unresolved`.
 */
export function scanSubprocessors(root) {
  const found = [];
  const problems = [];
  const templated = [];
  const unresolved = [];
  let scanned = 0;
  const candidates = [
    ...[...walk(join(root, 'infra'))].filter((p) => /\.(ya?ml|tf|rego)$/i.test(p)),
    ...[...walk(join(root, '.github'))].filter((p) => !/\.md$/i.test(p)),
  ];
  for (const p of candidates) {
    if (statSync(p).size > 4 * 1024 * 1024) continue;
    const buf = readFileSync(p);
    if (buf.includes(0)) continue;
    scanned++;
    const rel = relative(root, p).split(sep).join('/');
    buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
      const k = line.indexOf(SUBPROCESSOR_KEY);
      if (k < 0 || /^\s*(#|\/\/)/.test(line)) return;
      const m = /^["']?\s*[:=]\s*(.*)$/.exec(line.slice(k + SUBPROCESSOR_KEY.length));
      if (!m) return; // a reference (e.g. a policy reading the key), not an annotation
      let v = m[1].trim();
      const q = v[0];
      if (q === '"' || q === "'") {
        const e = v.indexOf(q, 1);
        v = e < 0 ? v.slice(1) : v.slice(1, e);
      } else {
        v = v.replace(/\s+#.*$/, '').replace(/,$/, '').trim();
      }
      const at = { file: rel, line: i + 1 };
      const tpl = /^\{\{-?\s*\.Values((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*(?:\|\s*s?quote\s*)?-?\}\}$/.exec(v);
      if (v.includes('{{')) {
        const values = tpl ? chartValues(root, p) : null;
        if (!tpl || values === null) {
          unresolved.push({ ...at, expr: v });
          return;
        }
        const names = values.map((t) => yamlScalarAt(t, tpl[1].slice(1).split('.'))).filter((x) => typeof x === 'string' && x.trim() !== '');
        if (names.length === 0) templated.push({ ...at, expr: v });
        for (const name of new Set(names)) found.push({ name, ...at });
      } else if (v === '') problems.push(at);
      else found.push({ name: v, ...at });
    });
  }
  return { found, problems, templated, unresolved, scanned };
}

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const list = (xs, n = 8) => xs.slice(0, n).join(', ') + (xs.length > n ? `, ... (+${xs.length - n})` : '');

export async function run(ctx) {
  const skipped = skipOrNull(ctx, id);
  if (skipped) return skipped;
  const findings = [];
  const inputs = {};
  const today = ctx.now.toISOString().slice(0, 10);
  const table = [];
  const texts = {};

  // ---- 1. front matter
  for (const d of DOCS) {
    const rel = `docs/privacy/${d}.md`;
    const abs = join(ctx.root, rel);
    if (!existsSync(abs)) {
      findings.push(error('required privacy document is missing', rel));
      table.push({ doc: d, path: rel, present: false });
      continue;
    }
    const buf = readFileSync(abs);
    texts[d] = buf.toString('utf8');
    inputs[rel] = sha256Buffer(buf);
    const fm = parseFrontMatter(texts[d]);
    if (fm.problems.length) {
      for (const p of fm.problems) findings.push(error(p, rel));
    }
    if (fm.data) {
      findings.push(...evaluateDoc(d, fm.data, today, ctx.release));
      table.push({ doc: d, path: rel, present: true, status: fm.data.status, reviewer: fm.data.reviewer, reviewed_at: fm.data.reviewed_at ?? null, next_review: fm.data.next_review });
    } else {
      table.push({ doc: d, path: rel, present: true, status: null });
    }
  }

  // ---- 2. ROPA vs L4
  let ropa = { checked: false };
  const l4Path = join(ctx.outDir, 'L4.json');
  if (!existsSync(l4Path)) {
    findings.push(error('ROPA cannot be compared with the schema: L4 result not found in the output directory - run L4 first', 'docs/privacy/ROPA.md'));
  } else {
    let l4;
    try {
      l4 = JSON.parse(readFileSync(l4Path, 'utf8'));
    } catch (e) {
      l4 = null;
      findings.push(error(`L4.json is unreadable: ${e.message}`, 'L4.json'));
    }
    if (l4) {
      inputs['L4.json'] = sha256File(l4Path);
      const clsPath = join(ctx.outDir, 'classification.json');
      if (l4.status === 'skip') {
        ropa = { checked: false, reason: 'L4 skipped by the path filter (no schema change)' };
        findings.push(info(`ROPA/schema consistency not re-verified: L4 was skipped (${l4.skip_reason})`, 'docs/privacy/ROPA.md'));
      } else if (!(l4.evidence ?? []).includes('classification.json') || !existsSync(clsPath)) {
        findings.push(error('L4 produced no classification.json - run L4 first', 'docs/privacy/ROPA.md'));
      } else {
        const cls = JSON.parse(readFileSync(clsPath, 'utf8'));
        inputs['classification.json'] = sha256File(clsPath);
        if (!cls.columns_inspected) {
          findings.push(error('L4 inspected no columns (it failed before reading the schema); ROPA cannot be compared', 'docs/privacy/ROPA.md'));
        } else if (texts.ROPA !== undefined) {
          const p = parseRopaBlock(texts.ROPA);
          if (!p.found) findings.push(error(`ROPA.md has no machine-managed block: ${p.problems.join('; ')}`, 'docs/privacy/ROPA.md'));
          else {
            for (const l of p.invalid) findings.push(error(`invalid ROPA block line: ${l}`, 'docs/privacy/ROPA.md'));
            const d = diffRopa(p.rows, cls.rows);
            const subject = 'docs/privacy/ROPA.md';
            if (d.added.length) findings.push(error(`ROPA lacks ${d.added.length} column(s) present in the schema: ${list(d.added.map((r) => r.column))}`, subject));
            if (d.removed.length) findings.push(error(`ROPA lists ${d.removed.length} column(s) not in the schema: ${list(d.removed.map((r) => r.column))}`, subject));
            if (d.changed.length) findings.push(error(`ROPA differs from the schema classification for ${d.changed.length} column(s): ${list(d.changed.map((c) => c.column))}`, subject));
            if (!d.added.length && !d.removed.length && !d.changed.length && p.invalid.length === 0 && p.rows.map(ropaRowLine).join('\n') !== cls.rows.map(ropaRowLine).join('\n')) {
              findings.push(error('ROPA rows are not sorted by column', subject));
            }
            ropa = { checked: true, rows: p.rows.length, derived_rows: cls.rows.length, added: d.added.length, removed: d.removed.length, changed: d.changed.length };
          }
        }
      }
    }
  }

  // ---- 3. sub-processors
  const scan = scanSubprocessors(ctx.root);
  for (const p of scan.problems) findings.push(error(`empty ${SUBPROCESSOR_KEY} annotation at line ${p.line}`, p.file));
  for (const t of scan.templated) findings.push(info(`${SUBPROCESSOR_KEY} at line ${t.line} is value-driven (${t.expr}) and empty in the chart's default values: a deployment that sets it must list the processor in SUBPROCESSORS.md; not verifiable statically`, t.file));
  for (const u of scan.unresolved) findings.push(warning(`${SUBPROCESSOR_KEY} at line ${u.line} uses a template expression that cannot be resolved statically (${u.expr}); use a literal value or a plain .Values path`, u.file));
  let listed = [];
  if (texts.SUBPROCESSORS !== undefined) {
    const sp = parseSubprocessors(texts.SUBPROCESSORS);
    listed = sp.rows;
    if (!sp.header) findings.push(error('SUBPROCESSORS.md has no table with the header `| name | purpose | region | dpa_ref |`', 'docs/privacy/SUBPROCESSORS.md'));
  }
  const byName = new Map(listed.map((r) => [norm(r.name), r]));
  const names = [...new Set(scan.found.map((f) => f.name))].sort();
  for (const n of names) {
    const where = scan.found.filter((f) => f.name === n).map((f) => `${f.file}:${f.line}`);
    const row = byName.get(norm(n));
    if (!row) findings.push(error(`sub-processor "${n}" (annotation at ${list(where, 3)}) is not listed in docs/privacy/SUBPROCESSORS.md`, n));
    else if (!isEuEeaRegion(row.region)) findings.push(error(`sub-processor "${n}" has region "${row.region}", which is not an EU/EEA region token (R-PRIV-4)`, n));
  }
  for (const f of new Set(scan.found.map((x) => x.file))) inputs[f] = sha256File(join(ctx.root, f));

  const evidence = [writeJson(ctx.outDir, 'privacy-docs.json', { today, docs: table, ropa, subprocessors: { listed: listed.length, annotations: scan.found, value_driven_empty: scan.templated, unresolved: scan.unresolved, files_scanned: scan.scanned } })];
  const status = statusFromFindings(findings);
  return result(id, status, {
    summary: `${table.filter((t) => t.present).length}/${DOCS.length} documents present, ${names.length} sub-processor annotation(s)`,
    findings,
    evidence,
    metrics: { documents_present: table.filter((t) => t.present).length, annotations: scan.found.length, files_scanned: scan.scanned, ropa_checked: ropa.checked },
    inputs,
  });
}
