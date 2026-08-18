import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { createTestSet, listTestSets } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
}).strict();

export async function GET() {
  try {
    const user = await requireApiUser();
    return NextResponse.json({ testSets: await listTestSets(user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser();
    const input = inputSchema.parse(await request.json());
    const id = await createTestSet(input.name, input.description, user.id);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
