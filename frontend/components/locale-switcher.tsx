"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { GlobeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { locales } from "@/i18n/config";

export function LocaleSwitcher() {
  const t = useTranslations("shell.language");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  return (
    // Non-modal: a modal Radix menu marks the whole page aria-hidden while its trigger stays focusable,
    // which axe reports as aria-hidden-focus (serious). Outside click and Escape still dismiss it.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("label")} disabled={pending}>
          <GlobeIcon className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(next) => startTransition(() => setLocale(next))}
        >
          {locales.map((code) => (
            <DropdownMenuRadioItem key={code} value={code} lang={code}>
              {t(code)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
