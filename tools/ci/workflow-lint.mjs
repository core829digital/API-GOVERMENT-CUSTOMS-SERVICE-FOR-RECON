#!/usr/bin/env node
// Workflow hardening lint (R-SEC-7: Actions pinned by commit SHA; Workflow.md §3: `permissions: contents: read` by default).
// Complements actionlint (syntax/expressions/shellcheck), which does not check any of the following.
//
//   node tools/ci/workflow-lint.mjs [--root DIR]        scans <root>/.github/workflows/*.y{a,}ml
//
// 1. Every `uses:` is local (./...), `docker://...@sha256:<64 hex>`, or `owner/repo[/path]@<40 hex commit SHA>` followed by
//    a trailing `# vMAJOR.MINOR.PATCH` comment naming the release the SHA belongs to.
// 2. Top-level `permissions:` is exactly `contents: read`; top-level `concurrency:` exists.
// 3. Job-level `permissions:` may only ADD: id-token/attestations/packages: write in the job named `release`;
//    issues: write in the job named `freshness-issue`; never `contents: write`, never write-all.
// 4. Every job has `timeout-minutes`.
// 5. Every actions/checkout step sets `persist-credentials: false`.
// 6. `run:` scripts never interpolate attacker-influenced context directly (${{ github.head_ref }}, github.ref_name,
//    github.event.* except pull_request number/base.sha/head.sha, inputs.*, secrets.*): pass it through `env:` instead.
// Line-based scanner over the repository's own workflow style (block mappings, 2-space indent). Exit: 0 clean, 1 findings.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finding, parseArgs, report, runMain } from './lib/common.mjs';

export const JOB_WRITE_ALLOWLIST = {
  release: new Set(['id-token', 'attestations', 'packages']),
  'freshness-issue': new Set(['issues']),
};

const indentOf = (l) => l.length - l.trimStart().length;
const isBlank = (l) => l.trim() === '' || l.trim().startsWith('#');
const USES = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#\s*(.*?))?\s*$/;
const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
const DOCKER_REF = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SAFE_EVENT = /^github\.event\.(?:pull_request\.(?:number|base\.sha|head\.sha)|number|before|after)$/;
const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;

/** Block of lines following `lines[i]` that are indented deeper than it (blank/comment lines included). */
function childRange(lines, i) {
  const base = indentOf(lines[i]);
  let j = i + 1;
  let last = i;
  for (; j < lines.length; j++) {
    if (isBlank(lines[j])) continue;
    if (indentOf(lines[j]) <= base) break;
    last = j;
  }
  return [i + 1, last + 1];
}

