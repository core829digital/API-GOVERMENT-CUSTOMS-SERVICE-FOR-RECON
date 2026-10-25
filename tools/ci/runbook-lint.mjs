#!/usr/bin/env node
// Runbook lint (R-OPS-1: every alert links a runbook; contract §3.6).
//
//   node tools/ci/runbook-lint.mjs [--root DIR] [--required-alerts A,B,...] [--required-runbooks X,Y,...]
//
// 1. Every `- alert: <Name>` in infra/observability/*.{yaml,yml} (PrometheusRule or plain Prometheus rule files) has an
//    `annotations:` entry `runbook: docs/runbooks/<File>.md` pointing to an existing file.
// 2. Every runbook file docs/runbooks/*.md that is referenced or required has front matter with `name` (== file base
//    name), `severity` (P1|P2|P3), `owner` (non-empty), `last_exercised` (YYYY-MM-DD or `never`), and the sections
//    `## Trigger`, `## Impact`, `## Diagnose`, `## Mitigate`, `## Verify`, `## Escalate`, each with content.
// 3. The required alerts exist (default: ReplicationLagHigh, SubscriptionApplyErrors, SlotRetainedWalHigh, BackupAgeHigh)
//    and the required runbooks exist (default: those four + FidelityMismatchPersistent, LedgerChainDivergence,
//    SlotInvalidated, RRebuild, WFailover, RestoreDrill, PersonalDataBreach).
// Alerts are found by indentation-aware line scanning (rule files contain `expr: |` block scalars and Helm templating
// that a small YAML parser cannot read). Exit: 0 clean, 1 findings, 2 usage error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finding, parseArgs, report, runMain } from './lib/common.mjs';

export const REQUIRED_ALERTS = ['ReplicationLagHigh', 'SubscriptionApplyErrors', 'SlotRetainedWalHigh', 'BackupAgeHigh'];
export const REQUIRED_RUNBOOKS = [
  ...REQUIRED_ALERTS,
  'FidelityMismatchPersistent',
  'LedgerChainDivergence',
  'SlotInvalidated',
  'RRebuild',
  'WFailover',
  'RestoreDrill',
  'PersonalDataBreach',
];
export const SECTIONS = ['Trigger', 'Impact', 'Diagnose', 'Mitigate', 'Verify', 'Escalate'];
const RUNBOOK_PATH = /^docs\/runbooks\/[A-Za-z0-9][A-Za-z0-9_-]*\.md$/;

const indentOf = (l) => l.length - l.trimStart().length;
const unquote = (v) => {
  let s = v.trim();
  const m = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(s);
  if (m) return m[2];
  s = s.replace(/\s+#.*$/, '');
  return s.trim();
};

/** [{ name, line, runbook|null }] for every alert rule in a rule file. */
export function extractAlerts(text) {
  const lines = text.split(/\r?\n/);
  const alerts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+alert:\s*(\S.*)$/.exec(lines[i]);
    if (!m) continue;
    const dash = m[1].length;
    const entry = { name: unquote(m[2]), line: i + 1, runbook: null };
    let annIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      const ind = indentOf(l);
      if (ind <= dash) break; // next rule or end of the rules list
      if (annIndent >= 0 && ind <= annIndent) annIndent = -1;
      const k = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
      if (!k) continue;
      if (k[1] === 'annotations' && k[2].trim() === '') annIndent = ind;
      else if (k[1] === 'runbook' && annIndent >= 0 && ind > annIndent) entry.runbook = unquote(k[2]);
    }
    alerts.push(entry);
  }
  return alerts;
}

function frontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const fm = {};
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
    if (m) fm[m[1]] = unquote(m[2]);
  }
  return { fm, body: lines.slice(end + 1), offset: end + 1 };
}

const isRealDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

