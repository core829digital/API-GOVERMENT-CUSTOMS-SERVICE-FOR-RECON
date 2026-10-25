import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/site/reveal";

/** Page-width container shared by every public page. */
export function Container({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mx-auto w-full max-w-[84rem] px-6 md:px-10", className)} {...props} />;
}

/**
 * A page section: a hairline that draws in, an index plate on the left, title and lead on the right, content
 * underneath. All text arrives already translated.
 */
export function Section({
  id,
  index,
  eyebrow,
  title,
  lead,
  children,
  className,
}: {
  id?: string;
  /** Short mono index such as "01". Decorative, not translated. */
  index?: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("relative py-20 md:py-28", className)} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="absolute inset-x-0 top-0" aria-hidden="true">
        <Container>
          <Reveal kind="line" className="h-px bg-border" />
        </Container>
      </div>
      <Container>
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-12">
          <Reveal className="lg:col-span-4">
            <p className="eyebrow flex items-center gap-3">
              {index ? <span className="num text-foreground">{index}</span> : null}
              <span>{eyebrow}</span>
            </p>
          </Reveal>
          <div className="space-y-6 lg:col-span-8">
            <Reveal delay={60}>
              <h2 id={id ? `${id}-title` : undefined} className="headline">
                {title}
              </h2>
            </Reveal>
            {lead ? (
              <Reveal delay={120}>
                <p className="lead max-w-[46rem]">{lead}</p>
              </Reveal>
            ) : null}
          </div>
        </div>
        {children ? <div className="mt-14 md:mt-20">{children}</div> : null}
      </Container>
    </section>
  );
}

/** Top of an inner page: eyebrow, h1, lead. The page's only h1. */
export function PageHero({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="relative isolate overflow-hidden pt-36 pb-20 md:pt-48 md:pb-28">
      <div className="pat-grid pointer-events-none absolute inset-0 -z-10 text-foreground [mask-image:linear-gradient(to_bottom,black,transparent_85%)]" aria-hidden="true" />
      <Container>
        <Reveal>
          <p className="eyebrow">{eyebrow}</p>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="display mt-6 max-w-[18ch]">{title}</h1>
        </Reveal>
        {lead ? (
          <Reveal delay={160}>
            <p className="lead mt-8 max-w-[44rem]">{lead}</p>
          </Reveal>
        ) : null}
        {children ? <Reveal delay={220} className="mt-10">{children}</Reveal> : null}
      </Container>
    </header>
  );
}

export type Status = "building" | "planned" | "later";

/** Mono status tag. The label is translated by the caller; the status only picks the marker. */
export function StatusTag({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 border border-border px-2 py-1 font-mono text-[0.68rem] tracking-[0.14em] uppercase">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5",
          status === "building" && "bg-signal",
          status === "planned" && "border border-muted-foreground",
          status === "later" && "border border-dashed border-muted-foreground",
        )}
      />
      {children}
    </span>
  );
}
