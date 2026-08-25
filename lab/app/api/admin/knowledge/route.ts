import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { KNOWLEDGE_RESOURCES, executeKnowledgeAction, knowledgeActionRoles, knowledgeQuerySchema, listKnowledge } from "@/lib/server/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  resource: z.enum([...KNOWLEDGE_RESOURCES, "mock-plan"] as const),
  action: z.string().trim().min(1).max(40),
  payload: z.unknown(),
}).strict();

export async function GET(request: Request) {
  try {
    await requireApiUser();
    const url = new URL(request.url);
    const input = knowledgeQuerySchema.parse({
      resource: url.searchParams.get("resource") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      domain: url.searchParams.get("domain") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      age: url.searchParams.get("age") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
    });
    return NextResponse.json(await listKnowledge(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const user = await requireApiUser(knowledgeActionRoles(input.resource, input.action));
    return NextResponse.json(await executeKnowledgeAction(input.resource, input.action, input.payload, user.id, user.role));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
