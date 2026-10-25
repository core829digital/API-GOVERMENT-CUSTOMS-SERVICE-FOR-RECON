"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  // Failed requests are shown as-is with an explicit "try again" action; no silent retries.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
  );
  // Dark ("ink") is the brand default; visitors can still pick light or follow their system.
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
