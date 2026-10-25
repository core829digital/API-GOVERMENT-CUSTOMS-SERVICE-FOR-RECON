import { getTranslations } from "next-intl/server";
import { EvidenceIcon, IngestIcon, NormaliseIcon, ReconcileIcon } from "@/components/icons";
import { Reveal } from "@/components/site/reveal";
import { Section, StatusTag, type Status } from "@/components/site/section";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "ingest", Icon: IngestIcon, status: "planned" },
  { key: "normalise", Icon: NormaliseIcon, status: "planned" },
  { key: "reconcile", Icon: ReconcileIcon, status: "building" },
  { key: "evidence", Icon: EvidenceIcon, status: "building" },
] as const satisfies readonly { key: string; Icon: typeof IngestIcon; status: Status }[];

/**
 * Four stages joined by a hairline. Each step draws its own segment, staggered, so on desktop the line seems to
 * run left to right as the list scrolls into view; on small screens the line runs down the left edge instead.
 */
export async function Pipeline() {
  const t = await getTranslations("home");
  return (
    <Section id="pipeline" index="01" eyebrow={t("pipeline.eyebrow")} title={t("pipeline.title")} lead={t("pipeline.lead")}>
      <ol className="grid gap-0 md:grid-cols-4">
        {STEPS.map(({ key, Icon, status }, index) => (
          <li key={key} className="relative border-l pb-12 pl-8 last:pb-0 md:border-l-0 md:pt-10 md:pr-8 md:pb-0 md:pl-0">
            <Reveal
              kind="line"
              delay={index * 160}
              className="absolute top-0 right-0 left-0 hidden h-px bg-foreground/40 md:block"
            />
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1 left-0 size-2 -translate-x-1/2 md:top-0 md:left-0 md:translate-x-0 md:-translate-y-1/2",
                status === "building" ? "bg-signal" : "border border-muted-foreground bg-background",
              )}
            />
            <Reveal delay={index * 160 + 80} className="space-y-4">
              <div className="flex items-center gap-3 text-foreground">
                <Icon className="size-6" />
                <span aria-hidden="true" className="num text-xs text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="text-xl font-medium tracking-tight">{t(`pipeline.steps.${key}.name`)}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{t(`pipeline.steps.${key}.body`)}</p>
              <StatusTag status={status}>{t(`status.${status}`)}</StatusTag>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}
