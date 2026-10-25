import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { BatchStatus } from "@/components/batch-status";
import { ArrowRightIcon } from "@/components/icons";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("batch");
  return { title: t("title") };
}

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("batch");
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Link
        href="/overview"
        className="link-sweep eyebrow inline-flex items-center gap-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowRightIcon className="size-3.5 rotate-180" aria-hidden="true" />
        {t("back")}
      </Link>
      <h1 className="text-3xl font-medium tracking-tight md:text-4xl">{t("title")}</h1>
      <BatchStatus id={id} />
    </div>
  );
}
