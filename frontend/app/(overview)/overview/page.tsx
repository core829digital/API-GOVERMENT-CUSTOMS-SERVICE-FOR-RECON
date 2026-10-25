import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { BatchLookupForm } from "@/components/batch-lookup-form";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("overview");
  return { title: t("title") };
}

export default async function OverviewPage() {
  const t = await getTranslations("overview");
  const shell = await getTranslations("shell");
  return (
    <div className="mx-auto max-w-5xl space-y-12">
      <div className="space-y-5">
        <p className="eyebrow">{shell("console")}</p>
        <h1 className="headline">{t("title")}</h1>
        <p className="lead max-w-2xl">{t("intro")}</p>
        <p className="border-l-2 border-l-signal pl-4 text-sm text-muted-foreground">{t("notice")}</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="plate">
          <CardHeader>
            <p className="eyebrow num" aria-hidden="true">{"01"}</p>
            <h2 className="text-lg leading-tight font-medium tracking-tight">{t("findingsCard.title")}</h2>
            <CardDescription>{t("findingsCard.description")}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button asChild>
              <Link href="/findings">
                {t("findingsCard.action")}
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </CardContent>
        </Card>
        <Card className="plate">
          <CardHeader>
            <p className="eyebrow num" aria-hidden="true">{"02"}</p>
            <h2 className="text-lg leading-tight font-medium tracking-tight">{t("batchCard.title")}</h2>
            <CardDescription>{t("batchCard.description")}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <BatchLookupForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
