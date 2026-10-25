import type { ReactNode } from "react";
import { Reveal } from "@/components/site/reveal";
import { StatusTag, type Status } from "@/components/site/section";

export interface Fact {
  id: string;
  title: string;
  body: ReactNode;
  /** Optional mono line for a command or identifier. Code, not translated. */
  code?: string;
  /** Optional qualifier shown under the body, e.g. how far something was exercised. */
  detail?: string;
  tag?: { status: Status; label: string };
}

/**
 * Hairline-separated rows: title and status on the left, plain-language body on the right. Each row's hairline
 * draws in, then the content rises. Used by the platform, checks and trust pages.
 */
export function FactList({ items }: { items: readonly Fact[] }) {
  return (
    <ul className="border-b border-border">
      {items.map((item, i) => (
        <li key={item.id} className="relative py-8 md:py-10">
          <Reveal kind="line" className="absolute inset-x-0 top-0 h-px bg-border" />
          <Reveal delay={60} className="grid gap-5 lg:grid-cols-12 lg:gap-12">
            <div className="space-y-4 lg:col-span-4">
              <p className="eyebrow num" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </p>
              <h3 className="text-xl font-medium tracking-tight text-balance">{item.title}</h3>
              {item.tag ? <StatusTag status={item.tag.status}>{item.tag.label}</StatusTag> : null}
            </div>
            <div className="space-y-4 lg:col-span-8">
              <p className="max-w-[44rem] leading-relaxed">{item.body}</p>
              {item.code ? (
                <p>
                  <code className="num inline-block max-w-full border border-border px-2 py-1 text-sm break-all">{item.code}</code>
                </p>
              ) : null}
              {item.detail ? <p className="max-w-[44rem] text-sm leading-relaxed text-muted-foreground">{item.detail}</p> : null}
            </div>
          </Reveal>
        </li>
      ))}
    </ul>
  );
}
