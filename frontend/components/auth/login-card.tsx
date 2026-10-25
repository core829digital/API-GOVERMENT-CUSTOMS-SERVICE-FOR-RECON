import { getTranslations } from "next-intl/server";
import { LoginNotice } from "@/components/auth/login-notice";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { loginStartPath, type LoginNoticeKey } from "@/lib/auth/login-url";

/**
 * The sign-in card. The action is a plain link to the server endpoint that starts the OIDC flow, so signing
 * in needs no client-side JavaScript.
 */
export async function LoginCard({
  notice,
  configured,
  returnTo,
}: {
  notice: LoginNoticeKey | null;
  /** Whether the server has an identity provider to send the visitor to. */
  configured: boolean;
  /** Already passed through `safeReturnTo`. */
  returnTo: string;
}) {
  const t = await getTranslations("login");
  const common = await getTranslations("common");
  const startHref = loginStartPath(returnTo);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1 className="text-3xl font-medium tracking-tight">{t("title")}</h1>
      </CardHeader>
      <CardContent className="space-y-6">
        {notice ? <LoginNotice notice={notice} retryHref={startHref} /> : null}
        {configured ? (
          <div className="space-y-4">
            <Button asChild size="lg" className="w-full">
              <a href={startHref}>
                {common("signIn")}
                <ArrowRightIcon aria-hidden="true" />
              </a>
            </Button>
            <p className="text-sm text-muted-foreground">{t("redirectNote")}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
