import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import {
  createNotificationChannel,
  listNotificationChannels,
  NOTIFICATION_EVENTS,
  NOTIFICATION_TEMPLATE_KEYS,
} from "@/lib/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channelType: z.enum(["feishu_app", "feishu_webhook"]),
  chatId: z.string().max(200).optional(),
  webhookUrl: z.string().max(1000).optional(),
  signingSecret: z.string().max(500).optional(),
  templateKey: z.enum(NOTIFICATION_TEMPLATE_KEYS).default("production_progress"),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1),
}).strict();

export async function GET() {
  try {
    await requireApiUser(["admin"]);
    return NextResponse.json({ channels: await listNotificationChannels(), events: NOTIFICATION_EVENTS, templates: NOTIFICATION_TEMPLATE_KEYS });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const input = inputSchema.parse(await request.json());
    const id = await createNotificationChannel(input, user.id);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
