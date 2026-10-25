import type { en } from "./messages";
import type { Locale } from "./i18n/config";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}
