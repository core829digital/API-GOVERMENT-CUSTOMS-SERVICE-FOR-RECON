"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// Root error boundary: shown when rendering a page fails. It never prints the error (R-API-5 / R-PRIV-1: no
// internals or personal data in user-visible output); `reset` re-renders the segment.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations();
  return (
    <main className="flex min-h-svh flex-col justify-center px-6 md:px-10">
      <div role="alert" className="mx-auto w-full max-w-[84rem] space-y-6">
        <h1 className="headline max-w-[20ch]">{t("pages.error.title")}</h1>
        <p className="lead max-w-[40rem]">{t("pages.error.description")}</p>
        <Button onClick={reset}>{t("common.retry")}</Button>
      </div>
    </main>
  );
}
