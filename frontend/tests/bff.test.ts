import { describe, expect, it } from "vitest";
import { upstreamUrl } from "@/lib/bff";

describe("upstreamUrl", () => {
  it("maps /v1 paths onto the API base and keeps the query string", () => {
    expect(upstreamUrl("https://api.example/", ["v1", "findings"], "?severity=high")?.href).toBe(
      "https://api.example/v1/findings?severity=high",
    );
  });

  it("keeps a path prefix on the base URL", () => {
    expect(upstreamUrl("https://api.example/recon", ["v1", "batches", "abc"], "")?.href).toBe(
      "https://api.example/recon/v1/batches/abc",
    );
  });

  it("percent-encodes segments instead of letting them alter the path", () => {
    expect(upstreamUrl("https://api.example", ["v1", "a b", "c?d"], "")?.pathname).toBe(
      "/v1/a%20b/c%3Fd",
    );
  });

  it.each([
    [["findings"]],
    [["v2", "findings"]],
    [["v1", "..", "admin"]],
    [["v1", ".", "findings"]],
    [["v1", "", "findings"]],
    [["v1", "a/b"]],
    [["v1", "a\\b"]],
    [[]],
  ])("rejects %j", (segments) => {
    expect(upstreamUrl("https://api.example", segments, "")).toBeNull();
  });
});
