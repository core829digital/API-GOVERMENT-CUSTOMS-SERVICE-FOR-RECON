import type { NextRequest } from "next/server";
import { handleCallback } from "@/lib/auth/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleCallback(request);
}
