import type { NextRequest } from "next/server";
import { handleSession } from "@/lib/auth/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleSession(request);
}
