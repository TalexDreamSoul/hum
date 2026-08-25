"use client";

import { useEffect, useState } from "react";
import * as qiniu from "qiniu-js";
import { Badge, Banner, Button, Grid, GridItem, Input, InputArea, Meter, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { THEME_SCENE_ITEMS, type ThemeScene } from "@/lib/theme-song";

type MediaKind = "audio" | "video" | "screen_recording" | "document" | "image";
type MediaStatus = "authorized" | "uploaded" | "analyzing" | "ready" | "rejected" | "retired";
type UploadKind = "auto" | MediaKind;
type ReviewKind = "technical" | "content" | "music";
type ReviewVerdict = "pass" | "revise" | "reject";

type Asset = {
  id: string;
  storageProvider: "qiniu" | "local" | "mock";
  objectKey: string;
  originalName: string;
  mediaKind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  qiniuHash: string;
  status: MediaStatus;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  transcript: string;
  transcriptModel: string;
  thumbnailObjectKey: string;
  metadata: Record<string, unknown>;
  sourceSongId: string | null;
  sourceCandidateId: string | null;
  uploadedBy: string | null;
  createdAt: number;
};

type AssetDetail = Asset & {
  links: Array<{ id: string; subjectType: string; subjectId: string; purpose: string; position: number; createdBy: string | null; createdAt: number }>;
  reviews: Array<{ id: string; roundNo: number; reviewKind: string; verdict: string; score: number | null; dimensions: Record<string, unknown>; notes: string; reviewerName: string | null; createdAt: number }>;
};

type UploadGrant = {
  token: string;
  key: string;
  region: keyof typeof REGION_BY_ID;
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
};

type UploadResult = { key: string; hash: string; fsize: number; mimeType: string };

const REGION_BY_ID = {
  z0: qiniu.region.z0,
  z1: qiniu.region.z1,
  z2: qiniu.region.z2,
  na0: qiniu.region.na0,
  as0: qiniu.region.as0,
} as const;

const KIND_ITEMS = [
  { value: "auto", label: "自动识别" },
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "screen_recording", label: "录屏" },
  { value: "document", label: "文档" },
  { value: "image", label: "图片" },
] as const;

