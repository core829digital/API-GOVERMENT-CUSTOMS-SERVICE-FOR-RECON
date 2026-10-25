"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand/logo";
import { FindingsIcon, OverviewIcon } from "@/components/icons";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const items = [
  { href: "/overview", key: "overview", icon: OverviewIcon },
  { href: "/findings", key: "findings", icon: FindingsIcon },
] as const;

export function AppSidebar() {
  const t = useTranslations("shell");
  const pathname = usePathname();
  return (
    <Sidebar>
      <SidebarHeader role="banner">
        <Link href="/" className="logo-host px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <Brand size={24}>{t("appName")}</Brand>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label={t("navLabel")}>
              <SidebarMenu>
                {items.map(({ href, key, icon: Icon }) => {
                  const active = pathname.startsWith(href);
                  return (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link href={href} aria-current={active ? "page" : undefined}>
                          <Icon aria-hidden="true" />
                          <span>{t(`nav.${key}`)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
