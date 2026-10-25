import { describe, expect, it } from "vitest";
import { defaultLocale, isLocale, negotiateLocale } from "@/i18n/config";

describe("negotiateLocale", () => {
  it("falls back to the default without a usable header", () => {
    expect(negotiateLocale(undefined)).toBe(defaultLocale);
    expect(negotiateLocale(null)).toBe(defaultLocale);
    expect(negotiateLocale("")).toBe(defaultLocale);
    expect(negotiateLocale("*")).toBe(defaultLocale);
    expect(negotiateLocale(";;;,,q=")).toBe(defaultLocale);
  });

  it("serves Belgium through its three languages", () => {
    expect(negotiateLocale("nl-BE")).toBe("nl");
    expect(negotiateLocale("fr-BE,fr;q=0.8,nl;q=0.5")).toBe("fr");
    expect(negotiateLocale("de-BE")).toBe("de");
  });

  it("decides on the language subtag, case-insensitively", () => {
    expect(negotiateLocale("PL-pl")).toBe("pl");
    expect(negotiateLocale("de-AT")).toBe("de");
    expect(negotiateLocale("es-419")).toBe("es");
  });

  it("honours quality values, and keeps header order among equals", () => {
    expect(negotiateLocale("it;q=0.4, fr;q=0.9")).toBe("fr");
    expect(negotiateLocale("pt;q=1, de;q=0.9, it;q=0.9")).toBe("de");
    expect(negotiateLocale("fr;q=0.5, it;q=0.5")).toBe("fr");
  });

  it("skips unsupported languages and refuses q=0", () => {
    expect(negotiateLocale("pt-BR, ja;q=0.8, ro;q=0.5")).toBe("ro");
    expect(negotiateLocale("pt-BR, ja")).toBe(defaultLocale);
    expect(negotiateLocale("it;q=0, fr;q=0.1")).toBe("fr");
    expect(negotiateLocale("it;q=0")).toBe(defaultLocale);
  });

  it("only ever returns a supported locale", () => {
    for (const header of ["en-US,en;q=0.9", "xx-YY", "toString", "__proto__", "constructor;q=1"]) {
      expect(isLocale(negotiateLocale(header))).toBe(true);
    }
  });
});
