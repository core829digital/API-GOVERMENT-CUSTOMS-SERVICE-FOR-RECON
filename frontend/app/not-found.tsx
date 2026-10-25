import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Brand } from "@/components/brand/logo";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <main className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden px-6 md:px-10">
      <div
        className="pat-grid pointer-events-none absolute inset-0 -z-10 text-foreground [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
        aria-hidden="true"
      />
      <div className="mx-auto w-full max-w-[84rem] space-y-8">
        <Link href="/" className="logo-host inline-block outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("shell.appName")}>
          <Brand>{t("shell.appName")}</Brand>
        </Link>
        <p className="eyebrow">{"404"}</p>
        <h1 className="display max-w-[16ch]">{t("pages.notFound.title")}</h1>
        <p className="lead max-w-[40rem]">{t("pages.notFound.description")}</p>
        <Button asChild size="lg">
          <Link href="/">
            {t("pages.notFound.back")}
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </main>
  );
}