function permissionsOf(lines, i) {
  const inline = /^\s*permissions:\s*(\S.*)$/.exec(lines[i]);
  if (inline) return { scalar: inline[1].replace(/\s+#.*$/, '').trim(), map: {} };
  const [from, to] = childRange(lines, i);
  const map = {};
  for (const l of lines.slice(from, to)) {
    const m = /^\s*([\w-]+):\s*(\S+)/.exec(l);
    if (m) map[m[1]] = m[2];
  }
  return { scalar: null, map };
}

export function lintWorkflowText(rel, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const add = (i, msg) => out.push(finding(rel, msg, i + 1));

  // 1. uses:
  let usesCount = 0;
  lines.forEach((l, i) => {
    const m = USES.exec(l);
    if (!m || l.trim().startsWith('#')) return;
    usesCount++;
    const ref = m[1].replace(/^["']|["']$/g, '');
    if (ref.startsWith('./')) return;
    if (DOCKER_REF.test(ref)) return;
    if (!SHA_REF.test(ref)) {
      add(i, `\`uses: ${ref}\` is not pinned to a full 40-hex commit SHA (R-SEC-7)`);
      return;
    }
    if (!m[2] || !VERSION_COMMENT.test(m[2].trim().split(/\s+/)[0])) {
      add(i, `\`uses: ${ref}\` needs a trailing "# vX.Y.Z" comment naming the release of the pinned SHA`);
    }
  });

  // 2. workflow-level permissions / concurrency
  const topIdx = (key) => lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  const pTop = topIdx('permissions');
  if (pTop < 0) out.push(finding(rel, 'missing top-level `permissions:` (must be `contents: read`)'));
  else {
    const p = permissionsOf(lines, pTop);
    const keys = Object.keys(p.map);
    if (p.scalar !== null || keys.length !== 1 || p.map.contents !== 'read') add(pTop, 'top-level permissions must be exactly `contents: read`');
  }
  if (topIdx('concurrency') < 0) out.push(finding(rel, 'missing top-level `concurrency:` group'));

  // 3/4. jobs
  const jobsIdx = topIdx('jobs');
  const jobStarts = [];
  if (jobsIdx >= 0) {
    const [from, to] = childRange(lines, jobsIdx);
    for (let i = from; i < to; i++) {
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
      if (m) jobStarts.push({ id: m[1], at: i });
    }
  }
  jobStarts.forEach((job, k) => {
    const end = k + 1 < jobStarts.length ? jobStarts[k + 1].at : lines.length;
    const body = lines.slice(job.at + 1, end);
    const idx = (re) => body.findIndex((l) => indentOf(l) === 4 && re.test(l));
    if (idx(/^\s*timeout-minutes:\s*\d+/) < 0) add(job.at, `job ${job.id}: missing timeout-minutes`);
    const pi = idx(/^\s*permissions:/);
    if (pi >= 0) {
      const abs = job.at + 1 + pi;
      const p = permissionsOf(lines, abs);
      if (p.scalar !== null) add(abs, `job ${job.id}: permissions must be a mapping, not "${p.scalar}"`);
      for (const [key, val] of Object.entries(p.map)) {
        if (val !== 'write') continue;
        if (!JOB_WRITE_ALLOWLIST[job.id]?.has(key)) add(abs, `job ${job.id}: \`${key}: write\` is not allowed for this job`);
      }
    }
  });

  // 5. checkout steps / 6. run scripts
  lines.forEach((l, i) => {
    if (/^\s*(?:-\s+)?uses:\s*actions\/checkout@/.test(l)) {
      // step block: from the `- ` line at/above to the next step
      let start = i;
      while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
      const stepIndent = indentOf(lines[start]);
      let end = i + 1;
      while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > stepIndent)) end++;
      if (!lines.slice(start, end).some((x) => /^\s*persist-credentials:\s*false\s*$/.test(x))) add(i, 'actions/checkout step must set `persist-credentials: false`');
    }
    const r = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(l);
    if (r && !l.trim().startsWith('#')) {
      const keyIndent = indentOf(l) + (/^\s*-\s+run:/.test(l) ? 2 : 0);
      const script = [r[2]];
      if (/^[|>][+-]?$/.test(r[2].trim())) {
        script.length = 0;
        for (let j = i + 1; j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) > keyIndent); j++) script.push(lines[j]);
      }
      script.forEach((sl, off) => {
        for (const e of sl.matchAll(EXPR)) {
          const expr = e[1];
          const risky =
            /\bgithub\.head_ref\b/.test(expr) ||
            /\bgithub\.ref_name\b/.test(expr) ||
            /\bsecrets\./.test(expr) ||
            /(^|[^.\w])inputs\./.test(expr) ||
            (/\bgithub\.event\./.test(expr) && !SAFE_EVENT.test(expr));
          if (risky) add(i + off + (script.length > 1 ? 1 : 0), `\`\${{ ${expr} }}\` inside run: is a script-injection / secret-leak risk: pass it via env: and use "$VAR"`);
        }
      });
    }
  });
  return { findings: out, usesCount };
}

export function lintWorkflows(root) {
  const dir = join(root, '.github', 'workflows');
  const findings = [];
  let uses = 0;
  let files = 0;
  if (!existsSync(dir)) return { findings: [finding('.github/workflows', 'directory missing')], uses, files };
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    files++;
    const r = lintWorkflowText(`.github/workflows/${f}`, readFileSync(join(dir, f), 'utf8'));
    findings.push(...r.findings);
    uses += r.usesCount;
  }
  return { findings, uses, files };
}

runMain(import.meta.url, (argv) => {
  const { opts } = parseArgs(argv);
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  const { findings, uses, files } = lintWorkflows(root);
  return report('workflow-lint', findings, [`${files} workflow file(s), ${uses} uses: reference(s) checked`]);
});
