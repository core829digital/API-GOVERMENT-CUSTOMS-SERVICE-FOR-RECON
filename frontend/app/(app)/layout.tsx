import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";

// Data-view layout: no Lenis. Tables, dialogs and sheets here scroll natively.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
