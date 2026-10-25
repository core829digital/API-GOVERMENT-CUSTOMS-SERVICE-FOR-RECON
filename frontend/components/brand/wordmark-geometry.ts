/**
 * The wordmark as geometry: a 5 x 7 bitmap per letter, turned into SVG path data that a pattern can fill. Pure
 * functions, no DOM and no React, so the same letters can be drawn as a dot matrix (the dot grid of the logo's
 * second source) or as cells filled with the logo's diagonal hatch (its first source), at any size, in any
 * tile. `pattern-wordmark.tsx` wraps them in an inline `<svg>`; the ambient layer tiles them.
 *
 * Only the letters of the product name exist here. Adding a letter means adding five-by-seven rows below.
 */

export const GLYPH_COLS = 5;
export const GLYPH_ROWS = 7;

const GLYPHS = {
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  C: [".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX."],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
} as const;

export type WordmarkLetter = keyof typeof GLYPHS;

/** The letters the module can draw, in the order of the product name. */
export const WORDMARK = "RECON" as const;

/** Blank columns between two letters. */
export const LETTER_GAP_COLS = 2;

export type Cell = { readonly col: number; readonly row: number };

export type WordLayout = {
  readonly cells: readonly Cell[];
  readonly cols: number;
  readonly rows: number;
};

function isLetter(char: string): char is WordmarkLetter {
  return Object.hasOwn(GLYPHS, char);
}

/** The filled cells of one letter, row-major. */
export function glyphCells(letter: WordmarkLetter): Cell[] {
  const cells: Cell[] = [];
  GLYPHS[letter].forEach((line, row) => {
    for (let col = 0; col < GLYPH_COLS; col += 1) {
      if (line[col] === "X") cells.push({ col, row });
    }
  });
  return cells;
}

/** Lays `text` out on one baseline. Throws on a character without a glyph: callers pass constants, not input. */
export function layoutWord(text: string, gapCols: number = LETTER_GAP_COLS): WordLayout {
  const cells: Cell[] = [];
  let offset = 0;
  for (const char of text) {
    if (!isLetter(char)) throw new RangeError(`no glyph for "${char}"`);
    for (const cell of glyphCells(char)) cells.push({ col: cell.col + offset, row: cell.row });
    offset += GLYPH_COLS + gapCols;
  }
  const cols = text.length === 0 ? 0 : offset - gapCols;
  return { cells, cols, rows: text.length === 0 ? 0 : GLYPH_ROWS };
}

/** Pixel size of a laid-out word at `pitch` units per cell. */
export function wordSize(layout: WordLayout, pitch: number): { width: number; height: number } {
  return { width: layout.cols * pitch, height: layout.rows * pitch };
}

/** Rounds to two decimals and drops trailing zeros, so path data stays short and stable. */
export function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * One filled dot per cell, centred in its cell. Every dot is two arcs of one compound path, so a whole word is a
 * single `<path>` however many dots it has.
 */
export function dotsPath(
  layout: WordLayout,
  { pitch, radius, x = 0, y = 0 }: { pitch: number; radius: number; x?: number; y?: number },
): string {
  const diameter = radius * 2;
  return layout.cells
    .map(({ col, row }) => {
      const cx = x + col * pitch + pitch / 2;
      const cy = y + row * pitch + pitch / 2;
      return `M${num(cx - radius)} ${num(cy)}a${num(radius)} ${num(radius)} 0 1 0 ${num(diameter)} 0a${num(radius)} ${num(radius)} 0 1 0 ${num(-diameter)} 0z`;
    })
    .join("");
}

/**
 * One square per cell, `gap` units smaller than the pitch on each side. With `gap = 0` neighbouring cells touch
 * and the letter is a solid shape; with a gap the letter reads as filled ledger cells.
 */
export function cellsPath(
  layout: WordLayout,
  { pitch, gap = 0, x = 0, y = 0 }: { pitch: number; gap?: number; x?: number; y?: number },
): string {
  const side = pitch - gap * 2;
  return layout.cells
    .map(({ col, row }) => `M${num(x + col * pitch + gap)} ${num(y + row * pitch + gap)}h${num(side)}v${num(side)}h${num(-side)}z`)
    .join("");
}

/**
 * Path data of the diagonal hatch that fills a pattern tile of `period` units: one line rising to the right,
 * drawn as three segments so the stroke continues seamlessly across the tile edges.
 */
export function hatchTilePath(period: number): string {
  const p = num(period);
  return `M-1 1l2-2M0 ${p}L${p} 0M${num(period - 1)} ${num(period + 1)}l2-2`;
}

/** The two-square mark's geometry, in the logo's 32-unit box. The overlap is the small filled square. */
export const MARK_BOX = 32;
export const MARK_SQUARES = {
  books: { x: 2, y: 2, size: 18 },
  authority: { x: 12, y: 12, size: 18 },
  overlap: { x: 12, y: 12, size: 8 },
} as const;

/** The mark is as tall as the word and stands this many cells before it. */
export const MARK_GAP_CELLS = 3;

/** Pixel size of the whole drawing: the word, plus the two-square mark and its gap when `mark` is set. */
export function wordmarkSize(text: string, pitch: number, mark: boolean): { width: number; height: number } {
  const word = wordSize(layoutWord(text), pitch);
  return { width: (mark ? word.height + MARK_GAP_CELLS * pitch : 0) + word.width, height: word.height };
}
