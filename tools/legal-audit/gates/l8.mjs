// L8 - Rule-pack citations and freshness (Workflow.md 4.2; R-DOC-1, R-RULES-1, R-RULES-3).
//
// Inputs: rule packs `rules/<JURISDICTION>/<pack>.yaml` (JURISDICTION = EU or an ISO-3166 alpha-2 code, upper case).
// Other files under rules/ (README.md, UNVERIFIED.md, ...) are not packs and are ignored.
//
// Pack: `pack` equals the file base name, `jurisdiction` equals the directory, `version` is semver, `valid_from`,
// `last_reviewed` are real calendar dates, `reviewed_by` is non-empty, `enabled` is a boolean, no `[UNVERIFIED]` text
// (unverified statements must not enter a pack, R-DOC-1). An enabled pack must not carry the UNREVIEWED marker
// (an agent draft cannot enable itself, R-RULES-2); disabled unreviewed packs are reported (warning on release builds).
// Rule: `code` unique in the pack, `source_ref` = `CELEX:<id>` | `ELI:http(s)://...` | `https://...`, `article`,
// `accessed_on` (a real date not after ctx.now), `valid_from`; `valid_to` (optional) not before `valid_from`.
// Freshness: ctx.now - last_reviewed > 180 days = error (also on release), > 90 days = warning.
// Dead links: only with `--check-links` (nightly): HEAD request per distinct reference, timeout `--link-timeout` ms
// (default 10000); any failure is a WARNING. CELEX ids resolve through `--celex-url-base`
// (default https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:).
// `pending_change` text is surfaced as an info finding (R-RULES-5: never silently adopted).
//
// Limits (Workflow.md 4.4): the gate checks presence and syntax of citations, not that the cited article supports the
// rule; that is the human approver's job (L11).
//
// Waiver subjects: pack-level findings `<pack>`, rule-level findings `<pack>:<code>`.
// Options: --check-links --link-timeout <ms> --celex-url-base <url> --skip-reason <text>
// Evidence: rule-register.json (every rule of every pack, flattened, with pack metadata and age)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyWaivers, daysBetween, hashInputs, isoDay, loadWaivers, nonEmpty, optFlag, optString, parseIsoDate, skipRequested, today } from '../lib/common.mjs';
import { error, info, result, statusFromFindings, warning, writeJson } from '../lib/result.mjs';
import { parseYaml, YamlError } from '../lib/miniyaml.mjs';

export const id = 'L8';
export const name = 'Rule-pack citations and freshness';

const SOURCE_REF = /^(CELEX:[0-9]{5}[A-Z][0-9]{4}[0-9A-Z]*|ELI:https?:\/\/\S+|https:\/\/\S+)$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const JURISDICTION = /^(EU|[A-Z]{2})$/;
export const WARN_AFTER_DAYS = 90;
export const FAIL_AFTER_DAYS = 180;
const DEFAULT_CELEX_BASE = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:';

/** Syntactic check of a `source_ref`; for https and ELI refs the URL must also parse and have a host. */
export function validSourceRef(ref) {
  if (typeof ref !== 'string' || !SOURCE_REF.test(ref)) return false;
  if (ref.startsWith('CELEX:')) return true;
  try {
    const u = new URL(ref.startsWith('ELI:') ? ref.slice(4) : ref);
    return u.hostname !== '';
  } catch {
    return false;
  }
}

/** URL that a link check requests for a `source_ref`. */
export function linkUrl(ref, celexBase = DEFAULT_CELEX_BASE) {
  if (ref.startsWith('CELEX:')) return `${celexBase}${ref.slice('CELEX:'.length)}`;
  if (ref.startsWith('ELI:')) return ref.slice(4);
  return ref;
}

function containsUnverified(value) {
  if (typeof value === 'string') return /\[UNVERIFIED\]/i.test(value);
  if (Array.isArray(value)) return value.some(containsUnverified);
  if (value && typeof value === 'object') return Object.values(value).some(containsUnverified);
  return false;
}

/** All pack files under `rules/`: [{rel, jurisdiction, base}] plus findings about stray content. */
function discoverPacks(root) {
  const rulesDir = join(root, 'rules');
  const packs = [];
  const notes = [];
  if (!existsSync(rulesDir) || !statSync(rulesDir).isDirectory()) return { packs, notes };
  for (const entry of readdirSync(rulesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      const files = readdirSync(join(rulesDir, entry.name)).filter((f) => /\.ya?ml$/.test(f)).sort();
      if (!JURISDICTION.test(entry.name)) {
        if (files.length > 0) notes.push(warning(`rules/${entry.name}/ is not a jurisdiction directory (EU or ISO-3166 alpha-2, upper case); its ${files.length} YAML file(s) are not checked`, `rules/${entry.name}`));
        continue;
      }
      for (const f of files) packs.push({ rel: `rules/${entry.name}/${f}`, jurisdiction: entry.name, base: f.replace(/\.ya?ml$/, '') });
    } else if (/\.ya?ml$/.test(entry.name)) {
      notes.push(warning(`rules/${entry.name} sits outside a jurisdiction directory and is not checked as a pack`, `rules/${entry.name}`));
    }
  }
  return { packs, notes };
}

