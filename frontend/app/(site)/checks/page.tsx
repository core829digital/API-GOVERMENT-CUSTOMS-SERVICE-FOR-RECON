import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { C1Outcomes } from "@/components/site/checks/c1-outcomes";
import { CheckTable } from "@/components/site/checks/check-table";
import { FactList, type Fact } from "@/components/site/platform/fact-list";
import { StatusLegend } from "@/components/site/platform/status-legend";
import { Reveal } from "@/components/site/reveal";
import { PageHero, Section, type Status } from "@/components/site/section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("checks");
  return { title: t("metadata.title"), description: t("metadata.description") };
}

const STATUSES: readonly Status[] = ["building", "planned", "later"];
const PRODUCES = ["disagreement", "rule", "inputs"] as const;
const UNPROVEN = ["realData", "rules", "competitors", "demand", "availability"] as const;

export default async function ChecksPage() {
  const t = await getTranslations("checks");

  const produces: Fact[] = PRODUCES.map((id) => ({
    id,
    title: t(`produces.items.${id}.title`),
    body: t(`produces.items.${id}.body`),
  }));
  const unproven: Fact[] = UNPROVEN.map((id) => ({
    id,
    title: t(`unproven.items.${id}.title`),
    body: t(`unproven.items.${id}.body`),
  }));

  return (
    <>
      <PageHero eyebrow={t("hero.eyebrow")} title={t("hero.title")} lead={t("hero.lead")}>
        <StatusLegend items={STATUSES.map((status) => ({ status, label: t(`status.${status}`), hint: t(`status.${status}Hint`) }))} />
      </PageHero>

      <Section id="catalogue" index="01" eyebrow={t("catalogue.eyebrow")} title={t("catalogue.title")} lead={t("catalogue.lead")}>
        <CheckTable />
      </Section>

      <Section id="c1" index="02" eyebrow={t("c1.eyebrow")} title={t("c1.title")} lead={t("c1.lead")}>
        <C1Outcomes />
      </Section>

      <Section id="output" index="03" eyebrow={t("produces.eyebrow")} title={t("produces.title")} lead={t("produces.lead")}>
        <div className="space-y-10">
          <FactList items={produces} />
          <Reveal className="plate space-y-3 border-foreground/40 p-6 md:p-8">
            <h3 className="text-xl font-medium tracking-tight">{t("produces.notice.title")}</h3>
            <p className="max-w-[44rem] leading-relaxed">{t("produces.notice.body")}</p>
          </Reveal>
        </div>
      </Section>

      <Section id="limits" index="04" eyebrow={t("unproven.eyebrow")} title={t("unproven.title")} lead={t("unproven.lead")}>
        <FactList items={unproven} />
      </Section>
    </>
  );
}
