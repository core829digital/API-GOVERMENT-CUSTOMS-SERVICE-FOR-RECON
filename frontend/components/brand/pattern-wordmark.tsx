import { useId } from "react";
import { cn } from "@/lib/utils";
import {
  MARK_BOX,
  MARK_GAP_CELLS,
  MARK_SQUARES,
  WORDMARK,
  cellsPath,
  dotsPath,
  hatchTilePath,
  layoutWord,
  num,
  wordmarkSize,
} from "@/components/brand/wordmark-geometry";

export type PatternVariant = "dots" | "hatch" | "cells" | "registered";

/** Mark dot grid and hatch, the same vocabulary and spacing as `LogoMark`. */
const MARK_PERIOD = 3;

/**
 * The product name drawn as a pattern instead of as type: `dots` is a dot matrix, `hatch` solid letters filled
 * with the logo's diagonal hatch, `cells` the same hatch in separate ledger cells, and `registered` the hatch
 * with the dots on top, the two sources in register. With `mark` the two-square mark stands before the word,
 * one source hatched and the other dotted, as the logo looks on hover.
 *
 * Decorative: the SVG is hidden from assistive technology, so the real name must be present as text elsewhere.
 * It draws with `currentColor`; set the colour and the opacity from outside.
 */
export function PatternWordmark({
  text = WORDMARK,
  variant = "dots",
  pitch = 4,
  hatchPeriod = pitch * 0.65,
  mark = false,
  className,
}: {
  text?: string;
  variant?: PatternVariant;
  /** Units (CSS pixels) per bitmap cell. */
  pitch?: number;
  /** Horizontal distance between hatch lines of every variant but `dots`. */
  hatchPeriod?: number;
  mark?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const layout = layoutWord(text);
  const { width, height } = wordmarkSize(text, pitch, mark);
  const markSize = height;
  const wordX = mark ? markSize + pitch * MARK_GAP_CELLS : 0;
  const hatchId = `${uid}h`;

  const hatched = variant !== "dots";
  const dotted = variant === "dots" || variant === "registered";
  const letters = (
    <>
      {hatched ? (
        <>
          <defs>
            <pattern id={hatchId} width={hatchPeriod} height={hatchPeriod} patternUnits="userSpaceOnUse">
              <path d={hatchTilePath(hatchPeriod)} stroke="currentColor" strokeOpacity={dotted ? 0.55 : 1} strokeWidth="1" fill="none" />
            </pattern>
          </defs>
          <path
            d={cellsPath(layout, { pitch, gap: variant === "cells" ? Math.max(0.5, pitch * 0.12) : 0, x: wordX })}
            fill={`url(#${hatchId})`}
          />
        </>
      ) : null}
      {dotted ? <path d={dotsPath(layout, { pitch, radius: pitch * 0.24, x: wordX })} fill="currentColor" /> : null}
    </>
  );

  return (
    <svg
      viewBox={`0 0 ${num(width)} ${num(height)}`}
      width={num(width)}
      height={num(height)}
      className={cn("shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      {mark ? <PatternMark uid={uid} size={markSize} /> : null}
      {letters}
    </svg>
  );
}

function PatternMark({ uid, size }: { uid: string; size: number }) {
  const hatchId = `${uid}mh`;
  const dotsId = `${uid}md`;
  const { books, authority, overlap } = MARK_SQUARES;
  const inset = 0.9;
  return (
    <g transform={`scale(${num(size / MARK_BOX)})`}>
      <defs>
        <pattern id={hatchId} width={MARK_PERIOD} height={MARK_PERIOD} patternUnits="userSpaceOnUse">
          <path d={hatchTilePath(MARK_PERIOD)} stroke="currentColor" strokeWidth="0.7" fill="none" />
        </pattern>
        <pattern id={dotsId} width={MARK_PERIOD} height={MARK_PERIOD} patternUnits="userSpaceOnUse">
          <circle cx={MARK_PERIOD / 2} cy={MARK_PERIOD / 2} r="0.55" fill="currentColor" />
        </pattern>
      </defs>
      <rect x={books.x} y={books.y} width={books.size} height={books.size} fill={`url(#${hatchId})`} />
      <rect x={authority.x} y={authority.y} width={authority.size} height={authority.size} fill={`url(#${dotsId})`} />
      <rect
        x={books.x + inset}
        y={books.y + inset}
        width={books.size - inset * 2}
        height={books.size - inset * 2}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <rect
        x={authority.x + inset}
        y={authority.y + inset}
        width={authority.size - inset * 2}
        height={authority.size - inset * 2}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <rect x={overlap.x} y={overlap.y} width={overlap.size} height={overlap.size} fill="currentColor" />
    </g>
  );
}
