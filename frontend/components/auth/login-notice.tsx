import { getTranslations } from "next-intl/server";
import { AlertIcon, CheckIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LoginNoticeKey } from "@/lib/auth/login-url";

/** How each notice is presented. `retry` offers the sign-in link again inside the notice. */
const PRESENTATION: Record<
  LoginNoticeKey,
  { role: "alert" | "status"; tone: "destructive" | "default"; retry: boolean }
> = {
  idp_unreachable: { role: "alert", tone: "destructive", retry: true },
  invalid_callback: { role: "alert", tone: "destructive", retry: true },
  not_configured: { role: "alert", tone: "destructive", retry: false },
  session_expired: { role: "alert", tone: "default", retry: false },
  signed_out: { role: "status", tone: "default", retry: false },
  unknown: { role: "alert", tone: "destructive", retry: true },
};

/**
 * Calm explanation of why the visitor is on the sign-in page. Only known codes select a message; the raw
 * query value never reaches the output.
 */
export async function LoginNotice({ notice, retryHref }: { notice: LoginNoticeKey; retryHref: string }) {
  const t = await getTranslations("login");
  const { role, tone, retry } = PRESENTATION[notice];
  return (
    <Alert role={role} variant={tone}>
      {role === "status" ? <CheckIcon aria-hidden="true" /> : <AlertIcon aria-hidden="true" />}
      <AlertTitle>{t(`notice.${notice}.title`)}</AlertTitle>
      <AlertDescription>
        <p>{t(`notice.${notice}.description`)}</p>
        {retry ? (
          <Button asChild size="sm" variant="outline" className="mt-3">
            <a href={retryHref}>{t("retry")}</a>
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
