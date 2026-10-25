import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LoginCard } from "@/components/auth/login-card";
import { LoginPanel } from "@/components/auth/login-panel";
import { ArrowRightIcon } from "@/components/icons";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { AuthConfigError, loadAuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { parseLoginError } from "@/lib/auth/login-url";
import { safeReturnTo } from "@/lib/auth/return-to";
import { openSession } from "@/lib/auth/session";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("login");
  return { title: t("metaTitle"), robots: { index: false } };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `null` when sign-in is not configured on the server; otherwise whether the visitor holds a valid session. */
async function readSession(): Promise<boolean | null> {
  let sessionKey: Uint8Array;
  try {
    sessionKey = loadAuthConfig().sessionKey;
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return (await openSession(token, sessionKey)) !== null;
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(first(params.returnTo));
  const requested = parseLoginError(first(params.error));

  const session = await readSession();
  // A visitor who is already signed in goes straight on. When the page was reached with an explicit error
  // (for example an API call rejected the session) it is shown instead, so the two cannot bounce forever.
  if (session === true && requested === null) redirect(returnTo);

  const configured = session !== null;
  const notice = configured ? requested : "not_configured";

  const t = await getTranslations("login");
  return (
    <div className="grid lg:grid-cols-2">
      <div className="flex flex-col lg:min-h-dvh">
        <div className="flex items-center justify-between gap-4 px-6 py-4 md:px-10">
          <Link
            href="/"
            className="link-sweep eyebrow inline-flex items-center gap-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowRightIcon className="size-3.5 rotate-180" aria-hidden="true" />
            {t("backToSite")}
          </Link>
          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-10 md:px-10 lg:py-16">
          <LoginCard notice={notice} configured={configured} returnTo={returnTo} />
        </div>
      </div>
      <div className="lg:order-first">
        <LoginPanel />
      </div>
    </div>
  );
}
