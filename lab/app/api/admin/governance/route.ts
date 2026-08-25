import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { actOnGovernance, governancePostSchema, governanceQuerySchema, listGovernance } from "@/lib/server/governance";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireApiUser();
    const params = request.nextUrl.searchParams;
    const result = await listGovernance(governanceQuerySchema.parse({
      resource: params.get("resource") ?? undefined,
      page: params.get("page") ?? undefined,
      pageSize: params.get("pageSize") ?? undefined,
      search: params.get("search") ?? undefined,
      status: params.get("status") ?? undefined,
      reviewer: params.get("reviewer") ?? undefined,
      action: params.get("action") ?? undefined,
      target: params.get("target") ?? undefined,
      date: params.get("date") ?? undefined,
      dateFrom: params.get("dateFrom") ?? undefined,
      dateTo: params.get("dateTo") ?? undefined,
    }));
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiUser();
    const result = await actOnGovernance(governancePostSchema.parse(await request.json()), user);
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
