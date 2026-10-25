import { getTranslations } from "next-intl/server";
import { EvidenceIcon, IngestIcon, NormaliseIcon, ReconcileIcon, DatabaseIcon, type IconProps } from "@/components/icons";
import { Reveal } from "@/components/site/reveal";
import { StatusTag, type Status } from "@/components/site/section";
import type { ComponentType } from "react";

// Status of each step as of today (Progress.md): see the platform page copy for the exact wording per step.
const STEPS: readonly { id: "ingest" | "normalise" | "reconcile" | "project" | "evidence"; status: Status; Icon: ComponentType<IconProps> }[] = [
  { id: "ingest", status: "building", Icon: IngestIcon },
  { id: "normalise", status: "planned", Icon: NormaliseIcon },
  { id: "reconcile", status: "building", Icon: ReconcileIcon },
  { id: "project", status: "planned", Icon: DatabaseIcon },
  { id: "evidence", status: "building", Icon: EvidenceIcon },
];

/** The five-step data flow as an ordered list of plates under a hairline rail. */
export async function DataFlow() {
  const t = await getTranslations("platform");
  return (
    <div>
      <Reveal kind="line" className="mb-8 hidden h-px bg-foreground/40 lg:block" />
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {STEPS.map(({ id, status, Icon }, i) => (
          <Reveal key={id} as="li" delay={i * 90} className="plate flex flex-col gap-5 p-6">
            <div className="flex items-center justify-between">
              <Icon className="size-7" />
              <span className="eyebrow num text-foreground" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
            </div>
            <h3 className="text-xl font-medium tracking-tight">{t(`flow.steps.${id}.name`)}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{t(`flow.steps.${id}.body`)}</p>
            <div className="mt-auto pt-2">
              <StatusTag status={status}>{t(`status.${status}`)}</StatusTag>
            </div>
          </Reveal>
        ))}
      </ol>
    </div>
  );
}
