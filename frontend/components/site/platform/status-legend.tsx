import { StatusTag, type Status } from "@/components/site/section";

export interface LegendItem {
  status: Status;
  label: string;
  hint: string;
}

/** Explains the three status tags used on a page. Sits in the page hero. */
export function StatusLegend({ items }: { items: readonly LegendItem[] }) {
  return (
    <dl className="grid max-w-[56rem] gap-x-8 gap-y-5 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.status} className="space-y-3 border-t border-border pt-4">
          <dt>
            <StatusTag status={item.status}>{item.label}</StatusTag>
          </dt>
          <dd className="text-sm leading-relaxed text-muted-foreground">{item.hint}</dd>
        </div>
      ))}
    </dl>
  );
}
