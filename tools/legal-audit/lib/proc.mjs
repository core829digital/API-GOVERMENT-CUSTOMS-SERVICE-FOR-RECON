// Process, hashing and libtest helpers shared by gates L4-L7, L11 and L12 (slice S2).
//
//   runProc          spawn an executable (no shell) and collect stdout/stderr, with timeout and output cap
//   toolVersion      first line of `<cmd> --version`, or null when the tool cannot be executed
//   sha256File       hex sha256 of a file (inputs recorded in gate results)
//   skipOrNull       implements the `--skip-reason` contract (Phase 1 contract section 2)
//   parseLibtest     parse the default (non-JSON) libtest output
//   runLibtestGate   shared body of the cargo-test based gates L6 and L7
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { error, result, statusFromFindings, writeJson, writeText } from './result.mjs';

const MAX_CAPTURE = 64 * 1024 * 1024;

/**
 * @param {string} cmd executable (fully qualified, or resolvable on PATH)
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, timeoutMs?:number, input?:string}} [opts]
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, error:Error|null}>}
 */
export function runProc(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolvePromise({ code: null, signal: null, stdout, stderr, timedOut, error: e });
      return;
    }
    const cap = (acc, chunk) => (acc.length >= MAX_CAPTURE ? acc : acc + chunk.toString('utf8'));
    child.stdout.on('data', (c) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c) => (stderr = cap(stderr, c)));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut, error: spawnError });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

