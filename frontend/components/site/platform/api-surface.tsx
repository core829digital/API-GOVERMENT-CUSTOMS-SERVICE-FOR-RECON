import { getTranslations } from "next-intl/server";
import { Reveal } from "@/components/site/reveal";
import { StatusTag, type Status } from "@/components/site/section";

type Side = "write" | "read" | "push";

// Source: Architecture.md §17; status per Progress.md (the first five routes are mounted in recon-api).
// Paths and methods are code and are rendered as-is, never translated.
const ENDPOINTS: readonly {
  id: "batchesCreate" | "batchesGet" | "runsCreate" | "runsGet" | "findingsList" | "evidence" | "rulesSearch" | "erasure" | "export" | "webhooks";
  method?: string;
  path?: string;
  side: Side;
  status: Status;
}[] = [
  { id: "batchesCreate", method: "POST", path: "/v1/batches", side: "write", status: "building" },
  { id: "batchesGet", method: "GET", path: "/v1/batches/{id}", side: "read", status: "building" },
  { id: "runsCreate", method: "POST", path: "/v1/recon/runs", side: "write", status: "building" },
  { id: "runsGet", method: "GET", path: "/v1/recon/runs/{id}", side: "read", status: "building" },
  { id: "findingsList", method: "GET", path: "/v1/findings", side: "read", status: "building" },
  { id: "evidence", method: "GET", path: "/v1/findings/{id}/evidence", side: "read", status: "planned" },
  { id: "rulesSearch", method: "GET", path: "/v1/rules/search", side: "read", status: "planned" },
  { id: "erasure", method: "POST", path: "/v1/privacy/erasure-requests", side: "write", status: "planned" },
  { id: "export", method: "GET", path: "/v1/privacy/export", side: "read", status: "planned" },
  { id: "webhooks", side: "push", status: "planned" },
];

/** Endpoint list: path in mono, what it does, which database it touches, and its status. */
export async function ApiSurface() {
  const t = await getTranslations("platform");
  return (
    <div className="space-y-12">
      <ul className="border-b border-border">
        {ENDPOINTS.map((ep, i) => (
          <li key={ep.id} className="relative py-6">
            <Reveal kind="line" className="absolute inset-x-0 top-0 h-px bg-border" />
            <Reveal delay={Math.min(i, 4) * 40} className="grid gap-x-8 gap-y-3 lg:grid-cols-12">
              <div className="min-w-0 lg:col-span-5">
                <p className="num text-sm leading-relaxed break-words">
                  {ep.method ? (
                    <>
                      <span className="text-muted-foreground">{ep.method}</span>{" "}
                      <span className="font-medium">{ep.path}</span>
                    </>
                  ) : (
                    <span className="font-sans text-base font-medium">{t("api.webhooksName")}</span>
                  )}
                </p>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground lg:col-span-4">{t(`api.items.${ep.id}`)}</p>
              <div className="flex flex-wrap items-center gap-3 lg:col-span-3 lg:justify-end">
                <span className="eyebrow">{t(`api.side.${ep.side}`)}</span>
                <StatusTag status={ep.status}>{t(`status.${ep.status}`)}</StatusTag>
              </div>
            </Reveal>
          </li>
        ))}
      </ul>
      <Reveal>
        <p className="max-w-[48rem] leading-relaxed">
          {t.rich("api.headers", {
            code: (chunks) => <code className="num border border-border px-1.5 py-0.5 text-[0.85em] break-all">{chunks}</code>,
          })}
        </p>
      </Reveal>
    </div>
  );
}
