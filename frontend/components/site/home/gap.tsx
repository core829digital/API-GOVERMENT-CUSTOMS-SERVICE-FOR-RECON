import { getTranslations } from "next-intl/server";
import { Reveal } from "@/components/site/reveal";
import { Section, StatusTag, type Status } from "@/components/site/section";

const INPUTS = [
  { key: "erp", status: "planned" },
  { key: "clearance", status: "building" },
  { key: "returns", status: "planned" },
] as const satisfies readonly { key: string; status: Status }[];

/** The problem in plain words, then the three kinds of input the product reads, each with its real status. */
export async function Gap() {
  const t = await getTranslations("home");
  return (
    <Section id="gap" eyebrow={t("gap.eyebrow")} title={t("gap.title")} lead={t("gap.lead")}>
      <Reveal>
        <p className="eyebrow mb-6">{t("gap.inputsLabel")}</p>
      </Reveal>
      <ul className="grid gap-4 md:grid-cols-3">
        {INPUTS.map(({ key, status }, index) => (
          <Reveal key={key} as="li" delay={index * 90} className="plate flex flex-col gap-5 p-6 md:p-8">
            <span aria-hidden="true" className="num text-xs text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="text-xl leading-snug font-medium tracking-tight">{t(`gap.items.${key}.title`)}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{t(`gap.items.${key}.body`)}</p>
            <div className="mt-auto pt-2">
              <StatusTag status={status}>{t(`status.${status}`)}</StatusTag>
            </div>
          </Reveal>
        ))}
      </ul>
    </Section>
  );
}
