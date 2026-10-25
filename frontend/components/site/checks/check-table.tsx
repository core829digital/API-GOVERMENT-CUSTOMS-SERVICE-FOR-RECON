import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/site/reveal";
import { StatusTag, type Status } from "@/components/site/section";
import { Tr } from "./table-parts";

type Authority = "yes" | "partial" | "no";

// Source: docs/Research.md §3.4 (check catalogue, v1 candidates). Status: Progress.md / crates/recon-engine.
// Only C1 exists, on synthetic data; C8 is deliberately later. Identifiers are codes, not translated.
const CHECKS: readonly { id: "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7" | "c8"; code: string; authority: Authority; status: Status }[] = [
  { id: "c1", code: "C1", authority: "yes", status: "building" },
  { id: "c2", code: "C2", authority: "no", status: "planned" },
  { id: "c3", code: "C3", authority: "partial", status: "planned" },
  { id: "c4", code: "C4", authority: "partial", status: "planned" },
  { id: "c5", code: "C5", authority: "yes", status: "planned" },
  { id: "c6", code: "C6", authority: "yes", status: "planned" },
  { id: "c7", code: "C7", authority: "no", status: "planned" },
  { id: "c8", code: "C8", authority: "no", status: "later" },
];

// One column template for header and rows. Below the lg breakpoint (which includes everything at or under 640px)
// the rows become stacked cards and the header is visually hidden (it stays available to assistive technology);
// each cell then shows its own label.
const ROW = "grid grid-cols-[3rem_minmax(0,1.3fr)_minmax(0,1.3fr)_6rem_8.5rem] gap-x-6 max-lg:grid-cols-1 max-lg:gap-y-3";
const CELL_LABEL =
  "max-lg:grid max-lg:grid-cols-[7rem_minmax(0,1fr)] max-lg:gap-3 max-lg:before:font-mono max-lg:before:text-[0.68rem] max-lg:before:tracking-[0.16em] max-lg:before:text-muted-foreground max-lg:before:uppercase max-lg:before:content-[attr(data-label)]";

/** The check catalogue as a real table: caption, column headers, row headers; stacked cards on narrow screens. */
export async function CheckTable() {
  const t = await getTranslations("checks");
  return (
    <table role="table" className="block w-full text-left">
      <caption className="sr-only">{t("catalogue.caption")}</caption>
      <thead role="rowgroup" className="block max-lg:sr-only">
        <Tr className={cn(ROW, "border-b border-border px-5 pb-3")}>
          <th scope="col" role="columnheader" className="eyebrow text-left font-medium">
            {t("catalogue.columns.id")}
          </th>
          <th scope="col" role="columnheader" className="eyebrow text-left font-medium">
            {t("catalogue.columns.check")}
          </th>
          <th scope="col" role="columnheader" className="eyebrow text-left font-medium">
            {t("catalogue.columns.sources")}
          </th>
          <th scope="col" role="columnheader" className="eyebrow text-left font-medium">
            {t("catalogue.columns.authority")}
          </th>
          <th scope="col" role="columnheader" className="eyebrow text-left font-medium">
            {t("catalogue.columns.status")}
          </th>
        </Tr>
      </thead>
      <tbody role="rowgroup" className="mt-3 flex flex-col gap-2">
        {CHECKS.map(({ id, code, authority, status }, i) => (
          <Reveal key={id} as={Tr} delay={Math.min(i, 5) * 50} className={cn("plate items-start px-5 py-5", ROW)}>
            <th scope="row" role="rowheader" className="num text-left text-base font-medium">
              {code}
            </th>
            <td role="cell" data-label={t("catalogue.columns.check")} className={cn("text-sm leading-relaxed font-medium", CELL_LABEL)}>
              {t(`catalogue.rows.${id}.check`)}
            </td>
            <td role="cell" data-label={t("catalogue.columns.sources")} className={cn("text-sm leading-relaxed text-muted-foreground", CELL_LABEL)}>
              {t(`catalogue.rows.${id}.sources`)}
            </td>
            <td role="cell" data-label={t("catalogue.columns.authority")} className={cn("text-sm", CELL_LABEL)}>
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 border border-foreground",
                    authority === "yes" && "bg-foreground",
                    authority === "partial" && "bg-foreground/45",
                  )}
                />
                {t(`catalogue.authority.${authority}`)}
              </span>
            </td>
            <td role="cell" data-label={t("catalogue.columns.status")} className={cn(CELL_LABEL)}>
              <span>
                <StatusTag status={status}>{t(`status.${status}`)}</StatusTag>
              </span>
            </td>
          </Reveal>
        ))}
      </tbody>
    </table>
  );
}
