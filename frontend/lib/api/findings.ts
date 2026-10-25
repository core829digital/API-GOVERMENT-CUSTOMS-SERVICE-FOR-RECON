import { apiGet } from "./client";
import { findingListSchema } from "./schemas";

export function listFindings(init: { signal?: AbortSignal } = {}) {
  return apiGet("/v1/findings", findingListSchema, init);
}
