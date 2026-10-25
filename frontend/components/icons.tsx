import type { ComponentProps } from "react";

/**
 * Project icon set. Drawn on a 24-unit grid with a 1.5 stroke, square caps and mitred joins so that every glyph
 * reads as technical and angular. There is no third-party icon dependency. Icons are decorative by default
 * (`aria-hidden`); pass `aria-label` and `role="img"` when one carries meaning on its own.
 */
export type IconProps = ComponentProps<"svg">;

export function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => <Icon {...p}><path d="M4 12.5 9.5 18 20 6.5" /></Icon>;
export const XIcon = (p: IconProps) => <Icon {...p}><path d="M5 5l14 14M19 5 5 19" /></Icon>;
export const ChevronRightIcon = (p: IconProps) => <Icon {...p}><path d="M9 5l7 7-7 7" /></Icon>;
export const ChevronDownIcon = (p: IconProps) => <Icon {...p}><path d="M5 9l7 7 7-7" /></Icon>;
export const ArrowRightIcon = (p: IconProps) => <Icon {...p}><path d="M4 12h16M14 6l6 6-6 6" /></Icon>;
export const ArrowUpRightIcon = (p: IconProps) => <Icon {...p}><path d="M7 17 17 7M8 7h9v9" /></Icon>;
export const MenuIcon = (p: IconProps) => <Icon {...p}><path d="M3 7h18M3 12h18M3 17h18" /></Icon>;
/** Filled dot; give it a size and `fill-current` for radio indicators. */
export const CircleIcon = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="8" /></Icon>;
export const PanelLeftIcon = (p: IconProps) => <Icon {...p}><path d="M3 4h18v16H3zM9 4v16" /></Icon>;
export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </Icon>
);
export const MoonIcon = (p: IconProps) => <Icon {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" /></Icon>;
export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3.2 3.4 3.2 14.6 0 18M12 3c-3.2 3.4-3.2 14.6 0 18" />
  </Icon>
);
export const AlertIcon = (p: IconProps) => <Icon {...p}><path d="M12 3.5 21.5 20h-19ZM12 10v5M12 17.5v.5" /></Icon>;
export const OverviewIcon = (p: IconProps) => <Icon {...p}><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z" /></Icon>;
export const FindingsIcon = (p: IconProps) => <Icon {...p}><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 12h8" /></Icon>;

// Pipeline and platform glyphs
export const IngestIcon = (p: IconProps) => <Icon {...p}><path d="M12 3v12M7 10l5 5 5-5M4 17v4h16v-4" /></Icon>;
export const NormaliseIcon = (p: IconProps) => <Icon {...p}><path d="M8 4H5v16h3M16 4h3v16h-3M9 9h6M9 12h6M9 15h4" /></Icon>;
export const ReconcileIcon = (p: IconProps) => <Icon {...p}><path d="M3 3h12v12H3zM9 9h12v12H9z" /></Icon>;
export const EvidenceIcon = (p: IconProps) => <Icon {...p}><path d="M6 3h9l4 4v14H6zM15 3v4h4M9 14l2.5 2.5L16 12" /></Icon>;
export const LedgerIcon = (p: IconProps) => <Icon {...p}><path d="M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z" /></Icon>;
export const DatabaseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Icon>
);
export const ShieldIcon = (p: IconProps) => <Icon {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z" /></Icon>;
export const LockIcon = (p: IconProps) => <Icon {...p}><path d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4" /></Icon>;
export const KeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M12 15h9M18 15v3M15 15v2" />
  </Icon>
);
export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2" />
  </Icon>
);
export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </Icon>
);
export const HashIcon = (p: IconProps) => <Icon {...p}><path d="M9 4 7 20M17 4l-2 16M4 9h17M3 15h17" /></Icon>;
export const CodeIcon = (p: IconProps) => <Icon {...p}><path d="M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16" /></Icon>;
