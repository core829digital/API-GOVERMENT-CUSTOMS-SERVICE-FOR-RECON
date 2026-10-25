import {
  approach,
  isSettled,
  layerOffset,
  scrollTour,
  specimenPosition,
  type Point,
} from "@/components/site/ambient/ambient-math";
import {
  DOTS_LAYER,
  HATCH_LAYER,
  NARROW_VIEWPORT,
  REVEAL_DIAMETER,
  SPECIMEN_SIZE,
} from "@/components/site/ambient/ambient-tiles";

/** Time for the reveal to close 63 % of the distance to the pointer. */
const FOLLOW_TAU_MS = 110;
/** On touch screens the reveal fades out this long after the last scroll event. */
const SCROLL_IDLE_MS = 900;
/** A long frame (tab in the background, a hitch) is treated as this long, so the reveal never lurches. */
const MAX_FRAME_MS = 64;

type Mode = "pointer" | "scroll" | "off";

/**
 * Drives the ambient layer. No React state, no layout: every frame writes a handful of integer pixel values
 * into CSS custom properties on `root`, and the stylesheet turns them into a mask position and `transform`s.
 *
 *   pointer  a fine pointer that can hover: the reveal follows it, smoothed; the pattern fields drift against
 *            each other with pointer and scroll position.
 *   scroll   touch and other coarse pointers: there is no hover, so the reveal glides along a path drawn by
 *            the scroll position and fades out when scrolling stops.
 *   off      coarse pointer and `prefers-reduced-motion`: nothing moves, nothing is revealed.
 *
 * Under `prefers-reduced-motion` with a fine pointer the reveal sits exactly under the pointer: no smoothing,
 * no parallax, no scroll drift (the stylesheet also removes the fade).
 *
 * Frames are scheduled only while something changes; an idle page runs no animation frame. Returns a cleanup.
 */
export function mountAmbient(root: HTMLElement): () => void {
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  let mode: Mode = "off";
  let reduced = reducedQuery.matches;
  let viewport = { width: window.innerWidth, height: window.innerHeight };
  let scrollY = window.scrollY;
  let target: Point = { x: viewport.width / 2, y: viewport.height / 2 };
  let current: Point = target;
  let active = false;
  let frameId = 0;
  let lastFrame = 0;
  let idleTimer = 0;
  let diameter: number = REVEAL_DIAMETER.wide;
  const written = new Map<string, string>();

  function set(name: string, value: string) {
    if (written.get(name) === value) return;
    written.set(name, value);
    root.style.setProperty(name, value);
  }

  function setPixels(name: string, value: number) {
    set(name, `${Math.round(value)}px`);
  }

  function setActive(on: boolean) {
    if (active === on) return;
    active = on;
    root.dataset.state = on ? "active" : "idle";
  }

  function write() {
    // The reveal is a fixed-size window that is only translated; the fields inside it are translated the
    // opposite way, so they stay put on the page (plus their parallax). Nothing repaints, only layers move.
    const lx = Math.round(current.x - diameter / 2);
    const ly = Math.round(current.y - diameter / 2);
    setPixels("--ambient-lx", lx);
    setPixels("--ambient-ly", ly);
    const still = { x: 0, y: 0 };
    const dots = reduced ? still : layerOffset(DOTS_LAYER, current, scrollY, viewport.width, viewport.height);
    const hatch = reduced ? still : layerOffset(HATCH_LAYER, current, scrollY, viewport.width, viewport.height);
    setPixels("--ambient-dots-x", dots.x - lx);
    setPixels("--ambient-dots-y", dots.y - ly);
    setPixels("--ambient-hatch-x", hatch.x - lx);
    setPixels("--ambient-hatch-y", hatch.y - ly);
    const specimen = specimenPosition(current, viewport.width, viewport.height, SPECIMEN_SIZE);
    setPixels("--ambient-specimen-x", specimen.x);
    setPixels("--ambient-specimen-y", specimen.y);
  }

  function frame(now: number) {
    frameId = 0;
    const elapsed = lastFrame === 0 ? 16 : Math.min(now - lastFrame, MAX_FRAME_MS);
    lastFrame = now;
    if (reduced) {
      current = target;
    } else {
      current = {
        x: approach(current.x, target.x, elapsed, FOLLOW_TAU_MS),
        y: approach(current.y, target.y, elapsed, FOLLOW_TAU_MS),
      };
      if (isSettled(current, target)) current = target;
    }
    write();
    if (current === target) lastFrame = 0;
    else schedule();
  }

  function schedule() {
    if (frameId === 0) frameId = window.requestAnimationFrame(frame);
  }

  function enter(point: Point) {
    target = point;
    if (!active) {
      current = point;
      setActive(true);
    }
    schedule();
  }

  function onPointerMove(event: PointerEvent) {
    if (mode !== "pointer" || event.pointerType === "touch") return;
    enter({ x: event.clientX, y: event.clientY });
  }

  // `relatedTarget === null` means the pointer left the window, not one element for another.
  function onPointerOut(event: PointerEvent) {
    if (mode === "pointer" && event.relatedTarget === null) setActive(false);
  }

  function onScroll() {
    scrollY = window.scrollY;
    if (mode === "scroll") {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => setActive(false), SCROLL_IDLE_MS);
      enter(scrollTour(scrollY, viewport.width, viewport.height));
    } else if (mode === "pointer" && active && !reduced) {
      schedule();
    }
  }

  function onResize() {
    viewport = { width: window.innerWidth, height: window.innerHeight };
    diameter = viewport.width < NARROW_VIEWPORT ? REVEAL_DIAMETER.narrow : REVEAL_DIAMETER.wide;
    set("--ambient-d", `${diameter}px`);
    write();
    if (active) schedule();
  }

  function resolve() {
    reduced = reducedQuery.matches;
    mode = fine.matches ? "pointer" : reduced ? "off" : "scroll";
    window.clearTimeout(idleTimer);
    setActive(false);
    root.dataset.mode = mode;
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerout", onPointerOut, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  fine.addEventListener("change", resolve);
  reducedQuery.addEventListener("change", resolve);

  onResize();
  resolve();
  write();

  return () => {
    window.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerout", onPointerOut);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    fine.removeEventListener("change", resolve);
    reducedQuery.removeEventListener("change", resolve);
    window.cancelAnimationFrame(frameId);
    window.clearTimeout(idleTimer);
  };
}
