import { getTranslations } from "next-intl/server";
import { Reveal } from "@/components/site/reveal";

// Order matters: for each invoice reference the first matching outcome wins (crates/recon-engine/src/c1.rs).
const OUTCOMES = ["noClearance", "notAccepted", "amountMismatch", "orphan"] as const;

/** The four C1 outcomes, one line each, in evaluation order. The only "live" detail on the checks page. */
export async function C1Outcomes() {
  const t = await getTranslations("checks");
  return (
    <div className="space-y-8">
      <ol className="border-b border-border">
        {OUTCOMES.map((id, i) => (
          <li key={id} className="relative py-5">
            <Reveal kind="line" delay={i * 60} className="absolute inset-x-0 top-0 h-px bg-border" />
            <Reveal delay={i * 60 + 80} className="flex items-baseline gap-5">
              <span className="num w-8 shrink-0 text-lg text-signal" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="max-w-[44rem] leading-relaxed">{t(`c1.outcomes.${id}`)}</span>
            </Reveal>
          </li>
        ))}
      </ol>
      <Reveal>
        <p className="max-w-[44rem] text-sm leading-relaxed text-muted-foreground">{t("c1.note")}</p>
      </Reveal>
    </div>
  );
}
