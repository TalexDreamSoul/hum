"use client";

import { useEffect, useState } from "react";
import * as qiniu from "qiniu-js";
import { Badge, Banner, Button, Grid, GridItem, Input, Meter, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { THEME_SCENE_ITEMS, type ThemeScene } from "@/lib/theme-song";

type RegionId = "z0" | "z1" | "z2" | "na0" | "as0";
interface SongRow { id: string; originalName: string; mimeType: string; sizeBytes: number; status: string; analysisScene: ThemeScene; createdAt: number; uploadedBy: string }
interface PendingUpload { id: string; name: string; progress: number; status: "waiting" | "uploading" | "done" | "error"; error?: string }
interface UploadGrant {
  token: string;
  key: string;
  region: RegionId;
  privateBucket: boolean;
  resumable: {
    enabled: boolean;
    chunkSizeMB: number;
    concurrentRequestLimit: number;
    retryCount: number;
    checkByMD5: boolean;
    forceDirect: boolean;
    localResumeTtlHours: number;
  };
  error?: string;
}
interface UploadResult { key: string; hash: string; fsize: number; mimeType: string }

const REGION_BY_ID = {
  z0: qiniu.region.z0,
  z1: qiniu.region.z1,
  z2: qiniu.region.z2,
  na0: qiniu.region.na0,
  as0: qiniu.region.as0,
} as const;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadWorkspace({ canUpload, qiniuReady }: { canUpload: boolean; qiniuReady: boolean }) {
  const toast = useConsoleToast();
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [scene, setScene] = useState<ThemeScene>("general");

  async function loadSongs() {
    const response = await fetch("/api/songs", { cache: "no-store" });
    const payload = await response.json() as { songs?: SongRow[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "读取歌曲失败");
    setSongs(payload.songs || []);
  }

  useEffect(() => { loadSongs().catch((error) => toast.error("读取歌曲失败", error.message)); }, []);

  function updatePending(id: string, patch: Partial<PendingUpload>) {
    setPending((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function uploadFile(file: File, id: string): Promise<void> {
    updatePending(id, { status: "uploading", progress: 0 });
    const tokenResponse = await fetch("/api/qiniu/upload-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type }),
    });
    const grant = await tokenResponse.json() as UploadGrant;
    if (!tokenResponse.ok) throw new Error(grant.error || "无法签发上传凭证");

    const result = await new Promise<UploadResult>((resolve, reject) => {
      qiniu.upload(file, grant.key, grant.token, { fname: file.name, mimeType: file.type }, {
        region: REGION_BY_ID[grant.region],
        useCdnDomain: true,
        concurrentRequestLimit: grant.resumable.concurrentRequestLimit,
        retryCount: grant.resumable.retryCount,
        chunkSize: grant.resumable.chunkSizeMB,
        checkByMD5: grant.resumable.checkByMD5,
        forceDirect: grant.resumable.forceDirect,
      }).subscribe({
        next(progress: { total: { percent: number } }) {
          updatePending(id, { progress: Math.round(progress.total.percent) });
        },
        error(error: unknown) {
          reject(error instanceof Error ? error : new Error("七牛上传失败"));
        },
        complete(value: unknown) {
          const uploaded = value as Partial<UploadResult>;
          if (!uploaded.key || !uploaded.hash || typeof uploaded.fsize !== "number") {
            reject(new Error("七牛返回的上传结果不完整"));
            return;
          }
          resolve({ key: uploaded.key, hash: uploaded.hash, fsize: uploaded.fsize, mimeType: uploaded.mimeType || file.type });
        },
      });
    });

    const registerResponse = await fetch("/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...result, scene }),
    });
    const registered = await registerResponse.json() as { error?: string };
    if (!registerResponse.ok) throw new Error(registered.error || "上传成功，但登记入库失败");
    updatePending(id, { status: "done", progress: 100 });
  }

  async function addFiles(fileList: FileList | File[]) {
    if (!canUpload || !qiniuReady || busy) return;
    const files = Array.from(fileList).filter((file) => file.size > 0);
    if (!files.length) return;
    const jobs = files.map((file) => ({ file, id: crypto.randomUUID() }));
    setPending(jobs.map(({ file, id }) => ({ id, name: file.name, progress: 0, status: "waiting" })));
    setBusy(true);
    let completed = 0;
    try {
      for (const job of jobs) {
        try {
          await uploadFile(job.file, job.id);
          completed += 1;
        } catch (error) {
          updatePending(job.id, { status: "error", error: error instanceof Error ? error.message : "上传失败" });
        }
      }
      try {
        await loadSongs();
      } catch (error) {
        toast.error("刷新已入库文件失败", error instanceof Error ? error.message : "请稍后重试");
      }
      if (completed === jobs.length) toast.success(`${completed} 个文件已直传七牛并登记入库`);
      else toast.error(`${completed}/${jobs.length} 个文件入库成功`, "失败项可重新选择上传");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid gap="base">
      {!qiniuReady && <Banner variant="alert" title="七牛尚未配置完成" description="管理员需要先在配置页填写 Access Key、Secret Key、Bucket、区域和访问域名。" />}
      {!canUpload && <Banner variant="default" title="当前角色只有查看权限" />}
      {qiniuReady && canUpload && (
        <ConsoleSection title="直传文件">
          <Grid gap="sm">
            <Text variant="secondary">支持音频、视频、LRC/TXT 和 ZIP；单文件最大 500MB。大文件由 qiniu-js 自动分片和断点续传。</Text>
            <Select
              label="评分场景"
              value={scene}
              items={[...THEME_SCENE_ITEMS]}
              onValueChange={(value: ThemeScene | null) => value && setScene(value)}
              renderValue={(value: ThemeScene) => THEME_SCENE_ITEMS.find((item) => item.value === value)?.label ?? value}
            />
            <Grid variant="2up" gap="sm">
              <GridItem>
                <Input label="选择文件（可多选）" type="file" multiple accept="audio/*,video/*,.lrc,.txt,.zip"
                  disabled={busy} onChange={(event: React.ChangeEvent<HTMLInputElement>) => event.target.files && addFiles(event.target.files)} />
              </GridItem>
              <GridItem>
                <Input label="选择文件夹" type="file" multiple disabled={busy}
                  ref={(input) => { if (input) input.setAttribute("webkitdirectory", ""); }}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => event.target.files && addFiles(event.target.files)} />
              </GridItem>
            </Grid>
          </Grid>
        </ConsoleSection>
      )}

      {pending.length > 0 && (
        <ConsoleSection title="上传进度" status={busy && <Badge variant="info">上传中</Badge>}>
          <Grid gap="sm">
            {pending.map((item) => (
              <Grid key={item.id} gap="sm">
                <Meter
                  label={item.name}
                  value={item.progress}
                  customValue={item.status === "error" ? "失败" : `${item.progress}%`}
                />
                {item.error && <Text variant="error">{item.error}</Text>}
              </Grid>
            ))}
            {!busy && <Button variant="ghost" onClick={() => setPending([])}>清除上传记录</Button>}
          </Grid>
        </ConsoleSection>
      )}

      <ConsoleSection title="已入库文件">
        <Table>
          <thead><tr><th>文件</th><th>大小</th><th>状态</th><th>上传人</th><th>时间</th><th>试听</th></tr></thead>
          <tbody>
            {songs.map((song) => (
              <tr key={song.id}>
                <td><Text bold>{song.originalName}</Text><Text variant="secondary">{song.mimeType || "未知类型"}</Text></td>
                <td>{formatBytes(song.sizeBytes)}</td>
                <td><Badge variant="neutral">{song.status}</Badge></td>
                <td>{song.uploadedBy}</td>
                <td>{new Date(song.createdAt).toLocaleString("zh-CN")}</td>
                <td>{song.mimeType.startsWith("audio/") ? <audio controls preload="none" src={`/api/songs/${song.id}/play`} /> : "—"}</td>
              </tr>
            ))}
            {!songs.length && <tr><td colSpan={6}><Text variant="secondary">还没有入库文件</Text></td></tr>}
          </tbody>
        </Table>
      </ConsoleSection>
    </Grid>
  );
}
