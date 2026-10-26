import { describe, expect, it } from "vitest";
import {
  approach,
  clamp,
  isSettled,
  layerOffset,
  scrollTour,
  wrap,
  type ParallaxLayer,
} from "@/components/site/ambient/ambient-math";
import {
  DOTS_LAYER,
  FIELD_OVERHANG,
  HATCH_LAYER,
} from "@/components/site/ambient/ambient-tiles";

describe("approach (pointer smoothing)", () => {
  it("does not depend on the frame rate: two 8 ms steps equal one 16 ms step", () => {
    const once = approach(0, 100, 16, 110);
    const twice = approach(approach(0, 100, 8, 110), 100, 8, 110);
    expect(twice).toBeCloseTo(once, 9);
  });

  it("closes 1 - 1/e of the distance in one time constant and converges", () => {
    expect(approach(0, 100, 110, 110)).toBeCloseTo(100 * (1 - Math.exp(-1)), 9);
    let position = 0;
    for (let i = 0; i < 90; i += 1) position = approach(position, 100, 16, 110);
    expect(position).toBeGreaterThan(99.9);
    expect(position).toBeLessThanOrEqual(100);
  });

  it("never overshoots, stays put for zero or negative time, and jumps for a zero constant", () => {
    expect(approach(40, 100, 1e9, 110)).toBeLessThanOrEqual(100);
    expect(approach(40, 100, 0, 110)).toBe(40);
    expect(approach(40, 100, -50, 110)).toBe(40);
    expect(approach(40, 100, 16, 0)).toBe(100);
    expect(approach(100, 40, 16, 110)).toBeGreaterThanOrEqual(40);
  });
});

describe("isSettled, wrap, clamp", () => {
  it("settles within a quarter pixel on both axes", () => {
    expect(isSettled({ x: 10, y: 10 }, { x: 10.2, y: 9.9 })).toBe(true);
    expect(isSettled({ x: 10, y: 10 }, { x: 10.3, y: 10 })).toBe(false);
    expect(isSettled({ x: 10, y: 10 }, { x: 10, y: 11 })).toBe(false);
  });

  it("wraps negative values into [0, period)", () => {
    expect(wrap(-1, 104)).toBe(103);
    expect(wrap(104, 104)).toBe(0);
    expect(wrap(-208, 104)).toBe(0);
    expect(wrap(7, 104)).toBe(7);
  });

  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe("scrollTour (touch screens)", () => {
  it("stays inside the viewport for any scroll position and is deterministic", () => {
    for (let y = 0; y <= 40_000; y += 137) {
      const point = scrollTour(y, 360, 740);
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(360);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(740);
      expect(scrollTour(y, 360, 740)).toEqual(point);
    }
  });

  it("moves continuously: a one pixel scroll moves the reveal by far less than a pixel and a half", () => {
    for (let y = 0; y <= 5_000; y += 53) {
      const a = scrollTour(y, 1280, 800);
      const b = scrollTour(y + 1, 1280, 800);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1.5);
    }
  });
});

describe("layerOffset (parallax)", () => {
  const layers: [string, ParallaxLayer][] = [
    ["dots", DOTS_LAYER],
    ["hatch", HATCH_LAYER],
  ];

  it.each(layers)("%s: whole pixels, and never further than the overhang allows", (_name, layer) => {
    for (let scrollY = 0; scrollY <= 60_000; scrollY += 997) {
      for (const pointer of [
        { x: 0, y: 0 },
        { x: 3840, y: 2160 },
        { x: 640, y: 400 },
      ]) {
        const offset = layerOffset(layer, pointer, scrollY, 3840, 2160);
        expect(Number.isInteger(offset.x)).toBe(true);
        expect(Number.isInteger(offset.y)).toBe(true);
        expect(Math.abs(offset.x)).toBeLessThanOrEqual(FIELD_OVERHANG.x);
        expect(offset.y).toBeGreaterThanOrEqual(-FIELD_OVERHANG.y);
        expect(offset.y).toBeLessThanOrEqual(FIELD_OVERHANG.y);
      }
    }
  });

  it.each(layers)("%s: scrolling by a whole tile of travel returns to the same picture", (_name, layer) => {
    const pointer = { x: 500, y: 300 };
    const start = 700;
    // Climbing `tileHeight` pixels takes `tileHeight / scroll` pixels of page scroll.
    const periodic = start + layer.tileHeight / layer.scroll;
    const a = layerOffset(layer, pointer, start, 1280, 800);
    const b = layerOffset(layer, pointer, periodic, 1280, 800);
    expect(b.x).toBe(a.x);
    expect(Math.abs(b.y - a.y) % layer.tileHeight).toBeLessThanOrEqual(1);
  });

  it("moves the two layers in opposite directions with the pointer, which is what makes them slide over each other", () => {
    const left = { x: 200, y: 400 };
    const right = { x: 1080, y: 400 };
    const dots = layerOffset(DOTS_LAYER, right, 0, 1280, 800).x - layerOffset(DOTS_LAYER, left, 0, 1280, 800).x;
    const hatch = layerOffset(HATCH_LAYER, right, 0, 1280, 800).x - layerOffset(HATCH_LAYER, left, 0, 1280, 800).x;
    expect(dots).toBeGreaterThan(0);
    expect(hatch).toBeLessThan(0);
  });
});
