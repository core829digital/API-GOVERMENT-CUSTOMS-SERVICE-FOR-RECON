import { getTranslations } from "next-intl/server";
import { Reveal } from "@/components/site/reveal";
import { Container } from "@/components/site/section";
import { ActionLink } from "@/components/site/home/action-link";
import { ReconField } from "@/components/site/home/recon-field";

/** Home hero: the only h1 on the page, two actions, and the signature ledger illustration. */
export async function Hero() {
  const t = await getTranslations();
  return (
    <section
      aria-labelledby="home-title"
      className="relative isolate overflow-hidden pt-32 pb-16 md:pt-40 lg:flex lg:min-h-svh lg:items-center lg:pt-32 lg:pb-20"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="pat-grid scroll-drift absolute inset-x-0 inset-y-[-12%] text-foreground [mask-image:radial-gradient(ellipse_80%_70%_at_70%_40%,black,transparent)]" />
      </div>
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-12 lg:gap-8">
          <div className="min-w-0 lg:col-span-7">
            <Reveal>
              <p className="eyebrow">{t("home.hero.eyebrow")}</p>
            </Reveal>
            <Reveal delay={80}>
              <h1 id="home-title" className="display mt-6 break-words lg:text-[clamp(3rem,5.4vw,5.75rem)]">
                {t("home.hero.title")}
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="lead mt-8 max-w-[38rem]">{t("home.hero.lead")}</p>
            </Reveal>
            <Reveal delay={220} className="mt-10 flex flex-wrap items-center gap-4">
              <ActionLink href="/login">{t("common.signIn")}</ActionLink>
              <ActionLink href="/platform" variant="secondary">
                {t("home.hero.secondary")}
              </ActionLink>
            </Reveal>
            <Reveal delay={280}>
              <p className="mt-8 flex max-w-[38rem] items-start gap-3 font-mono text-xs text-muted-foreground">
                <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 bg-signal" />
                {t("home.hero.note")}
              </p>
            </Reveal>
          </div>
          <Reveal delay={200} kind="fade" className="min-w-0 lg:col-span-5">
            <ReconField />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
