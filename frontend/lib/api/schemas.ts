import "@/lib/zod-config";
import { z } from "zod";

// Wire shapes are taken from DatabaseInfo.md (`proj.finding_view`, `ingest.source_batch`).
// The OpenAPI spec does not exist yet; when it does, replace this module with the
// `openapi-typescript` output (Architecture.md §12). Every response is validated, so a
// mismatch surfaces as an `invalid_response` error instead of rendering wrong data.

export const severitySchema = z.enum(["info", "low", "medium", "high"]);
export type Severity = z.infer<typeof severitySchema>;

export const findingSchema = z.object({
  finding_id: z.string(),
  check_code: z.string(),
  severity: severitySchema,
  jurisdiction: z.string().nullable(),
  summary: z.string(),
  rule_citation: z.string(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingListSchema = z.object({ items: z.array(findingSchema) });
export type FindingList = z.infer<typeof findingListSchema>;

export const batchStatusSchema = z.enum(["registered", "parsing", "parsed", "failed"]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const batchSchema = z.object({
  id: z.string(),
  source_type: z.string(),
  period_start: z.iso.date().nullable(),
  period_end: z.iso.date().nullable(),
  status: batchStatusSchema,
  failure_reason: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type Batch = z.infer<typeof batchSchema>;

/** Batch ids are UUIDv7 (DatabaseInfo.md); anything that is not a UUID is rejected before a request is made. */
export const batchIdSchema = z.uuid();

/**
 * Parses an ISO-8601 instant from the API. The API emits PostgreSQL microseconds (six fractional digits) and
 * `Date` accepts at most three, so the extra digits are dropped rather than producing an Invalid Date.
 */
export function instant(value: string): Date {
  return new Date(value.replace(/(\.\d{3})\d+/, "$1"));
}
