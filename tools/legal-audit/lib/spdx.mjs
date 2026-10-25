// SPDX licence expressions (SPDX spec Annex D): parse and evaluate against an allowlist.
//   expression := term ( "OR" term )*       lowest precedence
//   term       := factor ( "AND" factor )*
//   factor     := "(" expression ")" | id [ "+" ] [ "WITH" exception ]
// Operators are upper case as the specification requires; anything else is a syntax error (npm metadata that says
// "MIT or Apache-2.0" is NOT a valid expression and must be rejected rather than guessed at).

export class SpdxError extends Error {}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(\(|\)|[A-Za-z0-9.\-+:_]+)/y;
  let pos = 0;
  const s = src.trim();
  if (s === '') throw new SpdxError('empty licence expression');
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new SpdxError(`unexpected character "${s[pos]}" in "${src}"`);
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

/**
 * @returns {object} AST: {op:'id', id, orLater, exception?} | {op:'AND'|'OR', left, right}
 * @throws {SpdxError}
 */
export function parseSpdx(src) {
  if (typeof src !== 'string') throw new SpdxError('licence expression is not a string');
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseOr() {
    let left = parseAnd();
    while (peek() === 'OR') {
      next();
      left = { op: 'OR', left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseFactor();
    while (peek() === 'AND') {
      next();
      left = { op: 'AND', left, right: parseFactor() };
    }
    return left;
  }
  function parseFactor() {
    const t = next();
    if (t === undefined) throw new SpdxError(`unexpected end of expression "${src}"`);
    if (t === '(') {
      const inner = parseOr();
      if (next() !== ')') throw new SpdxError(`missing ")" in "${src}"`);
      return inner;
    }
    if (t === ')' || t === 'AND' || t === 'OR' || t === 'WITH') throw new SpdxError(`unexpected "${t}" in "${src}"`);
    if (!/^[A-Za-z0-9][A-Za-z0-9.\-:_]*\+?$/.test(t)) throw new SpdxError(`invalid licence identifier "${t}" in "${src}"`);
    const orLater = t.endsWith('+');
    const node = { op: 'id', id: orLater ? t.slice(0, -1) : t, orLater };
    if (peek() === 'WITH') {
      next();
      const ex = next();
      if (ex === undefined || !/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(ex) || ['AND', 'OR', 'WITH'].includes(ex)) {
        throw new SpdxError(`invalid licence exception after WITH in "${src}"`);
      }
      node.exception = ex;
    }
    return node;
  }

  const ast = parseOr();
  if (i < tokens.length) throw new SpdxError(`unexpected "${tokens[i]}" in "${src}"`);
  return ast;
}

/** Every identifier mentioned in the AST (for inventories). */
export function spdxIds(ast) {
  if (ast.op === 'id') return [ast.exception ? `${ast.id} WITH ${ast.exception}` : ast.id];
  return [...spdxIds(ast.left), ...spdxIds(ast.right)];
}

/**
 * Evaluate an expression against a policy.
 * @param {string} expression
 * @param {{allow: Iterable<string>, exceptions?: Iterable<string>}} policy  identifiers compared case-insensitively
 * @returns {{ok: boolean, disallowed: string[], error?: string}} `disallowed` lists the identifiers that made an AND /
 *          single term fail (for OR only when no alternative is allowed)
 */
export function evaluateSpdx(expression, policy) {
  const allow = new Set([...policy.allow].map((s) => s.toLowerCase()));
  const exceptions = new Set([...(policy.exceptions ?? [])].map((s) => s.toLowerCase()));
  let ast;
  try {
    ast = parseSpdx(expression);
  } catch (e) {
    if (e instanceof SpdxError) return { ok: false, disallowed: [], error: e.message };
    throw e;
  }
  const check = (n) => {
    if (n.op === 'id') {
      const base = allow.has(n.id.toLowerCase());
      const ex = n.exception === undefined || exceptions.has(n.exception.toLowerCase());
      if (base && ex) return { ok: true, bad: [] };
      return { ok: false, bad: [n.exception !== undefined && base ? `${n.id} WITH ${n.exception}` : n.id] };
    }
    const l = check(n.left);
    const r = check(n.right);
    if (n.op === 'AND') return { ok: l.ok && r.ok, bad: [...l.bad, ...r.bad] };
    return l.ok || r.ok ? { ok: true, bad: [] } : { ok: false, bad: [...l.bad, ...r.bad] };
  };
  const res = check(ast);
  return { ok: res.ok, disallowed: [...new Set(res.bad)] };
}

/** True when `expression` is syntactically a valid SPDX licence expression. */
export function isSpdxExpression(expression) {
  try {
    parseSpdx(expression);
    return true;
  } catch (e) {
    if (e instanceof SpdxError) return false;
    throw e;
  }
}
