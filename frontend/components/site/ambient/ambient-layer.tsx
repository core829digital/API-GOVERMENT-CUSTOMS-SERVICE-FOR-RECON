"use client";

import { useEffect, useId, useRef } from "react";
import { PatternWordmark } from "@/components/brand/pattern-wordmark";
import { hatchTilePath } from "@/components/brand/wordmark-geometry";
import { mountAmbient } from "@/components/site/ambient/ambient-controller";
import {
  DOTS_PATH,
  HATCH_PATH,
  HATCH_PERIOD,
  REST_PATH,
  REST_TILE,
  SPECIMEN_PADDING,
  SPECIMEN_PITCH,
  WORD_TILE,
} from "@/components/site/ambient/ambient-tiles";

/**
 * Page background of the public site and the sign-in screen. Server-rendered as static markup (registration
 * crosses visible, everything else hidden), so it works without scripting; `mountAmbient` then wires the
 * pointer or the scroll position to it. Decorative: `aria-hidden`, never interactive, never focusable.
 */
export function AmbientLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  useEffect(() => {
    const root = ref.current;
    return root ? mountAmbient(root) : undefined;
  }, []);

  const rest = `${uid}r`;
  const hatchLines = `${uid}l`;
  const hatchWords = `${uid}h`;
  const dotWords = `${uid}d`;

  return (
    <div ref={ref} className="ambient" aria-hidden="true" data-state="idle">
      <svg className="ambient__rest" focusable="false">
        <defs>
          <pattern id={rest} width={REST_TILE} height={REST_TILE} patternUnits="userSpaceOnUse">
            <path d={REST_PATH} fill="currentColor" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${rest})`} />
      </svg>

      <div className="ambient__reveal">
        <div className="ambient__field ambient__field--hatch">
          <svg width="100%" height="100%" focusable="false">
            <defs>
              <pattern id={hatchLines} width={HATCH_PERIOD} height={HATCH_PERIOD} patternUnits="userSpaceOnUse">
                <path d={hatchTilePath(HATCH_PERIOD)} stroke="currentColor" strokeWidth="1" fill="none" />
              </pattern>
              <pattern id={hatchWords} width={WORD_TILE.width} height={WORD_TILE.height} patternUnits="userSpaceOnUse">
                <path d={HATCH_PATH} fill={`url(#${hatchLines})`} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${hatchWords})`} />
          </svg>
        </div>
        <div className="ambient__field ambient__field--dots">
          <svg width="100%" height="100%" focusable="false">
            <defs>
              <pattern id={dotWords} width={WORD_TILE.width} height={WORD_TILE.height} patternUnits="userSpaceOnUse">
                <path d={DOTS_PATH} fill="currentColor" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${dotWords})`} />
          </svg>
        </div>
      </div>

      <div className="ambient__specimen" style={{ padding: `${SPECIMEN_PADDING.y}px ${SPECIMEN_PADDING.x}px` }}>
        <PatternWordmark
          className="ambient__specimen-art"
          variant="registered"
          pitch={SPECIMEN_PITCH}
          hatchPeriod={HATCH_PERIOD}
          mark
        />
      </div>
    </div>
  );
}
