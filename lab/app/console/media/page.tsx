import { ConsolePage } from "@/components/console/console-ui";
import { MediaWorkspace } from "@/components/console/media-workspace";
import { requirePageUser } from "@/lib/server/auth";
import { isQiniuReady } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function MediaPage() {
  const user = await requirePageUser();
  return (
    <ConsolePage
      title="统一媒体资产"
      description="音频、视频、录屏、文档和图片统一登记；七牛直传完成后建立可追溯媒体资产、元数据、转写与人工复审记录。"
    >
      <MediaWorkspace
        canUpload={user.role === "admin" || user.role === "uploader"}
        canReview={user.role === "admin" || user.role === "approver"}
        qiniuReady={await isQiniuReady()}
      />
    </ConsolePage>
  );
}
