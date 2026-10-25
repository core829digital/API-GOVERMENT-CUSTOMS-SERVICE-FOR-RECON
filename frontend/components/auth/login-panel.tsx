import { getTranslations } from "next-intl/server";
import { LogoMark } from "@/components/brand/logo";
import { Reveal } from "@/components/site/reveal";

const GUARANTEES = ["advice", "citation", "credentials"] as const;

/** Brand side of the sign-in screen: what the product is, and three plain statements about how it behaves. */
export async function LoginPanel() {
  const t = await getTranslations("login.panel");
  const shell = await getTranslations("shell");
  return (
    <div className="relative isolate flex flex-col justify-between gap-14 overflow-hidden border-t bg-secondary/40 px-6 py-12 md:px-10 lg:min-h-dvh lg:border-t-0 lg:border-r lg:p-16">
      <div
        aria-hidden="true"
        className="pat-grid pointer-events-none absolute inset-0 -z-10 text-foreground [mask-image:linear-gradient(to_bottom_right,black,transparent_80%)]"
      />

      <div className="space-y-10">
        <div className="flex items-center gap-5">
          <LogoMark active size={112} className="size-16 lg:size-28" />
          <div className="space-y-2">
            <p className="text-[0.8rem] leading-none font-semibold tracking-[0.34em] uppercase">{shell("appName")}</p>
            <p className="eyebrow">{t("eyebrow")}</p>
          </div>
        </div>
        <div className="space-y-5">
          <p className="headline max-w-xl">{t("statement")}</p>
          <p className="eyebrow">{t("status")}</p>
        </div>
      </div>

      <div>
        <h2 className="eyebrow">{t("guaranteesTitle")}</h2>
        <ul className="mt-5 border-b">
          {GUARANTEES.map((key, index) => (
            <Reveal as="li" key={key} delay={index * 70} className="grid gap-1 border-t py-5">
              <p className="font-medium">{t(`guarantees.${key}.title`)}</p>
              <p className="max-w-xl text-sm text-muted-foreground">{t(`guarantees.${key}.description`)}</p>
            </Reveal>
          ))}
        </ul>
      </div>
    </div>
  );
}
