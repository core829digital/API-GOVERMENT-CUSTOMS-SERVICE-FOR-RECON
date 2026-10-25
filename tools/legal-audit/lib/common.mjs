// Helpers shared by the S1 gates (L1, L2, L3, L8, L9, L10): option handling, date maths, input hashing, waivers.
// Waiver file format: Workflow.md section 4.2 / phase-1 contract section 3.1 (docs/waivers.yml).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error, info, result, warning } from './result.mjs';
import { parseYaml, YamlError } from './miniyaml.mjs';

export const WAIVABLE_GATES = Object.freeze(['L1', 'L2', 'L3', 'L8', 'L9']);
const ALL_GATES = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
const MAX_WAIVER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** sha256 of a file, or null when it does not exist. */
export function sha256File(path) {
  return existsSync(path) ? sha256Hex(readFileSync(path)) : null;
}

/** `{label: sha256}` for the existing files among `relPaths` (labels are the relative paths). */
export function hashInputs(root, relPaths) {
  const out = {};
  for (const rel of relPaths) {
    const h = sha256File(join(root, rel));
    if (h) out[rel] = h;
  }
  return out;
}

/**
 * Strict calendar date `YYYY-MM-DD` -> Date at 00:00 UTC, or null when malformed / not a real date.
 * (miniyaml leaves dates as strings; every caller validates them with this.)
 */
export function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

/** The UTC calendar day of `ctx.now` as a Date at 00:00 UTC. */
export function today(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export const daysBetween = (from, to) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);
export const isoDay = (d) => d.toISOString().slice(0, 10);

/** True when value is a non-empty string (after trim). */
export const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Path-filter skip (contract section 2): `--skip-reason <text>` on a non-release run yields a `skip` result before any
 * work; on a release run the option is ignored. A bare `--skip-reason` without text is a usage error => fail.
 * @returns {object|null} a result, or null when the gate should run
 */
export function skipRequested(id, name, ctx) {
  const reason = ctx.opts['skip-reason'];
  if (reason === undefined || ctx.release) return null;
  const text = Array.isArray(reason) ? reason.join('; ') : reason;
  if (!nonEmpty(text) || text === 'true') {
    return result(id, 'fail', {
      summary: `${name}: --skip-reason requires a text explaining why the gate may be skipped`,
      findings: [error('--skip-reason was given without a reason text; refusing to skip silently')],
    });
  }
  return result(id, 'skip', { summary: `${name}: skipped by path filter`, skip_reason: text });
}

