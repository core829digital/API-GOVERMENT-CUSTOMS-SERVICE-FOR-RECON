import { describe, expect, it } from "vitest";
import { DEFAULT_RETURN_TO, safeReturnTo } from "@/lib/auth/return-to";

describe("safeReturnTo", () => {
  it.each(["/", "/findings", "/batches/0190c1f2-0000-7000-8000-000000000000?x=1#y"])(
    "keeps same-origin path %s",
    (path) => {
      expect(safeReturnTo(path)).toBe(path);
    },
  );

  it("falls back to the console overview, not the marketing home", () => {
    expect(DEFAULT_RETURN_TO).toBe("/overview");
  });

  it.each([
    null,
    undefined,
    "",
    "findings",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/\t/evil.example",
    "/\n/evil.example",
  ])("falls back to /overview for %j", (value) => {
    expect(safeReturnTo(value)).toBe("/overview");
  });
});
