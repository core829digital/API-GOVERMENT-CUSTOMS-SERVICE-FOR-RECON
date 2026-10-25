import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthControl } from "@/components/auth-control";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations("shell");
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <AppSidebar />
      <SidebarInset id="main-content" tabIndex={-1} className="min-w-0 outline-none">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background px-4 md:px-6">
          <SidebarTrigger />
          <p className="eyebrow hidden sm:block">{t("console")}</p>
          <div className="ml-auto flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
            <AuthControl />
          </div>
        </header>
        <div className="flex-1 px-4 py-8 md:px-8 md:py-12">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
