import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { catalogs } from "../messages";
import { isLocale, LOCALE_COOKIE, negotiateLocale } from "./config";

// An explicit choice (the cookie set by the language switcher) always wins; otherwise the browser's
// `Accept-Language` decides, so a first-time visitor from any supported country lands in their own language.
export default getRequestConfig(async () => {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(stored) ? stored : negotiateLocale((await headers()).get("accept-language"));
  return { locale, messages: catalogs[locale] };
});
