import { describe, expect, it } from "vitest";
import {
  GLYPH_COLS,
  GLYPH_ROWS,
  LETTER_GAP_COLS,
  WORDMARK,
  cellsPath,
  dotsPath,
  glyphCells,
  hatchTilePath,
  layoutWord,
  wordSize,
  wordmarkSize,
  type WordmarkLetter,
} from "@/components/brand/wordmark-geometry";

const letters = [...WORDMARK] as WordmarkLetter[];

describe("glyph bitmaps", () => {
  it("keeps every cell of every letter inside its 5 x 7 box, without duplicates", () => {
    for (const letter of letters) {
      const cells = glyphCells(letter);
      const keys = new Set(cells.map(({ col, row }) => `${col}:${row}`));
      expect(keys.size).toBe(cells.length);
      for (const { col, row } of cells) {
        expect(col).toBeGreaterThanOrEqual(0);
        expect(col).toBeLessThan(GLYPH_COLS);
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(GLYPH_ROWS);
      }
    }
  });

  it("gives all five letters different shapes, so the word can be told apart letter by letter", () => {
    const shapes = letters.map((letter) =>
      glyphCells(letter)
        .map(({ col, row }) => `${col}:${row}`)
        .join(","),
    );
    expect(new Set(shapes).size).toBe(letters.length);
  });

  it("draws the letters whose shape is known: O is symmetric, E has full top and bottom bars, N has full side bars", () => {
    const has = (letter: WordmarkLetter, col: number, row: number) =>
      glyphCells(letter).some((cell) => cell.col === col && cell.row === row);
    for (let col = 0; col < GLYPH_COLS; col += 1) {
      for (let row = 0; row < GLYPH_ROWS; row += 1) {
        expect(has("O", col, row)).toBe(has("O", GLYPH_COLS - 1 - col, row));
        expect(has("O", col, row)).toBe(has("O", col, GLYPH_ROWS - 1 - row));
      }
    }
    for (let col = 0; col < GLYPH_COLS; col += 1) {
      expect(has("E", col, 0)).toBe(true);
      expect(has("E", col, GLYPH_ROWS - 1)).toBe(true);
    }
    for (let row = 0; row < GLYPH_ROWS; row += 1) {
      expect(has("N", 0, row)).toBe(true);
      expect(has("N", GLYPH_COLS - 1, row)).toBe(true);
    }
  });
});

describe("layoutWord", () => {
  it("advances one glyph plus the gap per letter and keeps each letter in its own columns", () => {
    const layout = layoutWord(WORDMARK);
    expect(layout.cols).toBe(letters.length * GLYPH_COLS + (letters.length - 1) * LETTER_GAP_COLS);
    expect(layout.rows).toBe(GLYPH_ROWS);
    expect(layout.cells.length).toBe(letters.reduce((sum, letter) => sum + glyphCells(letter).length, 0));
    const advance = GLYPH_COLS + LETTER_GAP_COLS;
    for (const { col } of layout.cells) {
      // Never in a gap column.
      expect(col % advance).toBeLessThan(GLYPH_COLS);
      expect(col).toBeLessThan(layout.cols);
    }
  });

  it("is empty for the empty string and refuses a character without a glyph", () => {
    expect(layoutWord("")).toEqual({ cells: [], cols: 0, rows: 0 });
    expect(() => layoutWord("RECOX")).toThrow(RangeError);
    expect(() => layoutWord("toString")).toThrow(RangeError);
  });

  it("sizes a word and a word with its mark", () => {
    const layout = layoutWord(WORDMARK);
    expect(wordSize(layout, 4)).toEqual({ width: layout.cols * 4, height: GLYPH_ROWS * 4 });
    const plain = wordmarkSize(WORDMARK, 5, false);
    const marked = wordmarkSize(WORDMARK, 5, true);
    expect(plain).toEqual({ width: layout.cols * 5, height: GLYPH_ROWS * 5 });
    // The mark is square, as tall as the word, and stands three cells before it.
    expect(marked.width - plain.width).toBe(plain.height + 3 * 5);
    expect(marked.height).toBe(plain.height);
  });
});

describe("path data", () => {
  const layout = layoutWord(WORDMARK);

  it("draws exactly one dot per cell, each inside its own cell", () => {
    const pitch = 4;
    const radius = 0.95;
    const path = dotsPath(layout, { pitch, radius, x: 10, y: 12 });
    const dots = [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)a/g)];
    expect(dots).toHaveLength(layout.cells.length);
    dots.forEach((match, index) => {
      const cell = layout.cells[index]!;
      const cx = Number(match[1]) + radius;
      const cy = Number(match[2]);
      expect(cx).toBeCloseTo(10 + cell.col * pitch + pitch / 2, 1);
      expect(cy).toBeCloseTo(12 + cell.row * pitch + pitch / 2, 1);
    });
  });

  it("insets each cell square by the gap, so neighbours never touch", () => {
    const pitch = 7;
    const gap = 0.7;
    const path = cellsPath(layout, { pitch, gap, x: 48, y: 52 });
    const squares = [...path.matchAll(/M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)z/g)];
    expect(squares).toHaveLength(layout.cells.length);
    squares.forEach((match, index) => {
      const cell = layout.cells[index]!;
      const side = pitch - gap * 2;
      expect(Number(match[1])).toBeCloseTo(48 + cell.col * pitch + gap, 5);
      expect(Number(match[2])).toBeCloseTo(52 + cell.row * pitch + gap, 5);
      expect(Number(match[3])).toBeCloseTo(side, 5);
      expect(Number(match[4])).toBeCloseTo(side, 5);
      expect(Number(match[5])).toBeCloseTo(-side, 5);
    });
  });

  it("fills the whole cell when the gap is zero", () => {
    const path = cellsPath(layoutWord("O"), { pitch: 6 });
    expect(path.startsWith("M6 0h6v6h-6z")).toBe(true);
  });

  it("repeats the hatch line across the tile edges so the stroke is continuous", () => {
    expect(hatchTilePath(3)).toBe("M-1 1l2-2M0 3L3 0M2 4l2-2");
    expect(hatchTilePath(4.5)).toBe("M-1 1l2-2M0 4.5L4.5 0M3.5 5.5l2-2");
  });
});
