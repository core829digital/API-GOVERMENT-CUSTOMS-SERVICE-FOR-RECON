#!/usr/bin/env node
// Collects the inputs of gate L11 (required human sign-off) from the GitHub REST API; the gate itself does no network access.
//
//   node tools/ci/collect-approvals.mjs --out-dir DIR [--codeowners .github/CODEOWNERS] [--api-url https://api.github.com]
//
// Environment: GITHUB_REPOSITORY (owner/repo), GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_EVENT_PATH (event payload),
//              GITHUB_TOKEN        repo read (pull-requests: read) for PR and review lookups              [required]
//              TEAM_READ_TOKEN     token with the organisation permission "Members: read" (GITHUB_TOKEN CANNOT read org team
//                                  members). Without it team lookups fail, the team map stays empty and L11 fails closed for
//                                  any change to a gated path.
// Writes DIR/reviews.json (GET /repos/{o}/{r}/pulls/{n}/reviews, all pages, as returned: user.login, user.type, state,
// commit_id, submitted_at), DIR/team-members.json ({"<org>/<team>": [logins]} for every @org/team named in CODEOWNERS) and,
// to $GITHUB_OUTPUT, `head_sha=` (the PR head the approvals must refer to) and `pr=` (number or empty).
// PR lookup: pull_request events use the event's PR; push events use GET /repos/{o}/{r}/commits/{sha}/pulls (a squash merge
// has exactly one PR). No PR found => reviews.json is [] (approvals cannot exist) and head_sha = GITHUB_SHA.
// Exit: 0 ok, 1 API failure on a required lookup, 2 usage error.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, requireString, runMain, UsageError } from './lib/common.mjs';

async function api(base, token, path) {
  const out = [];
  let url = path.startsWith('http') ? path : `${base}${path}`;
  for (let page = 0; url && page < 50; page++) {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}`, 'user-agent': 'recon-ci' },
    });
    if (!res.ok) {
      const err = new Error(`GET ${url} -> HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (Array.isArray(body)) out.push(...body);
    else return body;
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
    url = next ? next[1] : null;
  }
  return out;
}

export function codeownersTeams(text) {
  const teams = new Set();
  for (const line of text.split(/\r?\n/)) {
    const body = line.replace(/#.*$/, '');
    for (const m of body.matchAll(/(?<![\w@])@([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) teams.add(`${m[1]}/${m[2]}`);
  }
  return [...teams].sort();
}

export async function collect({ apiUrl, repo, eventName, sha, payload, token, teamToken, codeownersText }) {
  let pr = null;
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    pr = { number: payload.pull_request.number, head: payload.pull_request.head.sha };
  } else {
    const prs = await api(apiUrl, token, `/repos/${repo}/commits/${sha}/pulls?per_page=100`);
    const merged = prs.find((p) => p.merge_commit_sha === sha) ?? prs.find((p) => p.merged_at) ?? null;
    if (merged) pr = { number: merged.number, head: merged.head.sha };
  }
  const reviews = pr ? await api(apiUrl, token, `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`) : [];
  const members = {};
  const warnings = [];
  for (const team of codeownersTeams(codeownersText)) {
    const [org, slug] = team.split('/');
    try {
      const list = await api(apiUrl, teamToken ?? token, `/orgs/${org}/teams/${slug}/members?per_page=100`);
      members[team] = list.map((u) => u.login).sort();
    } catch (e) {
      warnings.push(`cannot list members of ${team}: ${e.message}${teamToken ? '' : ' (TEAM_READ_TOKEN not set; GITHUB_TOKEN cannot read organisation teams)'}`);
    }
  }
  return { reviews, members, warnings, pr, headSha: pr ? pr.head : sha };
}

runMain(import.meta.url, async (argv) => {
  const { opts } = parseArgs(argv);
  const outDir = requireString(opts, 'out-dir');
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UsageError('GITHUB_REPOSITORY must be owner/repo');
  if (!token) throw new UsageError('GITHUB_TOKEN is required');
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const codeownersText = readFileSync(typeof opts.codeowners === 'string' ? opts.codeowners : '.github/CODEOWNERS', 'utf8');
  const r = await collect({
    apiUrl: typeof opts['api-url'] === 'string' ? opts['api-url'] : 'https://api.github.com',
    repo,
    eventName: process.env.GITHUB_EVENT_NAME,
    sha: process.env.GITHUB_SHA,
    payload,
    token,
    teamToken: process.env.TEAM_READ_TOKEN || undefined,
    codeownersText,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'reviews.json'), `${JSON.stringify(r.reviews, null, 2)}\n`);
  writeFileSync(join(outDir, 'team-members.json'), `${JSON.stringify(r.members, null, 2)}\n`);
  for (const w of r.warnings) console.log(`::warning::${w}`);
  console.log(`collect-approvals: PR ${r.pr ? `#${r.pr.number}` : '(none found)'}, ${r.reviews.length} review(s), ${Object.keys(r.members).length} team(s), head ${r.headSha}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `head_sha=${r.headSha}\npr=${r.pr ? r.pr.number : ''}\n`);
  return 0;
});
