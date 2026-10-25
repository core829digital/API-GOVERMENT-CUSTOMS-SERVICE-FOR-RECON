"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "./config";

export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) {
    throw new Error("unsupported_locale");
  }
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
