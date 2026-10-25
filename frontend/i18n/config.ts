/**
 * Supported interface languages. Belgium has no language of its own: its users are served by `nl` (Flemish),
 * `fr` and `de`, which are selected from the regional tags `nl-BE`, `fr-BE` and `de-BE` (see `negotiateLocale`).
 */
export const locales = ["en", "ro", "it", "es", "fr", "de", "nl", "pl"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "recon_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Picks the supported locale a visitor prefers from an `Accept-Language` header: highest quality first, the
 * primary language subtag decides (`nl-BE` -> `nl`, `de-AT` -> `de`), quality 0 means "not acceptable", and
 * anything unsupported or malformed falls back to the default. Pure, so it can be tested without a request.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;
  const ranked = acceptLanguage
    .split(",")
    .map((part, position) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
      return { language: tag.trim().split("-")[0]?.toLowerCase() ?? "", q: q === undefined ? 1 : Number(q), position };
    })
    .filter((entry) => Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.position - b.position);
  return ranked.map((entry) => entry.language).find(isLocale) ?? defaultLocale;
}
