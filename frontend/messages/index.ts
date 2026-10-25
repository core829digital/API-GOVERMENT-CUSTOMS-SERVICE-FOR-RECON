// The catalogs are split per area so that independent pages own independent files, and per language.
// Each file contributes distinct top-level namespaces; `merge` refuses to start when two files claim the same one.
// `catalogs[locale]` is typed from `en`; the parity test (tests/i18n.test.ts) keeps every other language key-identical.
import enApp from "./en/app.json" with { type: "json" };
import enSite from "./en/site.json" with { type: "json" };
import enPages from "./en/pages.json" with { type: "json" };
import enHome from "./en/home.json" with { type: "json" };
import enPlatform from "./en/platform.json" with { type: "json" };
import enChecks from "./en/checks.json" with { type: "json" };
import enTrust from "./en/trust.json" with { type: "json" };
import enLogin from "./en/login.json" with { type: "json" };
import roApp from "./ro/app.json" with { type: "json" };
import roSite from "./ro/site.json" with { type: "json" };
import roPages from "./ro/pages.json" with { type: "json" };
import roHome from "./ro/home.json" with { type: "json" };
import roPlatform from "./ro/platform.json" with { type: "json" };
import roChecks from "./ro/checks.json" with { type: "json" };
import roTrust from "./ro/trust.json" with { type: "json" };
import roLogin from "./ro/login.json" with { type: "json" };
import itApp from "./it/app.json" with { type: "json" };
import itSite from "./it/site.json" with { type: "json" };
import itPages from "./it/pages.json" with { type: "json" };
import itHome from "./it/home.json" with { type: "json" };
import itPlatform from "./it/platform.json" with { type: "json" };
import itChecks from "./it/checks.json" with { type: "json" };
import itTrust from "./it/trust.json" with { type: "json" };
import itLogin from "./it/login.json" with { type: "json" };
import esApp from "./es/app.json" with { type: "json" };
import esSite from "./es/site.json" with { type: "json" };
import esPages from "./es/pages.json" with { type: "json" };
import esHome from "./es/home.json" with { type: "json" };
import esPlatform from "./es/platform.json" with { type: "json" };
import esChecks from "./es/checks.json" with { type: "json" };
import esTrust from "./es/trust.json" with { type: "json" };
import esLogin from "./es/login.json" with { type: "json" };
import frApp from "./fr/app.json" with { type: "json" };
import frSite from "./fr/site.json" with { type: "json" };
import frPages from "./fr/pages.json" with { type: "json" };
import frHome from "./fr/home.json" with { type: "json" };
import frPlatform from "./fr/platform.json" with { type: "json" };
import frChecks from "./fr/checks.json" with { type: "json" };
import frTrust from "./fr/trust.json" with { type: "json" };
import frLogin from "./fr/login.json" with { type: "json" };
import deApp from "./de/app.json" with { type: "json" };
import deSite from "./de/site.json" with { type: "json" };
import dePages from "./de/pages.json" with { type: "json" };
import deHome from "./de/home.json" with { type: "json" };
import dePlatform from "./de/platform.json" with { type: "json" };
import deChecks from "./de/checks.json" with { type: "json" };
import deTrust from "./de/trust.json" with { type: "json" };
import deLogin from "./de/login.json" with { type: "json" };
import nlApp from "./nl/app.json" with { type: "json" };
import nlSite from "./nl/site.json" with { type: "json" };
import nlPages from "./nl/pages.json" with { type: "json" };
import nlHome from "./nl/home.json" with { type: "json" };
import nlPlatform from "./nl/platform.json" with { type: "json" };
import nlChecks from "./nl/checks.json" with { type: "json" };
import nlTrust from "./nl/trust.json" with { type: "json" };
import nlLogin from "./nl/login.json" with { type: "json" };
import plApp from "./pl/app.json" with { type: "json" };
import plSite from "./pl/site.json" with { type: "json" };
import plPages from "./pl/pages.json" with { type: "json" };
import plHome from "./pl/home.json" with { type: "json" };
import plPlatform from "./pl/platform.json" with { type: "json" };
import plChecks from "./pl/checks.json" with { type: "json" };
import plTrust from "./pl/trust.json" with { type: "json" };
import plLogin from "./pl/login.json" with { type: "json" };

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

function merge<const T extends readonly object[]>(parts: T): UnionToIntersection<T[number]> {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in out) throw new Error(`message namespace "${key}" is defined in more than one catalog file`);
      out[key] = value;
    }
  }
  return out as UnionToIntersection<T[number]>;
}


const en = merge([enApp, enSite, enPages, enHome, enPlatform, enChecks, enTrust, enLogin] as const);
const ro = merge([roApp, roSite, roPages, roHome, roPlatform, roChecks, roTrust, roLogin] as const);
const it = merge([itApp, itSite, itPages, itHome, itPlatform, itChecks, itTrust, itLogin] as const);
const es = merge([esApp, esSite, esPages, esHome, esPlatform, esChecks, esTrust, esLogin] as const);
const fr = merge([frApp, frSite, frPages, frHome, frPlatform, frChecks, frTrust, frLogin] as const);
const de = merge([deApp, deSite, dePages, deHome, dePlatform, deChecks, deTrust, deLogin] as const);
const nl = merge([nlApp, nlSite, nlPages, nlHome, nlPlatform, nlChecks, nlTrust, nlLogin] as const);
const pl = merge([plApp, plSite, plPages, plHome, plPlatform, plChecks, plTrust, plLogin] as const);

/** English is the source catalog and the type of every other one. */
export type Messages = typeof en;
export { en, ro, it, es, fr, de, nl, pl };

export const catalogs: Record<"en" | "ro" | "it" | "es" | "fr" | "de" | "nl" | "pl", Messages> = { en, ro, it, es, fr, de, nl, pl };
