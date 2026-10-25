// L11 - Required human sign-off (Workflow.md 4.2; Rules R-GEN-3 / branch protection).
//
// For every changed file whose CODEOWNERS entry names the compliance team, at least one review must be
//   state == APPROVED, user.type == "User" (never a Bot), commit_id == --head-sha (i.e. after the last push),
//   submitted by a member of the owning compliance team,
// and the reviewer's LATEST decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED) must be that approval.
// The gate does no network access: CI fetches the inputs from the GitHub API
//   GET /repos/{o}/{r}/pulls/{n}/reviews  -> --reviews <json array: user.login, user.type, state, commit_id, submitted_at>
//   GET /orgs/{o}/teams/{t}/members       -> --team-members <json {"<org>/<team>" or "<team>": ["login", ...]}>
// Waivers cannot cover L11.
//
// Options
//   --changed-file <path>     text file, one changed path per line (repo-relative)                         [required]
//   --codeowners <path>       default .github/CODEOWNERS
//   --reviews <path>, --head-sha <sha>, --team-members <path>   required when a gated file changed
//   --compliance-team <slug>  team slug that marks a gated path (default "compliance")
//   --skip-reason <text>      not meaningful here (L11 always runs) but honoured per the gate contract
// Release builds additionally require a non-empty changed-file list.
// Evidence: approvals.json (approval list: who approved what at which commit, for L12).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { error, info, result, statusFromFindings, writeJson } from '../lib/result.mjs';
import { inputLabel, sha256File, skipOrNull } from '../lib/proc.mjs';

export const id = 'L11';
export const name = 'Required human sign-off';

// ---------------------------------------------------------------------------------------------------------------
// CODEOWNERS (gitignore-style patterns, last matching line wins)

function globToRegexSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?'; // `**/` = zero or more directories
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** Compile one CODEOWNERS pattern into a RegExp over repo-relative paths with `/` separators. */
export function compilePattern(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const body = globToRegexSource(p);
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // a directory pattern matches everything below it (and not a file of the same name); others match the path or any parent
  return new RegExp(`${prefix}${body}${dirOnly ? '/.*$' : '(?:/.*)?$'}`);
}

/** @returns {Array<{pattern:string, owners:string[], re:RegExp, line:number}>} */
export function parseCodeowners(text) {
  const rules = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners, re: compilePattern(pattern), line: i + 1 });
  });
  return rules;
}

/** Owners of `path` (last matching rule wins); null when no rule matches. */
export function ownersOf(rules, path) {
  let hit = null;
  for (const r of rules) if (r.re.test(path)) hit = r;
  return hit;
}

// ---------------------------------------------------------------------------------------------------------------

const teamSlug = (owner) => owner.replace(/^@/, '');
const isTeam = (owner) => owner.startsWith('@') && owner.includes('/');
const readJson = (path, what) => {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { problem: `${what} is not readable JSON: ${e.message}` };
  }
};

/**
 * Valid approvals: per login the latest decisive review, which must be an APPROVED review by a human at headSha.
 * @returns {{valid:object[], ignored:Array<{login:string, why:string}>}}
 */
export function evaluateReviews(reviews, headSha) {
  const latest = new Map();
  const ignored = [];
  for (const r of reviews) {
    const login = r?.user?.login;
    if (typeof login !== 'string') continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue; // COMMENTED / PENDING are not decisions
    const key = login.toLowerCase();
    const prev = latest.get(key);
    if (!prev || String(r.submitted_at ?? '') >= String(prev.submitted_at ?? '')) latest.set(key, r);
  }
  const valid = [];
  for (const [login, r] of latest) {
    if (r.state !== 'APPROVED') ignored.push({ login, why: `latest decision is ${r.state}` });
    else if (r.user.type !== 'User') ignored.push({ login, why: `account type ${r.user.type} is not a human User` });
    else if (r.commit_id !== headSha) ignored.push({ login, why: `approval is for commit ${String(r.commit_id).slice(0, 12)}, not the head ${headSha.slice(0, 12)} (stale)` });
    else valid.push({ login: r.user.login, commit_id: r.commit_id, submitted_at: r.submitted_at ?? null });
  }
  return { valid, ignored };
}

function membersOf(teamMembers, owner) {
  const full = teamSlug(owner);
  const short = full.split('/').pop();
  const list = teamMembers[full] ?? teamMembers[short] ?? null;
  return list === null ? null : new Set(list.map((l) => String(l).toLowerCase()));
}

