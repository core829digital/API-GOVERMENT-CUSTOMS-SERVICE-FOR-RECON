"use client";

import { ReactLenis } from "lenis/react";
import "lenis/dist/lenis.css";
import type { ReactNode } from "react";

/**
 * Smooth scrolling for the overview layout only. Library defaults are kept on purpose:
 * `respectReducedMotion` stays true (smoothing off under prefers-reduced-motion).
 * Nested scroll containers must carry `data-lenis-prevent`. Nothing may depend on Lenis.
 */
export function LenisProvider({ children }: { children: ReactNode }) {
  return <ReactLenis root>{children}</ReactLenis>;
}
