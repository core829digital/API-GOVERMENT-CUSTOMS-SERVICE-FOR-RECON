"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle() {
  const t = useTranslations("shell.theme");
  const { theme, setTheme } = useTheme();
  return (
    // Non-modal: a modal Radix menu marks the whole page aria-hidden while its trigger stays focusable,
    // which axe reports as aria-hidden-focus (serious). Outside click and Escape still dismiss it.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("label")}>
          <SunIcon className="size-4 dark:hidden" aria-hidden="true" />
          <MoonIcon className="hidden size-4 dark:block" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">{t("light")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t("dark")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t("system")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
