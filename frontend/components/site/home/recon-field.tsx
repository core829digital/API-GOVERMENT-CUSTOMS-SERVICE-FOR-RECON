"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { CHECK_CODE, ROWS, SYNTHETIC_RULE, type LedgerRow } from "@/components/site/home/data";

const hashClass = "hidden sm:inline lg:hidden xl:inline";
const cell = "flex h-10 items-center gap-2 overflow-hidden border-b px-2 whitespace-nowrap sm:gap-3 sm:px-3";

/** Connectors start drawing 250 ms after the figure enters view, 140 ms apart, so the pairs are checked in turn. */
const delayStyle = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

/**
 * The hero illustration: two ledgers side by side, a connector per matching pair and one pair that does not
 * match, flagged with a cited rule. Pure HTML and CSS; the connectors draw in once, when the figure scrolls
 * into view, through the same `data-reveal` mechanism as `Reveal` (so it is inert without scripting and under
 * reduced motion). Every record shown is synthetic and decorative, so the grid is hidden from assistive
 * technology and a text description stands in for it.
 */
export function ReconField() {
  const t = useTranslations("home.field");
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        for (const node of root.querySelectorAll("[data-reveal]")) node.setAttribute("data-inview", "");
        observer.disconnect();
      },
      { threshold: 0.25 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <figure ref={ref} className="relative min-w-0">
      <p className="sr-only">{t("description")}</p>
      <div
        aria-hidden="true"
        className="grid grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)] border bg-card font-mono text-[0.68rem] sm:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1fr)] sm:text-xs"
      >
        <p className="eyebrow flex items-end border-b px-2 py-3 text-[0.62rem] leading-tight sm:px-3 sm:text-[0.72rem]">{t("books")}</p>
        <span className="border-b" />
        <p className="eyebrow flex items-end border-b px-2 py-3 text-[0.62rem] leading-tight sm:px-3 sm:text-[0.72rem]">{t("authority")}</p>
        {ROWS.map((row, index) => (
          <Pair key={row.ref} row={row} index={index} mismatch={t("mismatch")} rule={t("rule")} status={t(`status.${row.status}`)} />
        ))}
      </div>
      <figcaption className="mt-4 flex items-start gap-3 text-xs text-muted-foreground">
        <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 border border-muted-foreground" />
        {t("caption")}
      </figcaption>
    </figure>
  );
}

function Pair({ row, index, mismatch, rule, status }: { row: LedgerRow; index: number; mismatch: string; rule: string; status: string }) {
  const flagged = row.flagged === true;
  const delay = 250 + index * 140;
  const side = cn(cell, flagged ? "bg-secondary text-foreground" : "text-muted-foreground");
  return (
    <>
      <div className={cn(side, flagged && "border-l-2 border-l-signal")}>
        <span className={cn(flagged && "font-medium")}>{row.ref}</span>
        <span className={hashClass}>{row.booksHash}</span>
        <span className="num ml-auto">{row.amount}</span>
      </div>
      <div className="flex h-10 items-center border-b">
        {flagged ? (
          <>
            <span data-reveal="line" style={delayStyle(delay)} className="h-px flex-1 bg-signal" />
            <span
              data-reveal="fade"
              style={delayStyle(delay + 260)}
              className="mx-1 size-2.5 shrink-0 border border-signal bg-background"
            />
            <span data-reveal="line" style={delayStyle(delay + 120)} className="h-px flex-1 bg-signal" />
          </>
        ) : (
          <span data-reveal="line" style={delayStyle(delay)} className="h-px w-full bg-muted-foreground/60" />
        )}
      </div>
      <div className={side}>
        <span className={cn(flagged && "font-medium")}>{row.ref}</span>
        <span className={hashClass}>{row.authorityHash}</span>
        <span className={cn("ml-auto uppercase", flagged && "font-medium text-signal")}>{status}</span>
      </div>
      {flagged ? (
        <div
          data-reveal="fade"
          style={delayStyle(delay + 420)}
          className="col-span-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-l-2 border-l-signal bg-card px-2 py-3 sm:px-3"
        >
          <span className="eyebrow text-[0.62rem] text-signal sm:text-[0.72rem]">{mismatch}</span>
          <span className="text-foreground">{CHECK_CODE}</span>
          <span className="eyebrow text-[0.62rem] sm:text-[0.72rem]">{rule}</span>
          <span className="min-w-0 break-all text-foreground">{SYNTHETIC_RULE}</span>
        </div>
      ) : null}
    </>
  );
}
