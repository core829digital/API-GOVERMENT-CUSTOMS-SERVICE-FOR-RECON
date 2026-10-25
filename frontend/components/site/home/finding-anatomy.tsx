import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Reveal } from "@/components/site/reveal";
import { Section } from "@/components/site/section";
import { CHECK_CODE, FLAGGED, HASH_ALGORITHM, SYNTHETIC_RULE } from "@/components/site/home/data";

const CALLOUTS = ["reproducible", "neutral", "cited", "evidence"] as const;

/** Numbered marker that ties a part of the card to its callout. Decorative: the callout titles repeat the names. */
function Marker({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="num flex size-6 shrink-0 items-center justify-center border text-xs">
      {n}
    </span>
  );
}

function Part({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-4 px-5 py-5">
      <Marker n={n} />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="eyebrow mb-2">{children}</p>;
}

/** One illustrative finding, labelled synthetic, with a callout per part explaining why it exists. */
export async function FindingAnatomy() {
  const t = await getTranslations("home");
  return (
    <Section
      id="anatomy"
      index="02"
      eyebrow={t("anatomy.eyebrow")}
      title={t("anatomy.title")}
      lead={t("anatomy.lead")}
    >
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-10">
        <Reveal className="min-w-0 lg:col-span-7">
          <article aria-label={t("anatomy.cardLabel")} className="border bg-card">
            <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-dashed px-5 py-3">
              <p className="eyebrow text-foreground">{t("anatomy.cardLabel")}</p>
              <p className="font-mono text-xs text-muted-foreground">{t("anatomy.cardNote")}</p>
            </header>
            <ul className="divide-y">
              <Part n={1}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <Label>{t("anatomy.fields.check")}</Label>
                    <p className="text-sm">
                      <span className="num font-medium">{CHECK_CODE}</span>
                      <span className="text-muted-foreground"> · {t("anatomy.values.checkName")}</span>
                    </p>
                  </div>
                  <div>
                    <Label>{t("anatomy.fields.severity")}</Label>
                    <p className="flex items-center gap-2 text-sm font-medium text-sev-medium">
                      <span aria-hidden="true" className="size-2 bg-sev-medium" />
                      {t("anatomy.values.severity")}
                    </p>
                  </div>
                </div>
              </Part>
              <Part n={2}>
                <Label>{t("anatomy.fields.summary")}</Label>
                <p className="text-base leading-relaxed">{t("anatomy.values.summary", { invoice: FLAGGED.ref })}</p>
              </Part>
              <Part n={3}>
                <Label>{t("anatomy.fields.rule")}</Label>
                <p className="font-mono text-sm break-all">{SYNTHETIC_RULE}</p>
              </Part>
              <Part n={4}>
                <Label>{t("anatomy.fields.inputs")}</Label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("anatomy.values.booksInput")}</p>
                    <p className="mt-1 font-mono text-sm break-all">{`${HASH_ALGORITHM}:${FLAGGED.booksHash}`}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("anatomy.values.authorityInput")}</p>
                    <p className="mt-1 font-mono text-sm break-all">{`${HASH_ALGORITHM}:${FLAGGED.authorityHash}`}</p>
                  </div>
                </div>
              </Part>
            </ul>
          </article>
        </Reveal>
        <div className="min-w-0 lg:col-span-5">
          <Reveal>
            <h3 className="eyebrow">{t("anatomy.calloutsLabel")}</h3>
          </Reveal>
          <ol className="mt-6 space-y-8">
            {CALLOUTS.map((key, index) => (
              <Reveal key={key} as="li" delay={index * 90} className="flex gap-4 border-t pt-5">
                <Marker n={index + 1} />
                <div className="min-w-0 space-y-2">
                  <h4 className="font-medium tracking-tight">{t(`anatomy.callouts.${key}.title`)}</h4>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t(`anatomy.callouts.${key}.body`)}</p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </Section>
  );
}
