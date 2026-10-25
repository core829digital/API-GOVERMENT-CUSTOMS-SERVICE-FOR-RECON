import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { Reveal } from "@/components/site/reveal";
import { Section, StatusTag } from "@/components/site/section";

/** `exists` runs today on synthetic data; `rule` and `decision` are design constraints that are not yet verified. */
const PRINCIPLES = [
  { key: "determinism", kind: "exists" },
  { key: "isolation", kind: "exists" },
  { key: "ledger", kind: "exists" },
  { key: "privacy", kind: "rule" },
  { key: "rules", kind: "rule" },
  { key: "residency", kind: "decision" },
] as const;

/** Six invariants the product is built around, each labelled with whether it exists today or is a design intent. */
export async function Principles() {
  const t = await getTranslations("home");
  return (
    <Section
      id="principles"
      index="03"
      eyebrow={t("principles.eyebrow")}
      title={t("principles.title")}
      lead={t("principles.lead")}
    >
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {PRINCIPLES.map(({ key, kind }, index) => (
          <Reveal key={key} as="li" delay={(index % 3) * 90} className="plate flex flex-col gap-5 p-6 md:p-8">
            <span aria-hidden="true" className="num text-xs text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="text-xl leading-snug font-medium tracking-tight">{t(`principles.items.${key}.title`)}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{t(`principles.items.${key}.body`)}</p>
            <div className="mt-auto pt-2">
              {kind === "exists" ? (
                <StatusTag status="building">{t("principles.kind.exists")}</StatusTag>
              ) : (
                <span className="inline-flex items-center gap-2 border border-dashed px-2 py-1 font-mono text-[0.68rem] tracking-[0.14em] uppercase">
                  <span aria-hidden="true" className="size-1.5 border border-dashed border-muted-foreground" />
                  {t(`principles.kind.${kind}`)}
                </span>
              )}
            </div>
          </Reveal>
        ))}
      </ul>
      <Reveal className="mt-10">
        <Link href="/trust" className="link-sweep group inline-flex items-center gap-3 text-sm font-medium">
          {t("principles.trustLink")}
          <ArrowRightIcon className="size-4 motion-safe:transition-transform motion-safe:group-hover:translate-x-1" />
        </Link>
      </Reveal>
    </Section>
  );
}
