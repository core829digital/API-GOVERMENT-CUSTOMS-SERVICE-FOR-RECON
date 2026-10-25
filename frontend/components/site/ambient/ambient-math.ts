/**
 * The arithmetic behind the ambient background layer. Pure functions, no DOM: the controller feeds them
 * pointer and scroll positions and writes the integers they return into CSS custom properties.
 */

export type Point = { readonly x: number; readonly y: number };

/**
 * One step of exponential smoothing, independent of the frame rate: after `tauMs` the remaining distance to
 * `target` has shrunk to 1/e. `dtMs` is clamped to zero from below so a clock that steps back cannot overshoot.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return target;
  const factor = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return current + (target - current) * factor;
}

/** True when both coordinates are within `epsilon` pixels of the target, so the frame loop can stop. */
export function isSettled(current: Point, target: Point, epsilon = 0.25): boolean {
  return Math.abs(current.x - target.x) <= epsilon && Math.abs(current.y - target.y) <= epsilon;
}

/** Remainder in `[0, period)`, also for negative values. */
export function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Where the reveal sits on a touch screen: a slow Lissajous figure drawn by the scroll position, so the lettering
 * glides across the page as it scrolls and nothing depends on a pointer. Stays inside the viewport.
 */
export function scrollTour(scrollY: number, viewportWidth: number, viewportHeight: number): Point {
  return {
    x: viewportWidth * (0.5 + 0.3 * Math.sin(scrollY / 410)),
    y: viewportHeight * (0.5 + 0.22 * Math.sin(scrollY / 270 + 1.1)),
  };
}

/**
 * Where the small, clear instance of the wordmark sits relative to the reveal centre: to the lower right of the
 * pointer when it fits, otherwise flipped to the other side of the pointer, finally clamped into the viewport.
 */
export function specimenPosition(
  centre: Point,
  viewportWidth: number,
  viewportHeight: number,
  size: { readonly width: number; readonly height: number },
  offset = 24,
  margin = 8,
): Point {
  let x = centre.x + offset;
  if (x + size.width > viewportWidth - margin) x = centre.x - offset - size.width;
  let y = centre.y + offset;
  if (y + size.height > viewportHeight - margin) y = centre.y - offset - size.height;
  return {
    x: Math.round(clamp(x, margin, Math.max(margin, viewportWidth - size.width - margin))),
    y: Math.round(clamp(y, margin, Math.max(margin, viewportHeight - size.height - margin))),
  };
}

export type ParallaxLayer = {
  /** Pointer travel in pixels per pixel the pointer is away from the viewport centre. Negative moves against it. */
  readonly pointerX: number;
  readonly pointerY: number;
  /** Pixels the layer climbs per pixel of page scroll. */
  readonly scroll: number;
  /** Height of the layer's pattern tile: vertical scroll travel wraps at this period, which hides the seam. */
  readonly tileHeight: number;
  /** The most the layer may be shifted horizontally and vertically, set by how far it overhangs the viewport. */
  readonly limitX: number;
  readonly limitY: number;
};

/**
 * Whole-pixel offset of one pattern layer. Integers keep dots and letters crisp on the compositor layer. The
 * vertical offset is `pointer shift + scroll travel wrapped to the tile height`, so it never leaves `limitY`.
 */
export function layerOffset(
  layer: ParallaxLayer,
  pointer: Point,
  scrollY: number,
  viewportWidth: number,
  viewportHeight: number,
): Point {
  const x = layer.pointerX * (pointer.x - viewportWidth / 2);
  const y = layer.pointerY * (pointer.y - viewportHeight / 2);
  const travel = wrap(-scrollY * layer.scroll, layer.tileHeight);
  return {
    x: Math.round(clamp(x, -layer.limitX, layer.limitX)),
    y: Math.round(clamp(y, -layer.limitY, layer.limitY) + travel),
  };
}
