import { apiGet } from "./client";
import { batchSchema } from "./schemas";

export function getBatch(id: string, init: { signal?: AbortSignal } = {}) {
  return apiGet(`/v1/batches/${encodeURIComponent(id)}`, batchSchema, init);
}
