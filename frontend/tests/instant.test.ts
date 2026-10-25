import { describe, expect, it } from "vitest";
import { instant } from "@/lib/api/schemas";

describe("instant", () => {
  it("parses the API's microsecond timestamps (Date accepts three fractional digits)", () => {
    const d = instant("2026-10-25T00:12:18.123456Z");
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.toISOString()).toBe("2026-10-25T00:12:18.123Z");
  });

  it("keeps millisecond and second precision unchanged", () => {
    expect(instant("2026-10-25T00:12:18.123Z").toISOString()).toBe("2026-10-25T00:12:18.123Z");
    expect(instant("2026-10-25T00:12:18Z").toISOString()).toBe("2026-10-25T00:12:18.000Z");
  });
});
