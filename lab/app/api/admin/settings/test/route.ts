import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, requireApiUser } from "@/lib/server/api";
import { recordAudit } from "@/lib/server/auth";
import { runTrackedJob } from "@/lib/server/jobs";
import { PROVIDER_TEST_TARGETS, testProvider, type ProviderTestTarget } from "@/lib/server/provider-tests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testInput = z.object({ target: z.enum(PROVIDER_TEST_TARGETS) });

const TARGET_LABELS: Record<ProviderTestTarget, string> = {
  site: "站点地址",
  qiniu: "七牛存储",
  feishu: "飞书登录",
  minimax: "MiniMax",
  ai: "AI 端点",
};

/** 用已保存的配置做一次连通性测试；密钥不出服务端，只回结论。 */
export async function POST(request: Request) {
  try {
    const user = await requireApiUser(["admin"]);
    const { target } = testInput.parse(await request.json());
    const result = await runTrackedJob(
      { kind: "provider_test", title: `连通性测试：${TARGET_LABELS[target]}`, userId: user.id, input: { target } },
      async (job) => {
        const outcome = await testProvider(target, request.signal);
        job.step(outcome.title, outcome.detail);
        job.setOutput(outcome);
        return outcome;
      },
    );
    await recordAudit(user.id, "settings.test", "settings", target, { ok: result.ok });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
