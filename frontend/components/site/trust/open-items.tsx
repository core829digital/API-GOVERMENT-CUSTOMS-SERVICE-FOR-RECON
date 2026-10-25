import { getTranslations } from "next-intl/server";
import { Reveal } from "@/components/site/reveal";
import { StatusTag, type Status } from "@/components/site/section";

// Source: Progress.md §3 (open decisions D-2, D-3, D-5, D-7), §4 (risks), §7 (what was not verified).
// Every item is still open, so the only tags that apply are planned and later. None is a claim of completion.
const ITEMS: readonly { id: "failover" | "load" | "penTest" | "timestamp" | "owner" | "counsel" | "hosting" | "identity" | "certification"; status: Exclude<Status, "building"> }[] = [
  { id: "failover", status: "planned" },
  { id: "load", status: "planned" },
  { id: "timestamp", status: "planned" },
  { id: "owner", status: "planned" },
  { id: "counsel", status: "planned" },
  { id: "hosting", status: "planned" },
  { id: "identity", status: "planned" },
  { id: "penTest", status: "later" },
  { id: "certification", status: "later" },
];

/** Bordered list of everything that is not decided, built or measured yet. */
export async function OpenItems() {
  const t = await getTranslations("trust");
  return (
    <ul className="border border-border">
      {ITEMS.map(({ id, status }, i) => (
        <Reveal
          key={id}
          as="li"
          delay={Math.min(i, 5) * 50}
          className="grid gap-x-8 gap-y-3 border-b border-border p-5 last:border-b-0 md:grid-cols-12 md:p-6"
        >
          <h3 className="text-lg font-medium tracking-tight md:col-span-4">{t(`open.items.${id}.title`)}</h3>
          <p className="text-sm leading-relaxed text-muted-foreground md:col-span-6">{t(`open.items.${id}.body`)}</p>
          <div className="md:col-span-2 md:text-right">
            <StatusTag status={status}>{t(`status.${status}`)}</StatusTag>
          </div>
        </Reveal>
      ))}
    </ul>
  );
}
