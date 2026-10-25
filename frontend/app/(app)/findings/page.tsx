import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { FindingsTable } from "@/components/findings-table";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("findings");
  return { title: t("title") };
}

export default async function FindingsPage() {
  const t = await getTranslations("findings");
  const shell = await getTranslations("shell");
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="eyebrow">{shell("console")}</p>
        <h1 className="text-3xl font-medium tracking-tight md:text-4xl">{t("title")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <FindingsTable />
    </div>
  );
}
