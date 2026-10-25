"use client";

import { useFormatter, useTranslations } from "next-intl";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFindings } from "@/lib/api/hooks";
import type { Severity } from "@/lib/api/schemas";

const severityClass: Record<Severity, string> = {
  info: "border-sev-info text-sev-info",
  low: "border-sev-low text-sev-low",
  medium: "border-sev-medium text-sev-medium",
  high: "border-sev-high text-sev-high",
};

export function FindingsTable() {
  const t = useTranslations();
  const format = useFormatter();
  const findings = useFindings();

  if (findings.isPending) {
    return (
      <div aria-busy="true" className="space-y-2">
        <p role="status" className="sr-only">
          {t("common.loading")}
        </p>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (findings.isError) {
    return <QueryError error={findings.error} onRetry={() => void findings.refetch()} />;
  }

  if (findings.data.items.length === 0) {
    return (
      <div className="relative isolate overflow-hidden border bg-card p-10 text-center">
        <div
          aria-hidden="true"
          className="pat-grid pointer-events-none absolute inset-0 -z-10 text-foreground [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
        />
        <p className="font-medium">{t("findings.empty.title")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("findings.empty.description")}</p>
      </div>
    );
  }

  return (
    <Table
      containerProps={{
        role: "region",
        tabIndex: 0,
        "aria-label": t("findings.tableLabel"),
        className:
          "border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring",
      }}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t("findings.columns.check")}</TableHead>
          <TableHead>{t("findings.columns.severity")}</TableHead>
          <TableHead>{t("findings.columns.jurisdiction")}</TableHead>
          <TableHead>{t("findings.columns.summary")}</TableHead>
          <TableHead>{t("findings.columns.citation")}</TableHead>
          <TableHead>{t("findings.columns.created")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.data.items.map((finding) => (
          <TableRow key={finding.finding_id}>
            <TableCell className="font-mono tracking-wider">{finding.check_code}</TableCell>
            <TableCell>
              <Badge variant="outline" className={severityClass[finding.severity]}>
                <span aria-hidden="true" className="size-1.5 bg-current" />
                {t(`findings.severity.${finding.severity}`)}
              </Badge>
            </TableCell>
            <TableCell>{finding.jurisdiction ?? t("common.none")}</TableCell>
            <TableCell className="min-w-64 whitespace-normal">{finding.summary}</TableCell>
            <TableCell className="min-w-48 whitespace-normal">{finding.rule_citation}</TableCell>
            <TableCell>
              <time dateTime={finding.created_at}>
                {format.dateTime(new Date(finding.created_at), {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "UTC",
                  timeZoneName: "short",
                })}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
