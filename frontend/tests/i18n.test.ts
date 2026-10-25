import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/config";
import { catalogs, en } from "@/messages";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const args = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (message: string) => [...message.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();

const source = flatten(en);
const others = locales.filter((locale) => locale !== "en");

describe.each(others)("i18n catalog: %s", (locale) => {
  const target = flatten(catalogs[locale]);

  it("has every English key and no extra key", () => {
    expect([...source.keys()].filter((key) => !target.has(key))).toEqual([]);
    expect([...target.keys()].filter((key) => !source.has(key))).toEqual([]);
  });

  it("has no empty message", () => {
    expect([...target].filter(([, value]) => value.trim() === "").map(([key]) => key)).toEqual([]);
  });

  it("uses the same interpolation arguments and rich-text tags as English in every message", () => {
    const mismatched = [...source]
      .filter(([key, value]) => {
        const translated = target.get(key);
        return translated !== undefined && (args(value).join() !== args(translated).join() || tags(value).join() !== tags(translated).join());
      })
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it("is actually translated: few messages are still identical to English", () => {
    // Protected tokens (brand, acronyms, endpoints) legitimately repeat; a left-over English copy repeats everything.
    const identical = [...source].filter(([key, value]) => target.get(key) === value && /[a-z]{4,}/.test(value));
    expect(identical.length / source.size).toBeLessThan(0.05);
  });

  it("names every supported language by its own name", () => {
    for (const code of locales) expect(catalogs[locale].shell.language[code]).toBe(en.shell.language[code]);
  });
});
