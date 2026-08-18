import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { importSkill, listSkills } from "@/lib/server/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  markdown: z.string().min(1).max(25_000),
  binding: z.object({
    purpose: z.enum(["generation", "evaluation", "both"]),
    domain: z.string().max(160).default(""),
    ageBand: z.string().max(80).default(""),
    scene: z.string().max(80).default(""),
    priority: z.number().int().min(-100).max(100).default(0),
  }).strict(),
}).strict();

export async function GET() {
  try {
    await requireApiUser(["admin"]);
    return NextResponse.json({ skills: await listSkills() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = inputSchema.parse(await request.json());
    return NextResponse.json(await importSkill(input.markdown, input.binding, user.id), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
