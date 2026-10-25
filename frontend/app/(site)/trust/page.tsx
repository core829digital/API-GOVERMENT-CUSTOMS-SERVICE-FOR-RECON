import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { FactList, type Fact } from "@/components/site/platform/fact-list";
import { StatusLegend } from "@/components/site/platform/status-legend";
import { PageHero, Section, type Status } from "@/components/site/section";
import { OpenItems } from "@/components/site/trust/open-items";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("trust");
  return { title: t("metadata.title"), description: t("metadata.description") };
}

const STATUSES: readonly Status[] = ["building", "planned", "later"];

// Status of each design rule today (CLAUDE.md invariants, Rules.md, Progress.md §7). Residency is a design
// decision with no deployment behind it, and rules are unreviewed drafts, so both are "planned".
const DETAILED: readonly { id: "isolation" | "ledger" | "privacy" | "residency" | "deterministic"; status: Status }[] = [
  { id: "isolation", status: "building" },
  { id: "ledger", status: "building" },
  { id: "privacy", status: "building" },
  { id: "residency", status: "planned" },
  { id: "deterministic", status: "building" },
];
const PLAIN: readonly { id: "rules" | "keys"; status: Status }[] = [
  { id: "rules", status: "planned" },
  { id: "keys", status: "building" },
];

export default async function TrustPage() {
  const t = await getTranslations("trust");
  const shell = await getTranslations("shell");

  const principles: Fact[] = [
    ...DETAILED.map(({ id, status }) => ({
      id,
      title: t(`principles.items.${id}.title`),
      body: t(`principles.items.${id}.body`),
      detail: t(`principles.items.${id}.detail`),
      tag: { status, label: t(`status.${status}`) },
    })),
    ...PLAIN.map(({ id, status }) => ({
      id,
      title: t(`principles.items.${id}.title`),
      body: t(`principles.items.${id}.body`),
      tag: { status, label: t(`status.${status}`) },
    })),
  ];
  const legal: Fact[] = [
    {
      id: "adviser",
      title: t("legal.items.adviser.title"),
      body: t("legal.items.adviser.body", { app: shell("appName") }),
    },
    { id: "conclusions", title: t("legal.items.conclusions.title"), body: t("legal.items.conclusions.body") },
    {
      id: "review",
      title: t("legal.items.review.title"),
      body: t("legal.items.review.body"),
      tag: { status: "planned", label: t("status.planned") },
    },
  ];

  return (
    <>
      <PageHero eyebrow={t("hero.eyebrow")} title={t("hero.title")} lead={t("hero.lead")}>
        <StatusLegend items={STATUSES.map((status) => ({ status, label: t(`status.${status}`), hint: t(`status.${status}Hint`) }))} />
      </PageHero>

      <Section id="design" index="01" eyebrow={t("principles.eyebrow")} title={t("principles.title")} lead={t("principles.lead")}>
        <FactList items={principles} />
      </Section>

      <Section id="legal" index="02" eyebrow={t("legal.eyebrow")} title={t("legal.title")} lead={t("legal.lead")}>
        <FactList items={legal} />
      </Section>

      <Section id="open" index="03" eyebrow={t("open.eyebrow")} title={t("open.title")} lead={t("open.lead")}>
        <OpenItems />
      </Section>
    </>
  );
}
