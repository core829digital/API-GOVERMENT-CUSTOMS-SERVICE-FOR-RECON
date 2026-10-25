import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { LenisProvider } from "@/components/lenis-provider";

// Marketing/overview layout: the only place Lenis is mounted (Architecture.md §12).
export default function OverviewLayout({ children }: { children: ReactNode }) {
  return (
    <LenisProvider>
      <AppShell>{children}</AppShell>
    </LenisProvider>
  );
}
