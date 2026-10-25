import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ApiSurface } from "@/components/site/platform/api-surface";
import { DataFlow } from "@/components/site/platform/data-flow";
import { FactList, type Fact } from "@/components/site/platform/fact-list";
import { HashChain } from "@/components/site/platform/hash-chain";
import { StatusLegend } from "@/components/site/platform/status-legend";
import { StoreDiagram } from "@/components/site/platform/store-diagram";
import { PageHero, Section, type Status } from "@/components/site/section";
import { Reveal } from "@/components/site/reveal";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("platform");
  return { title: t("metadata.title"), description: t("metadata.description") };
}

const STATUSES: readonly Status[] = ["building", "planned", "later"];

// Status of each evidence part today. The ledger, the chain verifier and the timestamp-token verification code
// exist; scheduled anchoring (no provider chosen) and evidence packs do not.
const EVIDENCE: readonly { id: "ledger" | "verifier" | "token" | "anchoring" | "pack"; status: Status; code?: string }[] = [
  { id: "ledger", status: "building" },
  { id: "verifier", status: "building", code: "recon-verify chain <file.ndjson> --expect-head <hash>" },
  { id: "token", status: "building" },
  { id: "anchoring", status: "planned" },
  { id: "pack", status: "planned" },
];

export default async function PlatformPage() {
  const t = await getTranslations("platform");

  const evidence: Fact[] = EVIDENCE.map(({ id, status, code }) => ({
    id,
    title: t(`evidence.items.${id}.title`),
    body: t(`evidence.items.${id}.body`),
    code,
    detail: id === "ledger" ? t("evidence.items.ledger.detail") : undefined,
    tag: { status, label: t(`status.${status}`) },
  }));

  return (
    <>
      <PageHero eyebrow={t("hero.eyebrow")} title={t("hero.title")} lead={t("hero.lead")}>
        <StatusLegend items={STATUSES.map((status) => ({ status, label: t(`status.${status}`), hint: t(`status.${status}Hint`) }))} />
      </PageHero>

      <Section id="flow" index="01" eyebrow={t("flow.eyebrow")} title={t("flow.title")} lead={t("flow.lead")}>
        <DataFlow />
      </Section>

      <Section id="stores" index="02" eyebrow={t("stores.eyebrow")} title={t("stores.title")} lead={t("stores.lead")}>
        <div className="space-y-12">
          <StoreDiagram />
          <div className="grid gap-4 md:grid-cols-2">
            <Reveal className="plate space-y-3 p-6 md:p-8">
              <h3 className="text-xl font-medium tracking-tight">{t("stores.w.name")}</h3>
              <p className="leading-relaxed text-muted-foreground">{t("stores.w.body")}</p>
            </Reveal>
            <Reveal delay={90} className="plate space-y-3 p-6 md:p-8">
              <h3 className="text-xl font-medium tracking-tight">{t("stores.r.name")}</h3>
              <p className="leading-relaxed text-muted-foreground">{t("stores.r.body")}</p>
            </Reveal>
          </div>
          <Reveal className="grid gap-4 border-t border-border pt-8 lg:grid-cols-12 lg:gap-12">
            <h3 className="text-xl font-medium tracking-tight lg:col-span-4">{t("stores.ryw.title")}</h3>
            <div className="space-y-3 lg:col-span-8">
              <p className="max-w-[44rem] leading-relaxed">{t("stores.ryw.body")}</p>
              <p className="max-w-[44rem] text-sm leading-relaxed text-muted-foreground">{t("stores.ryw.detail")}</p>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section id="api" index="03" eyebrow={t("api.eyebrow")} title={t("api.title")} lead={t("api.lead")}>
        <ApiSurface />
      </Section>

      <Section id="evidence" index="04" eyebrow={t("evidence.eyebrow")} title={t("evidence.title")} lead={t("evidence.lead")}>
        <FactList items={evidence} />
        <HashChain />
      </Section>
    </>
  );
}
