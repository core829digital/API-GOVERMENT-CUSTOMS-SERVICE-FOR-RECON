import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Closing } from "@/components/site/home/closing";
import { FindingAnatomy } from "@/components/site/home/finding-anatomy";
import { Gap } from "@/components/site/home/gap";
import { Hero } from "@/components/site/home/hero";
import { Pipeline } from "@/components/site/home/pipeline";
import { Principles } from "@/components/site/home/principles";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export default function HomePage() {
  return (
    <>
      <Hero />
      <Gap />
      <Pipeline />
      <FindingAnatomy />
      <Principles />
      <Closing />
    </>
  );
}
