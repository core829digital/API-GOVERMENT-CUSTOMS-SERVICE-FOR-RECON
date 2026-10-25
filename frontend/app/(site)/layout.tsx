import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { LenisProvider } from "@/components/lenis-provider";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";

// Public marketing layout. Lenis is mounted here and in the overview layout only (Architecture.md §12, R-FE-1).
export default async function SiteLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("shell");
  return (
    <LenisProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <SiteFooter />
    </LenisProvider>
  );
}