/** `--opt` value as a single string (last one wins) or undefined. */
export function optString(ctx, key) {
  const v = ctx.opts[key];
  if (v === undefined || v === true) return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/** Repeated option as array of strings. */
export function optList(ctx, key) {
  const v = ctx.opts[key];
  if (v === undefined || v === true) return [];
  return [].concat(v);
}

export const optFlag = (ctx, key) => ctx.opts[key] === true || ctx.opts[key] === 'true';

// ---------------------------------------------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------------------------------------------

const REQUIRED_WAIVER_FIELDS = ['id', 'gate', 'subject', 'owner', 'reason', 'issue', 'created', 'expires'];

/**
 * Parse and validate docs/waivers.yml for one gate.
 * @returns {{waivers: object[], findings: object[], file: string|null}} `waivers` are the currently valid entries for
 *          `gateId` (only these may downgrade findings); `findings` are error/info findings about the waiver file.
 */
export function loadWaivers(root, gateId, now) {
  const findings = [];
  const rel = 'docs/waivers.yml';
  const path = join(root, rel);
  if (!existsSync(path)) return { waivers: [], findings, file: null };
  let doc;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    if (!(e instanceof YamlError)) throw e;
    return { waivers: [], findings: [error(`${rel} cannot be parsed: ${e.message}`, rel)], file: rel };
  }
  const list = doc === null ? [] : doc.waivers;
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc) || !('waivers' in doc))) {
    return { waivers: [], findings: [error(`${rel} must be a mapping with a "waivers" list`, rel)], file: rel };
  }
  if (list === null || list === undefined) return { waivers: [], findings, file: rel };
  if (!Array.isArray(list)) {
    return { waivers: [], findings: [error(`${rel}: "waivers" must be a list`, rel)], file: rel };
  }

  const valid = [];
  const seen = new Set();
  const day = today(now);
  list.forEach((w, idx) => {
    const label = w && typeof w === 'object' && nonEmpty(w.id) ? w.id : `entry #${idx + 1}`;
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      findings.push(error(`${rel}: ${label} is not a mapping`, rel));
      return;
    }
    const target = typeof w.gate === 'string' ? w.gate : null;
    // Report problems of an entry in the gate it targets; entries without a recognisable gate are reported everywhere.
    const mine = target === gateId || !ALL_GATES.includes(target);
    if (!mine) return;
    const problems = [];
    for (const f of REQUIRED_WAIVER_FIELDS) if (w[f] === undefined || w[f] === null || w[f] === '') problems.push(`missing "${f}"`);
    if (nonEmpty(w.id) && seen.has(w.id)) problems.push('duplicate id');
    if (nonEmpty(w.id)) seen.add(w.id);
    if (target !== null && ALL_GATES.includes(target) && !WAIVABLE_GATES.includes(target)) {
      problems.push(`gate ${target} cannot be waived (only ${WAIVABLE_GATES.join(', ')})`);
    } else if (target !== null && !ALL_GATES.includes(target)) problems.push(`unknown gate "${target}"`);
    if (nonEmpty(w.issue) && !/^https?:\/\/\S+$/.test(w.issue)) problems.push('"issue" must be an http(s) URL');
    const created = parseIsoDate(w.created);
    const expires = parseIsoDate(w.expires);
    if (w.created !== undefined && w.created !== null && !created) problems.push('"created" is not a valid YYYY-MM-DD date');
    if (w.expires !== undefined && w.expires !== null && !expires) problems.push('"expires" is not a valid YYYY-MM-DD date');
    if (created && expires) {
      if (expires < created) problems.push('"expires" is before "created"');
      else if (daysBetween(created, expires) > MAX_WAIVER_DAYS) {
        problems.push(`"expires" is more than ${MAX_WAIVER_DAYS} days after "created"`);
      }
    }
    if (problems.length > 0) {
      findings.push(error(`${rel}: waiver ${label} is invalid: ${problems.join('; ')}`, rel));
      return;
    }
    if (expires < day) {
      findings.push(error(`waiver ${w.id} for "${w.subject}" expired on ${w.expires}; renew it with a new reviewed entry or fix the finding`, w.subject));
      return;
    }
    if (target === gateId) valid.push(w);
  });
  return { waivers: valid, findings, file: rel };
}

/**
 * Downgrade error findings covered by valid waivers to warnings (exact subject match).
 * @returns {{findings: object[], waived: string[]}}
 */
export function applyWaivers(findings, waivers) {
  const used = new Set();
  const out = findings.map((f) => {
    if (f.severity !== 'error' || !f.subject) return f;
    const w = waivers.find((x) => x.subject === f.subject);
    if (!w) return f;
    used.add(w.id);
    return warning(`${f.message} [waived by ${w.id} until ${w.expires}: ${w.reason}]`, f.subject);
  });
  for (const w of waivers) {
    if (!used.has(w.id)) out.push(info(`waiver ${w.id} (subject "${w.subject}") matched no finding; remove it if the issue is fixed`, w.subject));
  }
  return { findings: out, waived: [...used].sort() };
}

/** Standard "required tool is missing" finding (a missing tool is always a failure, never a pass). */
export function missingTool(tool, hint) {
  return error(`required tool "${tool}" not found: ${hint}`, tool);
}
