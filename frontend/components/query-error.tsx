"use client";

import { AlertIcon } from "@/components/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, type ApiErrorKind } from "@/lib/api/errors";
import { loginPath } from "@/lib/auth/login-url";

const messageKey = {
  unauthenticated: "unauthenticated",
  not_found: "notFound",
  replica_lag: "replicaLag",
  unavailable: "unavailable",
  invalid_response: "invalidResponse",
  network: "network",
} as const satisfies Record<ApiErrorKind, string>;

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations();
  const pathname = usePathname();
  const kind: ApiErrorKind = error instanceof ApiError ? error.kind : "unavailable";
  const key = messageKey[kind];

  return (
    <Alert variant="destructive">
      <AlertIcon aria-hidden="true" />
      <AlertTitle>{t(`errors.${key}.title`)}</AlertTitle>
      <AlertDescription>
        <p>{t(`errors.${key}.description`)}</p>
        <div className="mt-3">
          {kind === "unauthenticated" ? (
            <Button asChild size="sm">
              <Link href={loginPath({ returnTo: pathname })}>{t("common.signIn")}</Link>
            </Button>
          ) : kind !== "not_found" && onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
