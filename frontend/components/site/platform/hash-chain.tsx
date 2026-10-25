import { getTranslations } from "next-intl/server";
import { Reveal } from "@/components/site/reveal";

const EVENTS = [1, 2, 3, 4] as const;

/**
 * Four linked event cells. Purely illustrative and labelled so: it shows that each event stores the hash of its
 * predecessor, with no hash values drawn. The caption is the text alternative; the cells are hidden from
 * assistive technology.
 */
export async function HashChain() {
  const t = await getTranslations("platform");
  return (
    <figure className="mt-12 space-y-4">
      <div aria-hidden="true" className="grid gap-3 sm:grid-cols-4">
        {EVENTS.map((n, i) => (
          <Reveal key={n} delay={i * 120} className="plate relative p-4">
            <p className="eyebrow text-foreground">{t("evidence.chain.event", { n })}</p>
            <div className="pat-hatch mt-4 h-6 text-foreground" />
            <p className="eyebrow mt-3 text-[0.62rem]">{t("evidence.chain.prev")}</p>
            {i > 0 ? (
              <Reveal
                kind="line"
                delay={i * 120 + 200}
                className="absolute top-1/2 -left-3 hidden h-px w-3 bg-foreground/60 sm:block"
              />
            ) : null}
          </Reveal>
        ))}
      </div>
      <figcaption className="text-sm leading-relaxed text-muted-foreground">
        <span className="sr-only">{t("evidence.chain.label")}: </span>
        {t("evidence.chain.caption")}
      </figcaption>
    </figure>
  );
}
