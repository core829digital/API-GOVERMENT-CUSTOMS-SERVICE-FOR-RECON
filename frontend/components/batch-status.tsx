"use client";

import { useFormatter, useTranslations } from "next-intl";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import { useBatch } from "@/lib/api/hooks";
import { batchIdSchema, instant, type Batch } from "@/lib/api/schemas";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-3 sm:gap-4">
      <dt className="eyebrow self-center">{label}</dt>
      <dd className="text-sm sm:col-span-2">{children}</dd>
    </div>
  );
}

function BatchDetails({ batch }: { batch: Batch }) {
  const t = useTranslations();
  const format = useFormatter();
  const date = (value: string) =>
    format.dateTime(new Date(`${value}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });

  return (
    <dl className="divide-y border bg-card px-5">
      <Field label={t("batch.fields.id")}>
        <span className="font-mono break-all">{batch.id}</span>
      </Field>
      <Field label={t("batch.fields.status")}>
        <Badge
          variant="outline"
          className={
            batch.status === "failed"
              ? "border-sev-high text-sev-high"
              : batch.status === "parsed"
                ? "border-signal text-signal"
                : ""
          }
        >
          <span aria-hidden="true" className="size-1.5 bg-current" />
          {t(`batch.status.${batch.status}`)}
        </Badge>
      </Field>
      <Field label={t("batch.fields.sourceType")}>
        <span className="font-mono">{batch.source_type}</span>
      </Field>
      <Field label={t("batch.fields.period")}>
        {batch.period_start && batch.period_end
          ? t("batch.periodRange", {
              start: date(batch.period_start),
              end: date(batch.period_end),
            })
          : t("common.none")}
      </Field>
      <Field label={t("batch.fields.created")}>
        <time dateTime={batch.created_at}>
          {/* `dateStyle`/`timeStyle` cannot be combined with `timeZoneName`; spell the fields out. */}
          {format.dateTime(instant(batch.created_at), {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
            timeZoneName: "short",
          })}
        </time>
      </Field>
      {batch.failure_reason ? (
        <Field label={t("batch.fields.failureReason")}>{batch.failure_reason}</Field>
      ) : null}
    </dl>
  );
}

function BatchQuery({ id }: { id: string }) {
  const t = useTranslations();
  const batch = useBatch(id);

  if (batch.isPending) {
    return (
      <div aria-busy="true" className="space-y-2">
        <p role="status" className="sr-only">
          {t("common.loading")}
        </p>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" aria-hidden="true" />
        ))}
      </div>
    );
  }
  if (batch.isError) {
    return <QueryError error={batch.error} onRetry={() => void batch.refetch()} />;
  }
  return <BatchDetails batch={batch.data} />;
}

export function BatchStatus({ id }: { id: string }) {
  // An id that cannot be a UUID is answered locally; it is never put on the wire.
  if (!batchIdSchema.safeParse(id).success) {
    return <QueryError error={new ApiError("not_found", null)} />;
  }
  return <BatchQuery id={id} />;
}