async function checkLink(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'recon-legal-audit-L8 (link check)' } });
    return res.status < 400 ? null : `HTTP ${res.status}`;
  } catch (e) {
    return ctl.signal.aborted ? `no response within ${timeoutMs} ms` : `${e.cause?.code ?? e.message}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function run(ctx) {
  const skipped = skipRequested(id, name, ctx);
  if (skipped) return skipped;

  const day = today(ctx.now);
  const { packs, notes } = discoverPacks(ctx.root);
  const findings = [...notes];
  const register = { generated_at: ctx.now.toISOString(), as_of: isoDay(day), packs: [], rules: [] };
  const refs = new Map(); // url -> [{pack, code}]
  const files = [];

  for (const p of packs) {
    files.push(p.rel);
    let doc;
    try {
      doc = parseYaml(readFileSync(join(ctx.root, p.rel), 'utf8'));
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      findings.push(error(`${p.rel}: cannot be parsed: ${e.message}`, p.base));
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      findings.push(error(`${p.rel}: must be a YAML mapping`, p.base));
      continue;
    }
    const err = (msg, subject = p.base) => findings.push(error(`${p.rel}: ${msg}`, subject));
    const warn = (msg, subject = p.base) => findings.push(warning(`${p.rel}: ${msg}`, subject));

    if (doc.pack !== p.base) err(`"pack" is ${JSON.stringify(doc.pack)} but the file is named ${p.base}.yaml`);
    if (doc.jurisdiction !== p.jurisdiction) err(`"jurisdiction" is ${JSON.stringify(doc.jurisdiction)} but the file is in rules/${p.jurisdiction}/`);
    if (typeof doc.version !== 'string' || !SEMVER.test(doc.version)) err(`"version" ${JSON.stringify(doc.version)} is not a semantic version (MAJOR.MINOR.PATCH)`);
    const validFrom = parseIsoDate(doc.valid_from);
    if (!validFrom) err(`"valid_from" ${JSON.stringify(doc.valid_from)} is missing or not a YYYY-MM-DD date`);
    if (doc.valid_to !== null && doc.valid_to !== undefined) {
      const vt = parseIsoDate(doc.valid_to);
      if (!vt) err(`"valid_to" ${JSON.stringify(doc.valid_to)} is not a YYYY-MM-DD date`);
      else if (validFrom && vt < validFrom) err('"valid_to" is before "valid_from"');
    }
    if (typeof doc.enabled !== 'boolean') err(`"enabled" must be true or false, got ${JSON.stringify(doc.enabled)}`);
    if (!nonEmpty(doc.reviewed_by)) err('"reviewed_by" is missing or empty');
    const unreviewed = typeof doc.reviewed_by === 'string' && /UNREVIEWED/i.test(doc.reviewed_by);
    if (unreviewed && doc.enabled === true) err('pack is enabled but "reviewed_by" still says UNREVIEWED: an agent draft must not enable itself (R-RULES-2)');
    else if (unreviewed) {
      (ctx.release ? warn : (m) => findings.push(info(`${p.rel}: ${m}`, p.base)))('pack is an UNREVIEWED draft (disabled); human compliance review is still outstanding');
    }
    if (containsUnverified(doc)) err('contains "[UNVERIFIED]" text; unverified statements must not enter a rule pack (R-DOC-1)');

    const reviewed = parseIsoDate(doc.last_reviewed);
    let age = null;
    if (!reviewed) err(`"last_reviewed" ${JSON.stringify(doc.last_reviewed)} is missing or not a YYYY-MM-DD date`);
    else if (reviewed > day) err(`"last_reviewed" ${doc.last_reviewed} is in the future`);
    else {
      age = daysBetween(reviewed, day);
      if (age > FAIL_AFTER_DAYS) err(`last reviewed ${age} days ago (${doc.last_reviewed}); packs older than ${FAIL_AFTER_DAYS} days fail (R-RULES-3)`);
      else if (age > WARN_AFTER_DAYS) warn(`last reviewed ${age} days ago (${doc.last_reviewed}); review is due before ${FAIL_AFTER_DAYS} days (R-RULES-3)`);
    }

    const rules = doc.rules;
    if (!Array.isArray(rules)) {
      err('"rules" must be a list');
    } else if (rules.length === 0) {
      warn('pack contains no rules');
    }
    const seen = new Set();
    (Array.isArray(rules) ? rules : []).forEach((r, idx) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        err(`rules[${idx}] is not a mapping`);
        return;
      }
      const code = nonEmpty(r.code) ? r.code : null;
      const subject = code ? `${p.base}:${code}` : p.base;
      const label = code ?? `rules[${idx}]`;
      const rerr = (m) => err(`${label}: ${m}`, subject);
      if (!code) err(`rules[${idx}] has no "code"`);
      else if (seen.has(code)) rerr('duplicate rule code in this pack');
      else seen.add(code);
      if (!nonEmpty(r.title)) findings.push(warning(`${p.rel}: ${label}: "title" is missing`, subject));
      if (!nonEmpty(r.article)) rerr('"article" is missing');
      if (!nonEmpty(r.source_ref)) rerr('"source_ref" is missing (R-DOC-1: every rule cites a primary source)');
      else if (!validSourceRef(r.source_ref)) rerr(`"source_ref" ${JSON.stringify(r.source_ref)} is not CELEX:<id>, ELI:<uri> or an https URL`);
      else {
        const url = linkUrl(r.source_ref, optString(ctx, 'celex-url-base') ?? DEFAULT_CELEX_BASE);
        if (!refs.has(url)) refs.set(url, []);
        refs.get(url).push({ pack: p.base, code: label, subject, ref: r.source_ref });
      }
      const acc = parseIsoDate(r.accessed_on);
      if (!acc) rerr(`"accessed_on" ${JSON.stringify(r.accessed_on)} is missing or not a YYYY-MM-DD date`);
      else if (acc > day) rerr(`"accessed_on" ${r.accessed_on} is in the future`);
      const rf = parseIsoDate(r.valid_from);
      if (!rf) rerr(`"valid_from" ${JSON.stringify(r.valid_from)} is missing or not a YYYY-MM-DD date`);
      if (r.valid_to !== null && r.valid_to !== undefined) {
        const rt = parseIsoDate(r.valid_to);
        if (!rt) rerr(`"valid_to" ${JSON.stringify(r.valid_to)} is not a YYYY-MM-DD date`);
        else if (rf && rt < rf) rerr('"valid_to" is before "valid_from"');
      }
      if (nonEmpty(r.pending_change)) findings.push(info(`${p.rel}: ${label}: pending change recorded (not adopted): ${r.pending_change}`, subject));
      register.rules.push({
        pack: p.base,
        jurisdiction: p.jurisdiction,
        code: r.code ?? null,
        title: r.title ?? null,
        source_ref: r.source_ref ?? null,
        article: r.article ?? null,
        accessed_on: r.accessed_on ?? null,
        valid_from: r.valid_from ?? null,
        valid_to: r.valid_to ?? null,
        pending_change: r.pending_change ?? null,
      });
    });
    register.packs.push({
      pack: p.base,
      file: p.rel,
      jurisdiction: p.jurisdiction,
      version: doc.version ?? null,
      valid_from: doc.valid_from ?? null,
      valid_to: doc.valid_to ?? null,
      last_reviewed: doc.last_reviewed ?? null,
      reviewed_by: doc.reviewed_by ?? null,
      enabled: doc.enabled ?? null,
      age_days: age,
      rules: Array.isArray(rules) ? rules.length : 0,
    });
  }

  // ---- optional link liveness ------------------------------------------------------------------------------------
  let linksChecked = 0;
  if (optFlag(ctx, 'check-links')) {
    const timeoutMs = Number.parseInt(optString(ctx, 'link-timeout') ?? '10000', 10) || 10_000;
    const urls = [...refs.keys()];
    const queue = [...urls];
    const worker = async () => {
      for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
        const problem = await checkLink(u, timeoutMs);
        linksChecked++;
        if (problem) {
          const users = refs.get(u);
          findings.push(warning(`source link ${u} did not respond OK (${problem}); cited by ${users.map((x) => `${x.pack}:${x.code}`).join(', ')}`, users[0].subject));
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  if (packs.length === 0) findings.push(info('no rule packs under rules/<JURISDICTION>/*.yaml'));

  evidenceSort(register);
  const evidence = [writeJson(ctx.outDir, 'rule-register.json', register)];

  const wv = loadWaivers(ctx.root, id, ctx.now);
  const applied = applyWaivers(findings, wv.waivers);
  const all = [...applied.findings, ...wv.findings];
  return result(id, statusFromFindings(all), {
    summary: `${register.packs.length} rule pack(s), ${register.rules.length} rule(s) checked${optFlag(ctx, 'check-links') ? `, ${linksChecked} link(s) probed` : ''}`,
    findings: all,
    evidence,
    metrics: { packs: register.packs.length, rules: register.rules.length, links_checked: linksChecked },
    inputs: hashInputs(ctx.root, [...files, 'docs/waivers.yml']),
    tools: {},
    waived: applied.waived,
  });
}

function evidenceSort(register) {
  register.packs.sort((a, b) => a.file.localeCompare(b.file));
  register.rules.sort((a, b) => `${a.jurisdiction}/${a.pack}/${a.code}`.localeCompare(`${b.jurisdiction}/${b.pack}/${b.code}`));
}
