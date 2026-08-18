import { ConsolePage } from "@/components/console/console-ui";
import { UploadWorkspace } from "@/components/console/upload-workspace";
import { requirePageUser } from "@/lib/server/auth";
import { isQiniuReady } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function SongsPage() {
  const user = await requirePageUser();
  return (
    <ConsolePage
      title="歌曲入库"
      description="浏览器使用服务端签发的一次性 uptoken 直传七牛，支持分片、断点续传和进度显示；应用服务器不接收文件正文。"
    >
      <UploadWorkspace canUpload={user.role === "admin" || user.role === "uploader"} qiniuReady={await isQiniuReady()} />
    </ConsolePage>
  );
}
