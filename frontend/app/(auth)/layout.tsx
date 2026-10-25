import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { AmbientLayer } from "@/components/site/ambient/ambient-layer";

// Sign-in layout: no site header or footer, and no Lenis (Architecture.md §12, R-FE-1). The page is one
// split screen and scrolls natively.
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("shell");
  return (
    <>
      <AmbientLayer />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <main id="main-content" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </>
  );
}
