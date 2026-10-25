import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, BFF_PREFIX } from "@/lib/api/client";
import { ApiError, kindForResponse } from "@/lib/api/errors";
import { findingListSchema } from "@/lib/api/schemas";

afterEach(() => vi.unstubAllGlobals());

const finding = {
  finding_id: "0190c1f2-0000-7000-8000-000000000001",
  check_code: "C1",
  severity: "high",
  jurisdiction: "RO",
  summary: "Totals differ",
  rule_citation: "Art. 1",
  created_at: "2026-10-01T10:00:00Z",
};

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected rejection");
}

describe("kindForResponse", () => {
  it.each([
    [401, false, "unauthenticated"],
    [404, false, "not_found"],
    [503, true, "replica_lag"],
    [503, false, "unavailable"],
    [500, false, "unavailable"],
    [502, true, "unavailable"],
  ] as const)("%i (retry-after: %s) -> %s", (status, retryAfter, kind) => {
    expect(kindForResponse(status, retryAfter)).toBe(kind);
  });
});

describe("apiGet", () => {
  it("only calls the same-origin BFF and returns validated data", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [finding] }));
    vi.stubGlobal("fetch", fetchMock);
    const data = await apiGet("/v1/findings", findingListSchema);
    expect(fetchMock).toHaveBeenCalledWith(`${BFF_PREFIX}/v1/findings`, expect.anything());
    expect(data.items[0]?.check_code).toBe("C1");
  });

  it("reports a body that violates the contract instead of rendering it", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ items: [{ ...finding, severity: "critical" }] }));
    const error = await rejection(apiGet("/v1/findings", findingListSchema));
    expect(error.kind).toBe("invalid_response");
  });

  it("reports a non-JSON success body as invalid_response", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    expect((await rejection(apiGet("/v1/findings", findingListSchema))).kind).toBe("invalid_response");
  });

  it("maps 401, 404 and 503+Retry-After", async () => {
    const respond = (status: number, headers?: HeadersInit) => {
      vi.stubGlobal("fetch", async () => new Response(null, { status, headers }));
      return rejection(apiGet("/v1/findings", findingListSchema));
    };
    expect((await respond(401)).kind).toBe("unauthenticated");
    expect((await respond(404)).kind).toBe("not_found");
    expect((await respond(503, { "retry-after": "2" })).kind).toBe("replica_lag");
  });

  it("maps a failed request to network", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("failed");
    });
    expect((await rejection(apiGet("/v1/findings", findingListSchema))).kind).toBe("network");
  });
});
