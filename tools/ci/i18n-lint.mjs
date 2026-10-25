#!/usr/bin/env node
// i18n hard-coded string lint (Workflow.md §3 `frontend`: "i18n string lint"; messages come from next-intl).
//
//   node tools/ci/i18n-lint.mjs [--root DIR] [--ts-from DIR] [dir ...]      default dirs: frontend/app frontend/components
//
// Flags user-visible string literals that are not routed through next-intl (`t("key")`) in *.tsx / *.jsx files:
//   * JSX text:               <p>Hello</p>                      (text containing a letter; entities such as &middot; and
//                                                                punctuation/digits/symbol-only text are fine)
//   * JSX expression child:   <p>{"Hello"}</p>, {ok ? "Yes" : "No"}, {`Page ${n}`}  (string / template literal with a letter)
//   * UI attributes:          aria-label, aria-description, aria-placeholder, aria-roledescription, aria-valuetext,
//                             placeholder, title, alt  given a string literal (also inside ?:, ||, ??, &&, + operands)
//   * the same names as object properties: { "aria-label": "Foo" }, { title: "Foo" } (props spread, Metadata)
// Not flagged: anything produced by a call (t("x")), identifiers, className/other attributes, empty strings (alt="").
// Not covered (known limit): strings that reach the UI through data tables defined elsewhere (e.g. `{ label: "Foo" }`).
// Suppress a deliberate literal with a comment containing `i18n-ignore: <reason>` on the same or the previous line.
//
// The check parses with the TypeScript compiler API (exact AST, no regex guessing). It uses the `typescript` package that
// frontend/package.json already pins (devDependency); tools/ci itself has no dependencies. If `typescript` cannot be
// resolved the lint FAILS (exit 2), it never passes silently. Exit: 0 clean, 1 findings, 2 usage/environment error.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding, parseArgs, report, runMain, UsageError } from './lib/common.mjs';

const UI_ATTRS = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'placeholder', 'title', 'alt']);
const SKIP_ELEMENTS = new Set(['style', 'script']);
const HAS_LETTER = /\p{L}/u;
const ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

export function loadTypescript(root, tsFrom) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [tsFrom, join(root, 'frontend'), join(here, '..', '..', 'frontend')].filter((d) => typeof d === 'string');
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    try {
      return createRequire(join(resolve(dir), 'package.json'))('typescript');
    } catch {
      // try the next candidate
    }
  }
  throw new UsageError(`cannot resolve the "typescript" package from ${candidates.join(' or ')}: run \`npm ci\` in frontend/ first`);
}

function collectLiterals(ts, expr) {
  const out = [];
  const visit = (e) => {
    if (!e) return;
    switch (e.kind) {
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.NonNullExpression:
        visit(e.expression);
        break;
      case ts.SyntaxKind.ConditionalExpression:
        visit(e.whenTrue);
        visit(e.whenFalse);
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = e.operatorToken.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
          visit(e.left);
          visit(e.right);
        } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) visit(e.right);
        break;
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        if (HAS_LETTER.test(e.text)) out.push(e);
        break;
      case ts.SyntaxKind.TemplateExpression:
        if ([e.head, ...e.templateSpans.map((s) => s.literal)].some((p) => HAS_LETTER.test(p.text))) out.push(e);
        break;
      default:
        break;
    }
  };
  visit(expr);
  return out;
}

const nameText = (ts, n) => {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  if (ts.isJsxNamespacedName?.(n)) return `${n.namespace.text}:${n.name.text}`;
  return null;
};

/** Findings for one source text. `rel` is only used for reporting. */
export function lintSource(ts, rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX);
  const lines = text.split(/\r?\n/);
  const out = [];
  const suppressed = (line) => [line, line - 1].some((l) => l >= 1 && /i18n-ignore:\s*\S/.test(lines[l - 1] ?? ''));
  const add = (offset, message) => {
    const line = sf.getLineAndCharacterOfPosition(offset).line + 1;
    if (!suppressed(line)) out.push(finding(rel, message, line));
  };
  const inSkipped = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && SKIP_ELEMENTS.has(p.openingElement.tagName.getText(sf))) return true;
    }
    return false;
  };
  const flagLiterals = (expr, what) => {
    for (const lit of collectLiterals(ts, expr)) {
      const shown = (lit.text ?? lit.getText(sf)).replace(/\s+/g, ' ').slice(0, 40);
      add(lit.getStart(sf), `${what} "${shown}" is a hard-coded string: route it through next-intl (t("key")) and add it to messages/*.json`);
    }
  };

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      const stripped = node.text.replace(ENTITY, ' ');
      if (HAS_LETTER.test(stripped) && !inSkipped(node)) {
        const lead = node.text.length - node.text.trimStart().length;
        add(node.getStart(sf) + lead, `JSX text "${node.text.trim().replace(/\s+/g, ' ').slice(0, 40)}" is hard-coded: route it through next-intl (t("key"))`);
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = nameText(ts, node.name);
      if (name && UI_ATTRS.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) flagLiterals(node.initializer, `attribute ${name}=`);
        else if (ts.isJsxExpression(node.initializer)) flagLiterals(node.initializer.expression, `attribute ${name}=`);
      }
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      if (!inSkipped(node)) flagLiterals(node.expression, 'JSX child');
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameText(ts, node.name);
      if (name && UI_ATTRS.has(name)) flagLiterals(node.initializer, `property ${name}:`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(?:tsx|jsx)$/.test(e.name) && !/\.(?:test|spec)\.[tj]sx$/.test(e.name)) yield p;
  }
}

export function lintTree({ root, dirs, tsFrom }) {
  const ts = loadTypescript(root, tsFrom);
  const findings = [];
  let files = 0;
  for (const d of dirs) {
    const abs = join(root, d);
    if (!existsSync(abs)) throw new UsageError(`directory not found: ${d}`);
    for (const file of walk(abs)) {
      files++;
      const rel = file.slice(root.length + 1).replaceAll('\\', '/');
      findings.push(...lintSource(ts, rel, readFileSync(file, 'utf8')));
    }
  }
  return { findings, files };
}

runMain(import.meta.url, (argv) => {
  const { opts, _ } = parseArgs(argv);
  const root = resolve(typeof opts.root === 'string' ? opts.root : process.cwd());
  const dirs = _.length > 0 ? _ : ['frontend/app', 'frontend/components'];
  const { findings, files } = lintTree({ root, dirs, tsFrom: typeof opts['ts-from'] === 'string' ? opts['ts-from'] : undefined });
  return report('i18n-lint', findings, [`${files} file(s) scanned in ${dirs.join(', ')}`]);
});
