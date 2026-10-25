import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Reveal } from "@/components/site/reveal";
import { Container } from "@/components/site/section";
import { ActionLink } from "@/components/site/home/action-link";

/** Closing band: one statement, the sign-in action and a quieter link to the checks. */
export async function Closing() {
  const t = await getTranslations();
  return (
    <section aria-labelledby="closing-title" className="relative isolate overflow-hidden border-t py-24 md:py-36">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="pat-hatch scroll-drift absolute inset-x-0 inset-y-[-10%] text-foreground opacity-50 [mask-image:linear-gradient(to_left,black,transparent_65%)]" />
      </div>
      <Container>
        <Reveal>
          <p className="eyebrow">{t("home.closing.eyebrow")}</p>
        </Reveal>
        <Reveal delay={80}>
          <h2 id="closing-title" className="headline mt-6 max-w-[20ch]">
            {t("home.closing.title")}
          </h2>
        </Reveal>
        <Reveal delay={140}>
          <p className="lead mt-6 max-w-[40rem]">{t("home.closing.body")}</p>
        </Reveal>
        <Reveal delay={200} className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-5">
          <ActionLink href="/login">{t("common.signIn")}</ActionLink>
          <Link href="/checks" className="link-sweep text-sm font-medium">
            {t("home.closing.checksLink")}
          </Link>
        </Reveal>
      </Container>
    </section>
  );
}
