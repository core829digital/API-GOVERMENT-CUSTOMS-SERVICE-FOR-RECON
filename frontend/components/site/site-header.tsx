"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Brand } from "@/components/brand/logo";
import { MenuIcon } from "@/components/icons";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";

const links = [
  { href: "/platform", key: "platform" },
  { href: "/checks", key: "checks" },
  { href: "/trust", key: "trust" },
] as const;

export function SiteHeader() {
  const t = useTranslations();
  const pathname = usePathname();
  const session = useSession();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  const authenticated = session.data?.authenticated === true;
  const entry = authenticated
    ? { href: "/overview", label: t("site.nav.console") }
    : { href: "/login", label: t("common.signIn") };

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-40 border-b transition-[background-color,border-color] duration-300",
        scrolled ? "border-border bg-background/80 backdrop-blur-md" : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-[84rem] items-center gap-6 px-6 md:px-10">
        <Link href="/" className="logo-host -m-2 p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("shell.appName")}>
          <Brand>{t("shell.appName")}</Brand>
        </Link>

        <nav aria-label={t("site.nav.label")} className="ml-6 hidden items-center gap-8 md:flex">
          {links.map(({ href, key }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className="link-sweep font-mono text-[0.72rem] tracking-[0.16em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t(`site.nav.${key}`)}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
          <Button asChild size="sm" className="ml-2 hidden md:inline-flex">
            <Link href={entry.href}>{entry.label}</Link>
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label={t("site.nav.openMenu")}>
                <MenuIcon className="size-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetTitle className="px-6 pt-6 text-base">{t("site.nav.menuTitle")}</SheetTitle>
              <SheetDescription className="sr-only">{t("site.nav.menuDescription")}</SheetDescription>
              <nav aria-label={t("site.nav.label")} className="flex flex-col px-6">
                {links.map(({ href, key }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    aria-current={pathname === href ? "page" : undefined}
                    className="border-b py-4 font-mono text-sm tracking-[0.16em] uppercase"
                  >
                    {t(`site.nav.${key}`)}
                  </Link>
                ))}
              </nav>
              <div className="px-6">
                <Button asChild className="w-full">
                  <Link href={entry.href} onClick={() => setOpen(false)}>
                    {entry.label}
                  </Link>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
      <div aria-hidden="true" className="scroll-grow absolute inset-x-0 bottom-[-1px] h-px origin-left bg-foreground" />
    </header>
  );
}
