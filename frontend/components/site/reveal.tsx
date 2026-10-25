"use client";

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";

export type RevealKind = "up" | "line" | "fade" | "clip";

/**
 * Reveals its content once when it scrolls into view. The hidden starting state lives in CSS and applies only
 * when scripting is on and reduced motion is not requested (`globals.css`), so content is never stuck invisible.
 * `delay` (ms) staggers siblings. The element is observed once and then released.
 */
export function Reveal({
  as,
  kind = "up",
  delay = 0,
  className,
  children,
}: {
  as?: ElementType;
  kind?: RevealKind;
  delay?: number;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-inview", "");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag
      ref={ref}
      data-reveal={kind}
      className={className}
      style={delay ? ({ "--d": `${delay}ms` } as CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
