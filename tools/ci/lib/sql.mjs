// Minimal PostgreSQL text scanner for the migration lint: masks comments, string literals and dollar-quoted bodies (so
// keywords inside them never match), then splits into statements. Masked characters become spaces (newlines are kept), so
// offsets and line numbers of the masked text equal those of the original.

const isIdentStart = (c) => /[A-Za-z_\u0080-\uffff]/.test(c);
const isIdentChar = (c) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

export function maskSql(sql) {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === "'") {
      // E'...' strings treat backslash as an escape; plain strings only double the quote.
      const escape = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !isIdentChar(sql[i - 2]));
      let j = i + 1;
      while (j < n) {
        if (escape && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(i + 1, Math.min(j, n));
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      // quoted identifiers stay visible, but a `;` inside must not split statements
      for (let k = i + 1; k < Math.min(j, n); k++) if (out[k] === ';') out[k] = '_';
      i = j + 1;
    } else if (c === '$' && (i === 0 || !isIdentChar(sql[i - 1]))) {
      let j = i + 1;
      if (j < n && isIdentStart(sql[j])) while (j < n && isIdentChar(sql[j]) && sql[j] !== '$') j++;
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        const stop = end === -1 ? n : end;
        blank(j + 1, stop);
        i = end === -1 ? n : end + tag.length;
      } else i++;
    } else i++;
  }
  return out.join('');
}

/** Statements of the masked text: [{ text, line }] (text is masked, whitespace collapsed; line = 1-based start line). */
export function splitStatements(masked) {
  const out = [];
  let start = 0;
  const push = (end) => {
    const raw = masked.slice(start, end);
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text !== '') {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text, line: masked.slice(0, start + lead).split('\n').length });
    }
  };
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ';') {
      push(i);
      start = i + 1;
    }
  }
  push(masked.length);
  return out;
}