const FILTER_KIND_ITEMS = [{ value: "all", label: "全部类型" }, ...KIND_ITEMS.slice(1)] as const;
const STATUS_ITEMS = [
  { value: "all", label: "全部状态" },
  { value: "authorized", label: "已授权" },
  { value: "uploaded", label: "已上传" },
  { value: "analyzing", label: "分析中" },
  { value: "ready", label: "可用" },
  { value: "rejected", label: "已拒绝" },
  { value: "retired", label: "已退役" },
] as const;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value: number | null): string {
  if (!value || value <= 0) return "—";
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MediaWorkspace({
  canUpload,
  canReview,
  qiniuReady,
}: {
  canUpload: boolean;
  canReview: boolean;
  qiniuReady: boolean;
}) {
  const toast = useConsoleToast();
  const [items, setItems] = useState<Asset[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<"all" | MediaKind>("all");
  const [status, setStatus] = useState<"all" | MediaStatus>("all");
  const [search, setSearch] = useState("");
  const [uploadKind, setUploadKind] = useState<UploadKind>("auto");
  const [scene, setScene] = useState<ThemeScene>("general");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [reviewKind, setReviewKind] = useState<ReviewKind>("technical");
  const [reviewVerdict, setReviewVerdict] = useState<ReviewVerdict>("pass");
  const [reviewScore, setReviewScore] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewing, setReviewing] = useState(false);

  async function loadAssets(nextPage = page) {
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
    if (kind !== "all") params.set("mediaKind", kind);
    if (status !== "all") params.set("status", status);
    if (search.trim()) params.set("search", search.trim());
    const response = await fetch(`/api/admin/media?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json() as { items?: Asset[]; page?: number; pageSize?: number; total?: number; error?: string };
    if (!response.ok) throw new Error(payload.error || "读取媒体资产失败");
    setItems(payload.items ?? []);
    setPage(payload.page ?? nextPage);
    setPageSize(payload.pageSize ?? pageSize);
    setTotal(payload.total ?? 0);
  }

  useEffect(() => {
    loadAssets().catch((error) => toast.error("读取媒体资产失败", error instanceof Error ? error.message : "未知错误"));
  }, [page, pageSize, kind, status, search]);

  async function openDetail(id: string) {
    try {
      const response = await fetch(`/api/admin/media/${id}`, { cache: "no-store" });
      const payload = await response.json() as { asset?: AssetDetail; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error || "读取资产详情失败");
      setDetail(payload.asset);
    } catch (error) {
      toast.error("读取资产详情失败", error instanceof Error ? error.message : "未知错误");
    }
  }

  async function uploadSelectedFile() {
    if (!pendingFile || uploading || !canUpload || !qiniuReady) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const tokenResponse = await fetch("/api/qiniu/upload-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: pendingFile.name, size: pendingFile.size, mimeType: pendingFile.type }),
      });
      const grant = await tokenResponse.json() as UploadGrant;
      if (!tokenResponse.ok) throw new Error(grant.error || "无法签发上传凭证");
      const result = await new Promise<UploadResult>((resolve, reject) => {
        qiniu.upload(pendingFile, grant.key, grant.token, { fname: pendingFile.name, mimeType: pendingFile.type }, {
          region: REGION_BY_ID[grant.region],
          useCdnDomain: true,
          concurrentRequestLimit: grant.resumable.concurrentRequestLimit,
          retryCount: grant.resumable.retryCount,
          chunkSize: grant.resumable.chunkSizeMB,
          checkByMD5: grant.resumable.checkByMD5,
          forceDirect: grant.resumable.forceDirect,
        }).subscribe({
          next(progress: { total: { percent: number } }) {
            setUploadProgress(Math.round(progress.total.percent));
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
            resolve({ key: uploaded.key, hash: uploaded.hash, fsize: uploaded.fsize, mimeType: uploaded.mimeType || pendingFile.type });
          },
        });
      });
      const registration = await fetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...result,
          scene,
          ...(uploadKind === "auto" ? {} : { mediaKind: uploadKind }),
        }),
      });
      const registered = await registration.json() as { assetId?: string; deduplicated?: boolean; error?: string };
      if (!registration.ok || !registered.assetId) throw new Error(registered.error || "上传成功，但媒体登记失败");
      toast.success(registered.deduplicated ? "已返回既有媒体资产" : "已登记媒体资产，后台将补全元数据");
      setPendingFile(null);
      setUploadProgress(null);
      await loadAssets(1);
      if (registered.assetId) await openDetail(registered.assetId);
    } catch (error) {
      toast.error("媒体上传失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setUploading(false);
    }
  }

  async function createMockAsset() {
    if (!canUpload || uploading) return;
    const mockKind: MediaKind = uploadKind === "auto" ? "video" : uploadKind;
    const extension = mockKind === "audio" ? "mp3" : mockKind === "image" ? "png" : mockKind === "document" ? "pdf" : "mp4";
    const mimeType = mockKind === "audio" ? "audio/mpeg" : mockKind === "image" ? "image/png" : mockKind === "document" ? "application/pdf" : "video/mp4";
    setUploading(true);
    try {
      const response = await fetch("/api/admin/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "mock", name: `hum-${mockKind}-sample.${extension}`, mimeType, sizeBytes: 1_024_000, mediaKind: mockKind }),
      });
      const payload = await response.json() as { asset?: AssetDetail; deduplicated?: boolean; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error || "创建 Mock 资产失败");
      toast.success(payload.deduplicated ? "已返回既有 Mock 资产" : "已创建确定性 Mock 资产");
      await loadAssets(1);
      setDetail(payload.asset);
    } catch (error) {
      toast.error("创建 Mock 资产失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setUploading(false);
    }
  }

  async function submitReview() {
    if (!detail || reviewing) return;
    const score = reviewScore.trim() ? Number(reviewScore) : null;
    if (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) {
      toast.error("评分必须是 0–100 的整数");
      return;
    }
    setReviewing(true);
    try {
      const response = await fetch(`/api/admin/media/${detail.id}/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewKind, verdict: reviewVerdict, score, notes: reviewNotes }),
      });
      const payload = await response.json() as { asset?: AssetDetail; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error || "提交人工评审失败");
      setDetail(payload.asset);
      setReviewNotes("");
      setReviewScore("");
      toast.success("已保存人工评审");
      await loadAssets();
    } catch (error) {
      toast.error("提交人工评审失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setReviewing(false);
    }
  }

  return (
    <Grid gap="base">
      {!qiniuReady && <Banner variant="alert" title="七牛尚未配置完成" description="可先创建确定性 Mock 资产；真实直传需由管理员配置七牛。" />}
      {!canUpload && <Banner variant="default" title="当前角色只有查看和评审权限" />}

      <ConsoleSection title="统一媒体上传" status={<Badge variant="info">qiniu-js 分片 / 断点续传</Badge>}>
        <Grid gap="sm">
          <Text variant="secondary">文件正文始终由浏览器直传。登记会同时创建一等 media asset；相同 content hash 或七牛 hash 直接返回既有资产。</Text>
          <Grid variant="2up" gap="sm">
            <GridItem>
              <Select
                label="媒体类型"
                value={uploadKind}
                items={[...KIND_ITEMS]}
                onValueChange={(value: UploadKind | null) => value && setUploadKind(value)}
                renderValue={(value: UploadKind) => KIND_ITEMS.find((item) => item.value === value)?.label ?? value}
              />
            </GridItem>
            <GridItem>
              <Select
                label="音频评分场景"
                value={scene}
                items={[...THEME_SCENE_ITEMS]}
                onValueChange={(value: ThemeScene | null) => value && setScene(value)}
                renderValue={(value: ThemeScene) => THEME_SCENE_ITEMS.find((item) => item.value === value)?.label ?? value}
              />
            </GridItem>
          </Grid>
          <Input
            label="选择音频、视频、录屏、文档或图片"
            type="file"
            accept="audio/*,video/*,image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.lrc,.txt,.md,.csv,.zip"
            disabled={!canUpload || uploading || !qiniuReady}
            onChange={(event) => setPendingFile(event.target.files?.[0] ?? null)}
          />
          {pendingFile && <Text variant="secondary">{pendingFile.name} · {formatBytes(pendingFile.size)}</Text>}
          {uploadProgress !== null && <Meter label="直传进度" value={uploadProgress} customValue={`${uploadProgress}%`} />}
          <Grid variant="2up" gap="sm">
            <GridItem><Button disabled={!pendingFile || uploading || !canUpload || !qiniuReady} onClick={uploadSelectedFile}>{uploading ? "处理中…" : "直传并登记"}</Button></GridItem>
            <GridItem><Button variant="secondary" disabled={uploading || !canUpload} onClick={createMockAsset}>创建确定性 Mock 样例</Button></GridItem>
          </Grid>
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="媒体资产库" status={<Badge variant="neutral">{total} 项</Badge>}>
        <Grid gap="sm">
          <Grid variant="2up" gap="sm">
            <GridItem>
              <Select
                label="类型筛选"
                value={kind}
                items={[...FILTER_KIND_ITEMS]}
                onValueChange={(value) => { if (value && value !== "auto") { setKind(value); setPage(1); } }}
                renderValue={(value) => FILTER_KIND_ITEMS.find((item) => item.value === value)?.label ?? value}
              />
            </GridItem>
            <GridItem>
              <Select
                label="状态筛选"
                value={status}
                items={[...STATUS_ITEMS]}
                onValueChange={(value: "all" | MediaStatus | null) => { if (value) { setStatus(value); setPage(1); } }}
                renderValue={(value: "all" | MediaStatus) => STATUS_ITEMS.find((item) => item.value === value)?.label ?? value}
              />
            </GridItem>
          </Grid>
          <Input label="搜索文件名、对象键或转写" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <Table>
            <thead><tr><th>资产</th><th>类型 / 元数据</th><th>转写 / 评分</th><th>状态</th><th>上传时间</th><th>操作</th></tr></thead>
            <tbody>
              {items.map((asset) => (
                <tr key={asset.id}>
                  <td><Text bold>{asset.originalName}</Text><Text variant="secondary">{formatBytes(asset.sizeBytes)} · {asset.storageProvider}</Text></td>
                  <td><Text>{asset.mediaKind}</Text><Text variant="secondary">{formatDuration(asset.durationMs)} · {asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.sampleRate ? `${asset.sampleRate} Hz / ${asset.channels ?? "—"} ch` : "待探测"}</Text></td>
                  <td><Text variant="secondary">{asset.transcript ? asset.transcript.slice(0, 72) : "待生成"}</Text></td>
                  <td><Badge variant={asset.status === "ready" ? "success" : "warning"}>{asset.status}</Badge></td>
                  <td>{new Date(asset.createdAt).toLocaleString("zh-CN")}</td>
                  <td><Button size="sm" variant="secondary" onClick={() => openDetail(asset.id)}>详情</Button></td>
                </tr>
              ))}
              {!items.length && <tr><td colSpan={6}><Text variant="secondary">没有符合筛选条件的媒体资产。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
        </Grid>
      </ConsoleSection>

      <ConsoleDrawer
        open={Boolean(detail)}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        title={detail?.originalName ?? "媒体详情"}
        description={detail ? `${detail.mediaKind} · ${detail.storageProvider} · ${detail.status}` : undefined}
      >
        {detail && (
          <Grid gap="base">
            <ConsoleSection title="元数据">
              <Table>
                <tbody>
                  <tr><th>对象键</th><td>{detail.objectKey}</td></tr>
                  <tr><th>哈希</th><td>{detail.contentHash || detail.qiniuHash || "—"}</td></tr>
                  <tr><th>时长 / 音频</th><td>{formatDuration(detail.durationMs)} · {detail.sampleRate ? `${detail.sampleRate} Hz / ${detail.channels ?? "—"} 声道` : "—"}</td></tr>
                  <tr><th>画面 / 帧率</th><td>{detail.width && detail.height ? `${detail.width}×${detail.height} · ${detail.frameRate ?? "—"} fps` : "—"}</td></tr>
                  <tr><th>Mock 封面键</th><td>{detail.thumbnailObjectKey || "—"}</td></tr>
                  <tr><th>来源</th><td>{detail.sourceSongId ?? detail.sourceCandidateId ?? "直接媒体资产"}</td></tr>
                </tbody>
              </Table>
              <a href={`/api/admin/media/${detail.id}/preview`} target="_blank" rel="noreferrer">安全预览</a>
            </ConsoleSection>
            <ConsoleSection title="确定性 Mock 转写" status={<Badge variant="neutral">{detail.transcriptModel || "未生成"}</Badge>}>
              <Text>{detail.transcript || "尚无转写"}</Text>
              <Text variant="secondary">{JSON.stringify(detail.metadata)}</Text>
            </ConsoleSection>
            <ConsoleSection title="评分与复审">
              <Table>
                <thead><tr><th>轮次</th><th>类型</th><th>结论</th><th>分数</th><th>评审人</th><th>说明</th></tr></thead>
                <tbody>
                  {detail.reviews.map((review) => <tr key={review.id}><td>{review.roundNo}</td><td>{review.reviewKind}</td><td>{review.verdict}</td><td>{review.score ?? "—"}</td><td>{review.reviewerName ?? "自动预筛"}</td><td>{review.notes}</td></tr>)}
                  {!detail.reviews.length && <tr><td colSpan={6}><Text variant="secondary">尚无评审。</Text></td></tr>}
                </tbody>
              </Table>
              {canReview && (
                <Grid gap="sm">
                  <Grid variant="2up" gap="sm">
                    <GridItem><Select label="评审类型" value={reviewKind} items={[{ value: "technical", label: "技术" }, { value: "content", label: "内容" }, { value: "music", label: "音乐" }]} onValueChange={(value) => { if (value === "technical" || value === "content" || value === "music") setReviewKind(value); }} /></GridItem>
                    <GridItem><Select label="结论" value={reviewVerdict} items={[{ value: "pass", label: "通过" }, { value: "revise", label: "需修改" }, { value: "reject", label: "拒绝" }]} onValueChange={(value) => { if (value === "pass" || value === "revise" || value === "reject") setReviewVerdict(value); }} /></GridItem>
                  </Grid>
                  <Input label="评分（0–100，可选）" value={reviewScore} onChange={(event) => setReviewScore(event.target.value)} />
                  <InputArea label="评审说明" value={reviewNotes} onValueChange={setReviewNotes} minRows={2} />
                  <Button disabled={reviewing} onClick={submitReview}>{reviewing ? "保存中…" : "提交人工评审"}</Button>
                </Grid>
              )}
            </ConsoleSection>
            <ConsoleSection title="关联对象">
              <Table>
                <thead><tr><th>类型</th><th>标识</th><th>用途</th><th>位置</th></tr></thead>
                <tbody>
                  {detail.links.map((link) => <tr key={link.id}><td>{link.subjectType}</td><td>{link.subjectId}</td><td>{link.purpose}</td><td>{link.position}</td></tr>)}
                  {!detail.links.length && <tr><td colSpan={4}><Text variant="secondary">尚未关联知识、出版或候选对象。</Text></td></tr>}
                </tbody>
              </Table>
            </ConsoleSection>
          </Grid>
        )}
      </ConsoleDrawer>
    </Grid>
  );
}
