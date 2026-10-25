import {
  WORDMARK,
  cellsPath,
  dotsPath,
  layoutWord,
  wordmarkSize,
} from "@/components/brand/wordmark-geometry";
import type { ParallaxLayer } from "@/components/site/ambient/ambient-math";

/*
 * Geometry of the ambient layer's pattern tiles. Everything here is computed once, when the module is first
 * imported, and is plain strings and numbers: the layer renders them as `<pattern>` fills.
 *
 *   rest   a registration cross every 96 px; the only thing visible when nothing is being revealed.
 *   dots   RECON as a dot matrix: the authority's copy.
 *   hatch  RECON as solid letters filled with the logo's diagonal hatch: the books.
 *
 * The two word tiles are the same drawing in two techniques, laid out identically, and they move at different
 * rates (opposite directions with the pointer, different speeds with the scroll). Where they are in register
 * the dots sit inside the hatched strokes and the letters are complete; away from that the copies disagree and
 * the letters ghost apart, the way a misregistered print does. Hatch lines (3.2 px) against the dot lattice
 * (5 px) also beat against each other, a moire that crawls across a letter as the layers slide.
 */

const word = layoutWord(WORDMARK);

export const REST_TILE = 96;
/** A plus sign centred in the tile, one pixel thick, so its lines land on whole device pixels at 1x. */
export const REST_PATH = "M43 48h11v1h-11zM48 43h1v11h-1z";

/** Both word tiles: two words in a brick layout, 5 px per cell, so a word is 165 x 35 px. */
export const WORD_TILE = { width: 360, height: 150 } as const;
const WORD_PITCH = 5;
const WORD_ORIGINS = [
  { x: 10, y: 15 },
  { x: 185, y: 90 },
] as const;

export const DOTS_PATH = WORD_ORIGINS.map((o) => dotsPath(word, { pitch: WORD_PITCH, radius: 1.2, ...o })).join("");
export const HATCH_PATH = WORD_ORIGINS.map((o) => cellsPath(word, { pitch: WORD_PITCH, ...o })).join("");
/** Horizontal distance between hatch lines. */
export const HATCH_PERIOD = 3.2;

/** The one clear instance beside the pointer: mark and word, the two sources in register. */
export const SPECIMEN_PITCH = 4;
export const SPECIMEN_PADDING = { x: 14, y: 11 } as const;
const specimenArt = wordmarkSize(WORDMARK, SPECIMEN_PITCH, true);
/** Outer size of the plate that holds it. */
export const SPECIMEN_SIZE = {
  width: specimenArt.width + SPECIMEN_PADDING.x * 2,
  height: specimenArt.height + SPECIMEN_PADDING.y * 2,
} as const;

/** How far a pattern field overhangs the viewport on each side, so shifting it never shows an edge. */
export const FIELD_OVERHANG = { x: 400, y: 240 } as const;

/** Diameter of the reveal, wide and narrow viewports. */
export const REVEAL_DIAMETER = { wide: 560, narrow: 380 } as const;
export const NARROW_VIEWPORT = 640;

export const DOTS_LAYER: ParallaxLayer = {
  pointerX: 0.04,
  pointerY: 0.035,
  scroll: 0.04,
  tileHeight: WORD_TILE.height,
  limitX: 300,
  limitY: 80,
};

export const HATCH_LAYER: ParallaxLayer = {
  pointerX: -0.05,
  pointerY: -0.045,
  scroll: 0.1,
  tileHeight: WORD_TILE.height,
  limitX: 300,
  limitY: 80,
};