export function lintRunbookText(rel, text) {
  const out = [];
  const base = rel.split('/').pop().replace(/\.md$/, '');
  const parsed = frontMatter(text);
  if (!parsed) {
    out.push(finding(rel, 'missing front matter block (--- ... --- at the top of the file)', 1));
    return out;
  }
  const { fm, body, offset } = parsed;
  if (fm.name !== base) out.push(finding(rel, `front matter name must equal the file name "${base}" (found "${fm.name ?? ''}")`, 2));
  if (!/^P[123]$/.test(fm.severity ?? '')) out.push(finding(rel, `front matter severity must be P1, P2 or P3 (found "${fm.severity ?? ''}")`, 2));
  if (!fm.owner) out.push(finding(rel, 'front matter owner is empty', 2));
  if (!(fm.last_exercised === 'never' || isRealDate(fm.last_exercised ?? ''))) {
    out.push(finding(rel, `front matter last_exercised must be YYYY-MM-DD or "never" (found "${fm.last_exercised ?? ''}")`, 2));
  }
  // sections outside code fences
  const headings = [];
  let fence = false;
  body.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^##\s+(.+?)\s*$/.exec(l);
    if (h) headings.push({ title: h[1], at: i });
  });
  for (const sec of SECTIONS) {
    const idx = headings.findIndex((h) => h.title === sec);
    if (idx < 0) {
      out.push(finding(rel, `missing section "## ${sec}"`));
      continue;
    }
    const from = headings[idx].at + 1;
    const to = idx + 1 < headings.length ? headings[idx + 1].at : body.length;
    if (body.slice(from, to).every((l) => l.trim() === '')) out.push(finding(rel, `section "## ${sec}" is empty`, offset + headings[idx].at + 1));
  }
  return out;
}

export function lintRunbooks({ root, requiredAlerts = REQUIRED_ALERTS, requiredRunbooks = REQUIRED_RUNBOOKS }) {
  const findings = [];
  const obsDir = join(root, 'infra', 'observability');
  const alerts = [];
  if (existsSync(obsDir)) {
    for (const f of readdirSync(obsDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const rel = `infra/observability/${f}`;
      for (const a of extractAlerts(readFileSync(join(obsDir, f), 'utf8'))) alerts.push({ ...a, file: rel });
    }
  } else if (requiredAlerts.length > 0) {
    findings.push(finding('infra/observability', 'directory missing: no alert rules to check'));
  }

  const toLint = new Set(requiredRunbooks.map((n) => `docs/runbooks/${n}.md`));
  for (const a of alerts) {
    if (!a.runbook) {
      findings.push(finding(a.file, `alert ${a.name} has no annotations.runbook (R-OPS-1)`, a.line));
    } else if (!RUNBOOK_PATH.test(a.runbook)) {
      findings.push(finding(a.file, `alert ${a.name}: runbook "${a.runbook}" must be a path docs/runbooks/<Name>.md`, a.line));
    } else if (!existsSync(join(root, a.runbook))) {
      findings.push(finding(a.file, `alert ${a.name}: runbook ${a.runbook} does not exist`, a.line));
    } else toLint.add(a.runbook);
  }
  for (const name of requiredAlerts) {
    if (!alerts.some((a) => a.name === name)) findings.push(finding('infra/observability', `required alert ${name} is not defined`));
  }
  for (const rel of [...toLint].sort()) {
    if (!existsSync(join(root, rel))) {
      findings.push(finding(rel, 'required runbook is missing'));
      continue;
    }
    findings.push(...lintRunbookText(rel, readFileSync(join(root, rel), 'utf8')));
  }
  return { findings, alertCount: alerts.length, runbookCount: toLint.size };
}

const list = (v, dflt) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : dflt);

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  const { findings, alertCount, runbookCount } = lintRunbooks({
    root,
    requiredAlerts: list(opts['required-alerts'], REQUIRED_ALERTS),
    requiredRunbooks: list(opts['required-runbooks'], REQUIRED_RUNBOOKS),
  });
  return report('runbook-lint', findings, [`${alertCount} alert(s), ${runbookCount} runbook(s) checked`]);
});
