"use client";

import { useQuery } from "@tanstack/react-query";
import "@/lib/zod-config";
import { z } from "zod";

const sessionSchema = z.object({ authenticated: z.boolean() });

async function fetchSession(signal: AbortSignal) {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("session_unavailable");
  return sessionSchema.parse(await response.json());
}

/** Whether the visitor has a session. Only the boolean is ever exposed to the browser (R-FE-4). */
export function useSession() {
  return useQuery({ queryKey: ["session"], queryFn: ({ signal }) => fetchSession(signal) });
}
