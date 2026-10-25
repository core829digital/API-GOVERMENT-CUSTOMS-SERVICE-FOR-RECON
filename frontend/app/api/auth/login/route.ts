import type { NextRequest } from "next/server";
import { handleLogin } from "@/lib/auth/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleLogin(request);
}