/** First non-empty line of `<cmd> <args>` (default `--version`), or null if the tool cannot be run. */
export async function toolVersion(cmd, args = ['--version'], opts = {}) {
  const r = await runProc(cmd, args, { timeoutMs: 30_000, ...opts });
  if (r.error || r.code !== 0) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? null;
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

/** Path label for `inputs`: repo-relative with forward slashes when under root, else the absolute path. */
export function inputLabel(root, abs) {
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

/** Resolve an option path against the repo root. */
export const resolveOpt = (root, p) => resolve(root, p);

/**
 * `--skip-reason <text>` contract: when present and the build is not a release, the gate does nothing and reports
 * `skip`. Release builds ignore the option and run. A value-less `--skip-reason` is a usage error (fail).
 * @returns {object|null} a result to return immediately, or null to continue
 */
export function skipOrNull(ctx, id) {
  const v = ctx.opts['skip-reason'];
  if (v === undefined || ctx.release) return null;
  if (typeof v !== 'string' || v.trim() === '') {
    return result(id, 'fail', { summary: 'invalid --skip-reason', findings: [error('--skip-reason requires a non-empty text value')] });
  }
  return result(id, 'skip', { summary: 'skipped by path filter', skip_reason: v.trim() });
}

// ---------------------------------------------------------------------------------------------------------------
// libtest

/**
 * Parse default libtest output (`test <name> ... ok|FAILED|ignored[, reason]`, `test result: ...`, `Running ...`).
 * Cargo's own lines (stderr) may be mixed in; anything else is ignored.
 * @returns {{tests:Array<{name:string,status:'ok'|'FAILED'|'ignored',binary:string|null}>, summaries:Array<{ok:boolean,passed:number,failed:number,ignored:number,binary:string|null}>}}
 */
export function parseLibtest(text) {
  const tests = [];
  const summaries = [];
  let binary = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const run = /^\s*Running\s+(.+?)\s+\((.+)\)$/.exec(line) ?? /^\s*Running\s+(.+)$/.exec(line);
    if (run) {
      binary = run[1];
      continue;
    }
    const doc = /^\s*Doc-tests\s+(\S+)/.exec(line);
    if (doc) {
      binary = `doc-tests ${doc[1]}`;
      continue;
    }
    const t = /^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?$/.exec(line);
    if (t) {
      tests.push({ name: t[1], status: t[2], binary });
      continue;
    }
    const s = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/.exec(line);
    if (s) summaries.push({ ok: s[1] === 'ok', passed: Number(s[2]), failed: Number(s[3]), ignored: Number(s[4]), binary });
  }
  return { tests, summaries };
}

/** Test names are bare for integration tests and module-qualified for unit tests: match `name` or `*::name`. */
const matchesName = (testName, required) => testName === required || testName.endsWith(`::${required}`);

/**
 * Check required tests against parsed libtest output.
 * @returns {{findings:object[], found:Array<{name:string,status:string,matched:string[]}>}}
 */
export function checkRequired(required, parsed, label) {
  const findings = [];
  const found = [];
  for (const name of required) {
    const hits = parsed.tests.filter((t) => matchesName(t.name, name));
    if (hits.length === 0) {
      findings.push(error(`required test "${name}" is absent from the ${label} output`, name));
      found.push({ name, status: 'absent', matched: [] });
      continue;
    }
    const bad = hits.filter((h) => h.status !== 'ok');
    for (const h of bad) {
      findings.push(error(`required test "${h.name}" is ${h.status === 'ignored' ? 'ignored (a skipped test proves nothing)' : h.status}`, name));
    }
    found.push({ name, status: bad.length ? bad[0].status : 'ok', matched: hits.map((h) => h.name) });
  }
  for (const t of parsed.tests) {
    if (t.status === 'FAILED' && !required.some((r) => matchesName(t.name, r))) {
      findings.push(error(`test "${t.name}" FAILED in the ${label} run`, t.name));
    }
  }
  for (const s of parsed.summaries) {
    if (!s.ok || s.failed > 0) findings.push(error(`libtest reported failures (${s.failed} failed) in ${s.binary ?? label}`, s.binary ?? undefined));
  }
  return { findings, found };
}

const splitArgs = (v) => [].concat(v ?? []).filter((x) => typeof x === 'string').flatMap((x) => x.split(/\s+/).filter(Boolean));

/**
 * Shared L6/L7 body.
 * @param {object} ctx gate context; options `--cargo <path>` (default `cargo`), `--test-args "<extra cargo test args>"`,
 *   `--transcript <file>` (parse a recorded libtest transcript instead of running cargo; rejected for release builds)
 * @param {{id:string, name:string, groups:Array<{label:string, args:string[], tests:string[]}>}} spec each group is one
 *   `cargo test <args>` invocation and the tests that MUST be present and `ok` in its output
 */
export async function runLibtestGate(ctx, spec) {
  const { id, groups } = spec;
  const findings = [];
  const inputs = {};
  const tools = {};
  const rawParts = [];
  const groupReports = [];
  const transcriptOpt = ctx.opts.transcript;

  if (transcriptOpt !== undefined) {
    if (ctx.release) {
      return result(id, 'fail', { summary: 'transcript not accepted', findings: [error('--transcript is not accepted for release builds: the attestation must come from a real cargo run')] });
    }
    if (typeof transcriptOpt !== 'string') {
      return result(id, 'fail', { summary: 'invalid --transcript', findings: [error('--transcript requires a file path')] });
    }
    const path = resolve(ctx.root, transcriptOpt);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      return result(id, 'fail', { summary: 'transcript unreadable', findings: [error(`cannot read transcript ${transcriptOpt}: ${e.message}`)] });
    }
    inputs[inputLabel(ctx.root, path)] = sha256Buffer(Buffer.from(text));
    tools.source = 'recorded libtest transcript (not a live cargo run)';
    rawParts.push(text);
    const parsed = parseLibtest(text);
    if (parsed.tests.length === 0) findings.push(error('transcript contains no libtest `test <name> ... <status>` lines'));
    if (parsed.summaries.length === 0) findings.push(error('transcript contains no `test result:` line'));
    for (const g of groups) {
      const { findings: f, found } = checkRequired(g.tests, parsed, 'transcript');
      findings.push(...f.filter((x) => !findings.some((y) => y.message === x.message)));
      groupReports.push({ label: g.label, command: ['cargo', 'test', ...g.args], exit_code: null, required: found });
    }
  } else {
    const cargo = typeof ctx.opts.cargo === 'string' ? ctx.opts.cargo : 'cargo';
    const extra = splitArgs(ctx.opts['test-args']);
    const version = await toolVersion(cargo);
    if (version === null) {
      return result(id, 'fail', { summary: 'cargo not available', findings: [error(`cannot execute "${cargo}" (--version failed); the gate cannot be evaluated without cargo`)] });
    }
    tools.cargo = version;
    for (const g of groups) {
      const args = ['test', ...g.args, ...extra];
      ctx.log(`${id}: ${cargo} ${args.join(' ')}`);
      const r = await runProc(cargo, args, { cwd: ctx.root, timeoutMs: 45 * 60 * 1000 });
      rawParts.push(`### ${g.label}: cargo ${args.join(' ')}\n### exit code: ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${r.stdout}\n${r.stderr}`);
      if (r.error) findings.push(error(`${g.label}: cannot run cargo: ${r.error.message}`));
      else if (r.timedOut) findings.push(error(`${g.label}: cargo test timed out after 45 minutes`));
      else if (r.code !== 0) findings.push(error(`${g.label}: cargo test exited with code ${r.code}`, g.label));
      const parsed = parseLibtest(`${r.stdout}\n${r.stderr}`);
      if (r.code === 0 && parsed.summaries.length === 0) findings.push(error(`${g.label}: cargo test exited 0 but printed no \`test result:\` line`, g.label));
      const { findings: f, found } = checkRequired(g.tests, parsed, g.label);
      findings.push(...f);
      groupReports.push({ label: g.label, command: [cargo, ...args], exit_code: r.code, required: found });
    }
  }

  const evidence = [
    writeJson(ctx.outDir, `${id}-tests.json`, { gate: id, groups: groupReports }),
    writeText(ctx.outDir, `${id}-libtest.txt`, rawParts.join('\n')),
  ];
  const required = groups.reduce((n, g) => n + g.tests.length, 0);
  const okCount = groupReports.reduce((n, g) => n + g.required.filter((t) => t.status === 'ok').length, 0);
  const status = statusFromFindings(findings);
  return result(id, status, {
    summary: `${okCount}/${required} required tests present and ok`,
    findings,
    evidence,
    metrics: { required_tests: required, required_ok: okCount },
    inputs,
    tools,
  });
}