export async function run(ctx) {
  const skipped = skipOrNull(ctx, id);
  if (skipped) return skipped;
  const findings = [];
  const inputs = {};
  const fail = (msg) => result(id, 'fail', { summary: msg, findings: [error(msg)], inputs });

  const changedOpt = ctx.opts['changed-file'];
  if (typeof changedOpt !== 'string') return fail('--changed-file <path> is required');
  const changedPath = resolve(ctx.root, changedOpt);
  if (!existsSync(changedPath)) return fail(`changed-file list not found: ${changedOpt}`);
  inputs[inputLabel(ctx.root, changedPath)] = sha256File(changedPath);
  const changed = [...new Set(readFileSync(changedPath, 'utf8').split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))].sort();
  if (changed.length === 0 && ctx.release) findings.push(error('release build with an empty changed-file list (the list must prove what the release touches)'));

  const coPath = resolve(ctx.root, typeof ctx.opts.codeowners === 'string' ? ctx.opts.codeowners : '.github/CODEOWNERS');
  if (!existsSync(coPath)) return fail(`CODEOWNERS not found: ${inputLabel(ctx.root, coPath)}`);
  inputs[inputLabel(ctx.root, coPath)] = sha256File(coPath);
  const rules = parseCodeowners(readFileSync(coPath, 'utf8'));
  const slug = typeof ctx.opts['compliance-team'] === 'string' ? ctx.opts['compliance-team'] : 'compliance';

  const gated = [];
  for (const f of changed) {
    const hit = ownersOf(rules, f);
    if (!hit) {
      findings.push(info('changed file has no CODEOWNERS entry (not gated)', f));
      continue;
    }
    const teams = hit.owners.filter((o) => isTeam(o) && teamSlug(o).split('/').pop() === slug);
    if (teams.length) gated.push({ file: f, pattern: hit.pattern, teams });
  }

  let approvals = { head_sha: null, valid: [], ignored: [] };
  if (gated.length) {
    const reviewsOpt = ctx.opts.reviews;
    const membersOpt = ctx.opts['team-members'];
    const head = ctx.opts['head-sha'];
    if (typeof reviewsOpt !== 'string' || typeof membersOpt !== 'string' || typeof head !== 'string') {
      return result(id, 'fail', {
        summary: 'review inputs missing',
        findings: [...findings, error(`${gated.length} gated file(s) changed but --reviews, --team-members and --head-sha were not all provided`)],
        inputs,
      });
    }
    const reviewsFile = resolve(ctx.root, reviewsOpt);
    const membersFile = resolve(ctx.root, membersOpt);
    for (const [p, what] of [[reviewsFile, '--reviews'], [membersFile, '--team-members']]) {
      if (!existsSync(p)) return fail(`${what} file not found: ${inputLabel(ctx.root, p)}`);
      inputs[inputLabel(ctx.root, p)] = sha256File(p);
    }
    const rv = readJson(reviewsFile, '--reviews');
    const tm = readJson(membersFile, '--team-members');
    if (rv.problem || tm.problem) return fail(rv.problem ?? tm.problem);
    if (!Array.isArray(rv.value)) return fail('--reviews must be the JSON array returned by the GitHub "list reviews" API');
    if (tm.value === null || typeof tm.value !== 'object' || Array.isArray(tm.value) || !Object.values(tm.value).every(Array.isArray)) {
      return fail('--team-members must be a JSON object mapping team slug to an array of logins');
    }
    const ev = evaluateReviews(rv.value, head);
    const teamsOf = (login) => Object.keys(tm.value).filter((k) => tm.value[k].some((m) => String(m).toLowerCase() === login.toLowerCase()));
    approvals = { head_sha: head, valid: ev.valid.map((a) => ({ ...a, teams: teamsOf(a.login) })), ignored: ev.ignored };
    for (const g of gated) {
      const ok = ev.valid.filter((a) => g.teams.some((t) => membersOf(tm.value, t)?.has(a.login.toLowerCase())));
      if (ok.length === 0) {
        const why = ev.ignored.length ? ` (ignored: ${ev.ignored.map((i) => `${i.login}: ${i.why}`).join('; ')})` : '';
        const unknown = g.teams.filter((t) => membersOf(tm.value, t) === null);
        findings.push(
          error(`no valid approval from ${g.teams.join(' or ')} for gated path (CODEOWNERS ${g.pattern}); need APPROVED by a human team member on head ${head.slice(0, 12)}${unknown.length ? `; team membership unknown for ${unknown.join(', ')}` : ''}${why}`, g.file),
        );
        g.approved_by = [];
      } else g.approved_by = ok.map((a) => a.login);
    }
  } else {
    findings.push(info(changed.length ? 'no changed file is owned by the compliance team: no human sign-off required' : 'no changed files'));
  }

  const memberTeams = approvals.valid;
  const evidence = [
    writeJson(ctx.outDir, 'approvals.json', {
      head_sha: approvals.head_sha,
      compliance_team: slug,
      changed_files: changed.length,
      gated: gated.map((g) => ({ file: g.file, pattern: g.pattern, teams: g.teams, approved_by: g.approved_by ?? [] })),
      approvers: memberTeams,
      ignored_reviews: approvals.ignored,
    }),
  ];
  const status = statusFromFindings(findings);
  return result(id, status, {
    summary: `${gated.length} gated file(s) of ${changed.length} changed; ${approvals.valid.length} valid human approval(s)`,
    findings,
    evidence,
    metrics: { changed: changed.length, gated: gated.length, valid_approvals: approvals.valid.length },
    inputs,
  });
}
