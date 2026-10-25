import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/site/reveal";
import { TALL, WIDE, type Layout, type Tone } from "./store-diagram-geometry";
import styles from "./store-diagram.module.css";

const TONE: Record<Tone, string> = {
  write: "text-signal",
  read: "text-foreground",
  link: "text-muted-foreground",
};

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

async function Drawing({ layout, className }: { layout: Layout; className: string }) {
  const t = await getTranslations("platform");
  const compact = layout === TALL;
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={t("stores.diagram.label")}
      className={cn("h-auto w-full", className)}
      fill="none"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {layout.lines.map((line, i) => (
        <g key={line.id} className={TONE[line.tone]}>
          <path
            d={line.d}
            pathLength={1}
            stroke="currentColor"
            strokeWidth={1.5}
            className={styles.draw}
            style={delay(300 + i * 220)}
          />
          <path d={line.head} stroke="currentColor" strokeWidth={1.5} className={styles.fade} style={delay(1100 + i * 220)} />
        </g>
      ))}
      {layout.nodes.map((node, i) => {
        const cx = node.x + node.w / 2;
        const cy = node.y + node.h / 2;
        const emphasised = node.id === "w";
        return (
          <g key={node.id} className={styles.fade} style={delay(i * 120)}>
            <rect
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              strokeWidth={emphasised ? 2 : 1}
              className={cn("fill-card", emphasised ? "stroke-signal" : "stroke-foreground/40")}
            />
            <text x={cx} y={cy - 4} textAnchor="middle" className={cn("fill-foreground font-medium", compact ? "text-[22px]" : "text-[24px]")}>
              {t(`stores.diagram.nodes.${node.id}.name`)}
            </text>
            <text x={cx} y={cy + 20} textAnchor="middle" className="fill-muted-foreground text-[14px]">
              {t(`stores.diagram.nodes.${node.id}.note`)}
            </text>
          </g>
        );
      })}
      {layout.labels.map((label, i) => (
        <text
          key={`${label.flow}-${i}`}
          x={label.x}
          y={label.y}
          textAnchor={label.anchor}
          className={cn("font-mono text-[13px] tracking-wide", styles.fade, label.tone === "write" ? "fill-signal" : label.tone === "read" ? "fill-foreground" : "fill-muted-foreground")}
          style={delay(900 + i * 100)}
        >
          {t(`stores.diagram.flows.${label.flow}`)}
        </text>
      ))}
    </svg>
  );
}

/**
 * Hand-built diagram: clients call the API; commands go to W, queries go to R; W replicates to R; the engine reads
 * R and writes W. The visible caption below it is the text alternative for the same relationships.
 */
export async function StoreDiagram() {
  const t = await getTranslations("platform");
  return (
    <Reveal kind="fade">
      <figure className="plate p-6 md:p-10">
        <Drawing layout={TALL} className="mx-auto max-w-[28rem] lg:hidden" />
        <Drawing layout={WIDE} className="hidden lg:block" />
        <figcaption className="mt-6 max-w-[48rem] border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          {t("stores.diagram.caption")}
        </figcaption>
      </figure>
    </Reveal>
  );
}
