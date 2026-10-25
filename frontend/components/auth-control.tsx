"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/use-session";

export function AuthControl() {
  const t = useTranslations();
  const pathname = usePathname();
  const session = useSession();

  if (session.isPending) {
    return (
      <span role="status">
        <Skeleton className="h-8 w-20" aria-hidden="true" />
        <span className="sr-only">{t("shell.session.checking")}</span>
      </span>
    );
  }

  if (session.data?.authenticated) {
    return (
      <form method="post" action="/api/auth/logout">
        <Button type="submit" variant="outline" size="sm">
          {t("common.signOut")}
        </Button>
      </form>
    );
  }

  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/login?returnTo=${encodeURIComponent(pathname)}`}>{t("common.signIn")}</Link>
    </Button>
  );
}
