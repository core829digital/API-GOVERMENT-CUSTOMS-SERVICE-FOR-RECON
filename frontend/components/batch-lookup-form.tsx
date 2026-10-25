"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { batchIdSchema } from "@/lib/api/schemas";

export function BatchLookupForm() {
  const t = useTranslations("overview.batchCard");
  const router = useRouter();
  const [invalid, setInvalid] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("batchId") ?? "").trim();
    const parsed = batchIdSchema.safeParse(value);
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    router.push(`/batches/${encodeURIComponent(parsed.data)}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="batch-id">{t("label")}</Label>
        <Input
          id="batch-id"
          name="batchId"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("placeholder")}
          aria-invalid={invalid}
          aria-describedby={invalid ? "batch-id-error" : undefined}
          className="font-mono"
        />
        {invalid ? (
          <p id="batch-id-error" role="alert" className="text-sm text-destructive">
            {t("invalid")}
          </p>
        ) : null}
      </div>
      <Button type="submit">{t("submit")}</Button>
    </form>
  );
}
