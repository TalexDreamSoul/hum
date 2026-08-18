import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api";
import { resolveAiContextLink } from "@/lib/server/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const resolved = await resolveAiContextLink(token);
    if (resolved.format === "json") {
      return NextResponse.json(resolved.value, { headers: { "cache-control": "private, no-store" } });
    }
    return new NextResponse(resolved.value, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
