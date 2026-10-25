#!/usr/bin/env node
// Legal-audit CLI.
//   node tools/legal-audit/cli.mjs gate <L1..L12> [--release] [--out DIR] [--root DIR] [--today YYYY-MM-DD] [gate options]
//   node tools/legal-audit/cli.mjs plan --base SHA --head SHA [--release] [--out DIR]   (path-filter plan)
// Writes <out>/<GATE>.json and prints a one-line summary plus findings. Exit 0 for pass/warn/skip, 1 for fail,
// 2 for usage errors. Default out dir: <root>/dist/legal-audit.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { writeJson } from './lib/result.mjs';

export const GATE_IDS = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);

export function makeCtx(opts) {
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  const now = typeof opts.today === 'string' ? new Date(`${opts.today}T00:00:00Z`) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --today ${opts.today}`);
  const outDir = resolve(typeof opts.out === 'string' ? opts.out : join(root, 'dist', 'legal-audit'));
  return { root, now, release: opts.release === true || opts.release === 'true', outDir, opts, log: (m) => console.log(m) };
}

export async function runGate(id, ctx) {
  const mod = await import(`./gates/${id.toLowerCase()}.mjs`);
  const res = await mod.run(ctx);
  writeJson(ctx.outDir, `${id}.json`, res);
  return res;
}

export function render(res) {
  const lines = [`${res.gate} ${res.status.toUpperCase()}${res.summary ? ` - ${res.summary}` : ''}`];
  if (res.skip_reason) lines.push(`  skipped: ${res.skip_reason}`);
  for (const f of res.findings) if (f.severity !== 'info') lines.push(`  [${f.severity}] ${f.subject ? `${f.subject}: ` : ''}${f.message}`);
  return lines.join('\n');
}

async function main(argv) {
  const { opts, _ } = parseArgs(argv);
  const [cmd, gate] = _;
  const ctx = makeCtx(opts);
  if (cmd === 'gate' && GATE_IDS.includes(gate)) {
    const res = await runGate(gate, ctx);
    console.log(render(res));
    return res.status === 'fail' ? 1 : 0;
  }
  if (cmd === 'plan') {
    const { planMain } = await import('./lib/plan.mjs');
    return planMain(ctx);
  }
  console.error('usage: cli.mjs gate <L1..L12> [--release] [--out DIR] [--root DIR] [--today YYYY-MM-DD] | plan --base SHA --head SHA');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e.stack ?? e}`);
      process.exit(1);
    },
  );
}
