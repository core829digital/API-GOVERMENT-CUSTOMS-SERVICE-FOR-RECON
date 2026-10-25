import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Brand } from "@/components/brand/logo";
import { Container } from "@/components/site/section";

const explore = [
  { href: "/platform", key: "platform" },
  { href: "/checks", key: "checks" },
  { href: "/trust", key: "trust" },
] as const;

export async function SiteFooter() {
  const t = await getTranslations();
  return (
    <footer className="relative border-t">
      <div className="pat-dots pointer-events-none absolute inset-0 text-foreground opacity-40 [mask-image:linear-gradient(to_top,black,transparent_70%)]" aria-hidden="true" />
      <Container className="relative grid gap-12 py-16 md:grid-cols-12">
        <div className="space-y-5 md:col-span-6">
          <Link href="/" className="logo-host inline-block outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("shell.appName")}>
            <Brand size={32}>{t("shell.appName")}</Brand>
          </Link>
          <p className="max-w-[28rem] text-sm text-muted-foreground">{t("site.footer.tagline")}</p>
        </div>
        <nav aria-label={t("site.footer.explore")} className="md:col-span-3">
          <p className="eyebrow mb-4">{t("site.footer.explore")}</p>
          <ul className="space-y-3 text-sm">
            {explore.map(({ href, key }) => (
              <li key={href}>
                <Link href={href} className="link-sweep">
                  {t(`site.nav.${key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="md:col-span-3">
          <p className="eyebrow mb-4">{t("site.footer.access")}</p>
          <ul className="space-y-3 text-sm">
            <li>
              <Link href="/login" className="link-sweep">
                {t("common.signIn")}
              </Link>
            </li>
            <li>
              <Link href="/overview" className="link-sweep">
                {t("site.nav.console")}
              </Link>
            </li>
          </ul>
        </div>
      </Container>
      <Container className="relative space-y-2 border-t py-6 text-xs text-muted-foreground">
        <p>{t("site.footer.notice")}</p>
        <p>{t("site.footer.status")}</p>
      </Container>
    </footer>
  );
}
