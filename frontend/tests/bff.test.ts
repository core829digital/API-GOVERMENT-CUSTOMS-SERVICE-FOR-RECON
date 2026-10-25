import { describe, expect, it } from "vitest";
import { downstreamHeaders, upstreamHeaders, upstreamPath, upstreamUrl } from "@/lib/bff";

const ID = "0190c1f2-7a3b-7c4d-8e5f-0123456789ab";

describe("upstreamUrl", () => {
  it("maps allowlisted /v1 routes onto the API base and keeps allowed query parameters", () => {
    expect(upstreamUrl("https://api.example/", ["v1", "findings"], "?limit=50&run_id=" + ID)?.href).toBe(
      `https://api.example/v1/findings?limit=50&run_id=${ID}`,
    );
    expect(upstreamUrl("https://api.example", ["v1", "batches", ID], "")?.href).toBe(
      `https://api.example/v1/batches/${ID}`,
    );
    expect(upstreamUrl("https://api.example", ["v1", "recon", "runs", ID], "")?.href).toBe(
      `https://api.example/v1/recon/runs/${ID}`,
    );
  });

  it("keeps a path prefix on the base URL", () => {
    expect(upstreamUrl("https://api.example/recon", ["v1", "batches", ID], "")?.href).toBe(
      `https://api.example/recon/v1/batches/${ID}`,
    );
  });

  it("rebuilds the query from the allowed parameters only, in a fixed order", () => {
    expect(upstreamPath(["v1", "findings"], "?run_id=" + ID + "&limit=5")).toBe(`/v1/findings?limit=5&run_id=${ID}`);
    expect(upstreamPath(["v1", "findings"], "")).toBe("/v1/findings");
  });

  it.each([
    [["findings"]],
    [["v2", "findings"]],
    [["v1"]],
    [["v1", "admin"]],
    [["v1", "findings", "extra"]],
    [["v1", "batches"]],
    [["v1", "batches", "not-a-uuid"]],
    [["v1", "batches", ID, "more"]],
    [["v1", "recon", "runs"]],
    [["v1", "..", "admin"]],
    [["v1", "findings", ".."]],
    [["v1", ".", "findings"]],
    [["v1", "", "findings"]],
    [["v1", "batches", `${ID}/..`]],
    [["v1", "batches", `..%2f${ID}`]],
    [["v1", "findings/../batches"]],
    [["v1", "a/b"]],
    [["v1", "a\\b"]],
    [["v1", "findings%2f"]],
    [["v1", "%2e%2e", "findings"]],
    [["v1", "batches", `${ID}\u0000`]],
    [["v1", "batches", `${ID}?x=1`]],
    [["V1", "findings"]],
    [[]],
  ])("rejects the path %j", (segments) => {
    expect(upstreamPath(segments, "")).toBeNull();
    expect(upstreamUrl("https://api.example", segments, "")).toBeNull();
  });

  it.each([
    ["?severity=high"],
    ["?limit=5&limit=6"],
    ["?limit="],
    ["?limit=" + "9".repeat(129)],
    ["?check_code=C1%00"],
    ["?check_code=a%0Ab"],
    ["?run_id=" + ID + "&redirect=https://evil.example"],
  ])("rejects the query %s", (search) => {
    expect(upstreamPath(["v1", "findings"], search)).toBeNull();
  });

  it("accepts no query parameters on id routes", () => {
    expect(upstreamPath(["v1", "batches", ID], "?limit=5")).toBeNull();
  });
});

describe("upstreamHeaders", () => {
  it("sends only the fixed headers and an allowlisted, valid X-Min-Seq", () => {
    const inbound = new Headers({
      cookie: "session=secret",
      host: "evil.example",
      "x-forwarded-for": "6.6.6.6",
      "x-forwarded-host": "evil.example",
      authorization: "Bearer attacker",
      "x-recon-key-id": "forged",
      "x-recon-signature": "forged",
      "idempotency-key": "k",
      "transfer-encoding": "chunked",
      "x-min-seq": "42",
    });
    const out = upstreamHeaders(inbound, "rk_token");
    expect([...out.keys()].sort()).toEqual(["accept", "authorization", "x-min-seq"]);
    expect(out.get("authorization")).toBe("Bearer rk_token");
    expect(out.get("x-min-seq")).toBe("42");
  });

  it.each(["", "-1", "1e3", "9".repeat(20), "0x10", "4\r\nx-injected: 1"])("drops X-Min-Seq %j", (value) => {
    const inbound = new Headers();
    try {
      inbound.set("x-min-seq", value);
    } catch {
      return; // the Headers class itself refuses values with line breaks
    }
    expect(upstreamHeaders(inbound, "t").has("x-min-seq")).toBe(false);
  });
});

describe("downstreamHeaders", () => {
  it("passes only the content type, retry and rate-limit hints, and forces no-store", () => {
    const out = downstreamHeaders(
      new Headers({
        "content-type": "application/json",
        "retry-after": "3",
        "ratelimit-limit": "100",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "3",
        "set-cookie": "a=b",
        location: "https://evil.example",
        "access-control-allow-origin": "*",
        "x-commit-seq": "9",
      }),
    );
    expect([...out.keys()].sort()).toEqual([
      "cache-control",
      "content-type",
      "ratelimit-limit",
      "ratelimit-remaining",
      "ratelimit-reset",
      "retry-after",
    ]);
    expect(out.get("cache-control")).toBe("no-store");
  });
});
