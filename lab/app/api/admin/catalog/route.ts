import { NextResponse } from "next/server";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { catalogMutationSchema, catalogQuerySchema, executeCatalogMutation, listCatalog } from "@/lib/server/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser();
    const url = new URL(request.url);
    const query = catalogQuerySchema.parse({
      resource: url.searchParams.get("resource"),
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      kind: url.searchParams.get("kind") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
    });
    return NextResponse.json(await listCatalog(query));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser();
    const input = catalogMutationSchema.parse(await request.json());
    return NextResponse.json(await executeCatalogMutation(input, user));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
