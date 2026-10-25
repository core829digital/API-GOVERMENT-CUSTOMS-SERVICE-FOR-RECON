import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/** Square, hairline call-to-action link. The arrow nudges on hover only when motion is allowed. */
export function ActionLink({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex min-h-12 items-center gap-3 px-6 text-sm font-medium transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        variant === "primary"
          ? "bg-foreground text-background hover:bg-foreground/85"
          : "border border-border hover:border-foreground",
      )}
    >
      {children}
      <ArrowRightIcon className="size-4 shrink-0 motion-safe:transition-transform motion-safe:group-hover:translate-x-1" />
    </Link>
  );
}
