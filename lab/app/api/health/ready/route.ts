import { NextResponse } from "next/server";
import { getDb, waitForDatabase } from "@/lib/server/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

export async function GET() {
  try {
    await waitForDatabase();
    await getDb().prepare("SELECT 1").get();
    return NextResponse.json({ status: "ready", database: "ready" }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { status: "unavailable", database: "unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
