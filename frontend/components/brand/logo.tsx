import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The mark: two offset squares, the two sources (the books, the authority's copy), and the small square where
 * they overlap, the part that reconciles. At rest it is three flat shapes. On hover or keyboard focus of the
 * surrounding `.logo-host` element (or always, with `active`) each source fills with its own pattern, a diagonal
 * hatch and a dot grid, and both drift slowly. Patterns and motion are CSS-only (see `globals.css`) and stop
 * under `prefers-reduced-motion`.
 */
export function LogoMark({
  size = 28,
  active = false,
  className,
}: {
  size?: number;
  /** Show the patterns without hover (decorative uses such as the sign-in panel). */
  active?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const clipA = `${uid}a`;
  const clipB = `${uid}b`;

  const hatch: ReactNode[] = [];
  for (let x = -24; x <= 28; x += 3) {
    hatch.push(<path key={x} d={`M${x} 24L${x + 24} 0`} />);
  }
  const dots: ReactNode[] = [];
  for (let x = 11; x <= 33; x += 3) {
    for (let y = 11; y <= 33; y += 3) {
      dots.push(<circle key={`${x}:${y}`} cx={x} cy={y} r={0.55} />);
    }
  }

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("logo shrink-0", className)}
      data-active={active ? "true" : undefined}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipA}>
          <rect x="2" y="2" width="18" height="18" />
        </clipPath>
        <clipPath id={clipB}>
          <rect x="12" y="12" width="18" height="18" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipA})`} className="logo__pattern">
        <g className="logo__drift" stroke="currentColor" strokeWidth="0.7" fill="none">
          {hatch}
        </g>
      </g>
      <g clipPath={`url(#${clipB})`} className="logo__pattern">
        <g className="logo__drift" fill="currentColor">
          {dots}
        </g>
      </g>

      <rect x="2.9" y="2.9" width="16.2" height="16.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="12.9" y="12.9" width="16.2" height="16.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="12" y="12" width="8" height="8" fill="currentColor" />
    </svg>
  );
}

/** Mark plus wordmark. `children` is the (translated) product name; it is uppercased and tracked out by CSS. */
export function Brand({
  children,
  size = 28,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("logo-host inline-flex items-center gap-3", className)}>
      <LogoMark size={size} />
      <span className="text-[0.8rem] leading-none font-semibold tracking-[0.34em] uppercase">{children}</span>
    </span>
  );
}
