import "server-only";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { SceneKey } from "../analysis/score";
import { ApiError } from "./api";
import { recordAudit } from "./auth";
import { getDataDir } from "./data-dir";
import { getDb, type HumDatabase } from "./database";
import { createQiniuObjectUrl, isQiniuObjectKeyInNamespace } from "./qiniu";
import { getProviderSettings } from "./settings";

const execFileAsync = promisify(execFile);
const MAX_ANALYSIS_BYTES = 500 * 1024 * 1024;
const MOCK_TRANSCRIPT_MODEL = "hum-transcript-mock-1";
const VIDEO_PREFILTER_SEED = "hum-video-5d";
const VIDEO_THUMBNAIL_SEED = "hum-video-thumb-1";

export const MEDIA_KINDS = ["audio", "video", "screen_recording", "document", "image"] as const;
export const MEDIA_STATUSES = ["authorized", "uploaded", "analyzing", "ready", "failed", "rejected", "retired"] as const;
export const MEDIA_LINK_SUBJECT_TYPES = ["knowledge", "publication", "song_spec", "candidate", "release"] as const;
export const MEDIA_REVIEW_KINDS = ["technical", "content", "music"] as const;
export const MEDIA_REVIEW_VERDICTS = ["pass", "revise", "reject"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
export type MediaLinkSubjectType = (typeof MEDIA_LINK_SUBJECT_TYPES)[number];
export type MediaReviewKind = (typeof MEDIA_REVIEW_KINDS)[number];
export type MediaReviewVerdict = (typeof MEDIA_REVIEW_VERDICTS)[number];
export type StorageProvider = "qiniu" | "local" | "mock";

interface MediaAssetRow {
  id: string;
  storageProvider: StorageProvider;
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
  metadataJson: string;
  sourceSongId: string | null;
  sourceCandidateId: string | null;
  uploadedById: string | null;
  uploadedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MediaAssetSummary {
  id: string;
  storageProvider: StorageProvider;
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
  uploadedById: string | null;
  uploadedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MediaLink {
  id: string;
  subjectType: MediaLinkSubjectType;
  subjectId: string;
  purpose: string;
  position: number;
  createdById: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface MediaReview {
  id: string;
  rubricRevisionId: string | null;
  roundNo: number;
  reviewKind: MediaReviewKind;
  verdict: MediaReviewVerdict;
  score: number | null;
  dimensions: Record<string, unknown>;
  notes: string;
  reviewerId: string | null;
  reviewerName: string | null;
  createdAt: number;
}

export interface MediaAssetDetail extends MediaAssetSummary {
  links: MediaLink[];
  reviews: MediaReview[];
}

export interface MediaAssetFilters {
  page?: number;
  pageSize?: number;
  mediaKind?: MediaKind;
  status?: MediaStatus;
  search?: string;
}

export interface MediaAssetPage {
  items: MediaAssetSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface UploadedSongMediaInput {
  key: string;
  hash: string;
  fsize: number;
  mimeType: string;
  scene: SceneKey;
  mediaKind?: MediaKind;
  contentHash?: string;
}

export interface SongMediaRegistration {
  songId: string;
  assetId: string;
  mediaKind: MediaKind;
  status: MediaStatus;
  deduplicated: boolean;
}

export interface MockMediaInput {
  name: string;
  mimeType: string;
  sizeBytes: number;
  mediaKind?: MediaKind;
  contentHash?: string;
}

export interface MockMediaRegistration {
  assetId: string;
  deduplicated: boolean;
}

export interface MediaTechnicalMetadata {
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  ffprobeAvailable: boolean;
  ffmpegAvailable: boolean;
  analyzedSizeBytes: number;
  error: string | null;
}

export interface MediaPreviewRedirect {
  type: "redirect";
  url: string;
}

export interface MediaPreviewMetadata {
  type: "metadata";
  asset: MediaAssetSummary;
  preview: Record<string, unknown>;
}

export type MediaPreview = MediaPreviewRedirect | MediaPreviewMetadata;

const MEDIA_ASSET_SELECT = `
  SELECT a.id,
         a.storage_provider AS storageProvider,
         a.object_key AS objectKey,
         a.original_name AS originalName,
         a.media_kind AS mediaKind,
         a.mime_type AS mimeType,
         a.size_bytes AS sizeBytes,
         a.content_hash AS contentHash,
         a.qiniu_hash AS qiniuHash,
         a.status,
         a.duration_ms AS durationMs,
         a.sample_rate AS sampleRate,
         a.channels,
         a.width,
         a.height,
         a.frame_rate AS frameRate,
         a.transcript,
         a.transcript_model AS transcriptModel,
         a.thumbnail_object_key AS thumbnailObjectKey,
         a.metadata_json AS metadataJson,
         a.source_song_id AS sourceSongId,
         a.source_candidate_id AS sourceCandidateId,
         a.uploaded_by AS uploadedById,
         u.display_name AS uploadedBy,
         a.created_at AS createdAt,
         a.updated_at AS updatedAt
  FROM media_assets a
  LEFT JOIN users u ON u.id = a.uploaded_by
`;

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".lrc", ".txt", ".md", ".csv", ".zip"]);

let ffmpegAvailability: Promise<boolean> | undefined;

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Corrupt historical metadata is treated as empty rather than breaking the asset library.
  }
  return {};
}

function mapAsset(row: MediaAssetRow): MediaAssetSummary {
  return {
    id: row.id,
    storageProvider: row.storageProvider,
    objectKey: row.objectKey,
    originalName: row.originalName,
    mediaKind: row.mediaKind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    qiniuHash: row.qiniuHash,
    status: row.status,
    durationMs: row.durationMs,
    sampleRate: row.sampleRate,
    channels: row.channels,
    width: row.width,
    height: row.height,
    frameRate: row.frameRate,
    transcript: row.transcript,
    transcriptModel: row.transcriptModel,
    thumbnailObjectKey: row.thumbnailObjectKey,
    metadata: parseObject(row.metadataJson),
    sourceSongId: row.sourceSongId,
    sourceCandidateId: row.sourceCandidateId,
    uploadedById: row.uploadedById,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isStreamingKind(kind: MediaKind): boolean {
  return kind === "audio" || kind === "video" || kind === "screen_recording";
}

function positiveMetadataNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function technicalMetadataFailure(mediaKind: MediaKind, probe: MediaTechnicalMetadata): string | null {
  if (!probe.ffprobeAvailable) return "ffprobe 无法读取媒体技术元数据";
  if (!positiveMetadataNumber(probe.durationMs)) return "缺少有效媒体时长";
  if (mediaKind === "audio" && (!positiveMetadataNumber(probe.sampleRate) || !positiveMetadataNumber(probe.channels))) {
    return "缺少有效音频采样率或声道数";
  }
  if (isVideoKind(mediaKind) && (!positiveMetadataNumber(probe.width) || !positiveMetadataNumber(probe.height) || !positiveMetadataNumber(probe.frameRate))) {
    return "缺少有效视频分辨率或帧率";
  }
  return null;
}

function clientHashHints(input: { contentHash?: string; qiniuHash?: string }): Record<string, string | null> {
  return {
    contentHash: input.contentHash?.trim().toLowerCase().slice(0, 128) || null,
    qiniuHash: input.qiniuHash?.trim().slice(0, 200) || null,
  };
}

function isTrustedContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isVideoKind(kind: MediaKind): boolean {
  return kind === "video" || kind === "screen_recording";
}

function assertMediaKind(value: string): asserts value is MediaKind {
  if (!(MEDIA_KINDS as readonly string[]).includes(value)) throw new ApiError(400, "不支持的媒体类型");
}

export function inferMediaKind(mimeType: string, filename: string, requested?: MediaKind): MediaKind {
  const normalizedMime = mimeType.trim().toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  let inferred: MediaKind;
  if (normalizedMime.startsWith("audio/")) inferred = "audio";
  else if (normalizedMime.startsWith("video/")) inferred = "video";
  else if (normalizedMime.startsWith("image/")) inferred = "image";
  else if (normalizedMime.startsWith("text/") || normalizedMime === "application/pdf"
    || /application\/(vnd\.|msword|zip|x-zip-compressed)/.test(normalizedMime)) inferred = "document";
  else if (VIDEO_EXTENSIONS.has(extension)) inferred = "video";
  else if (AUDIO_EXTENSIONS.has(extension)) inferred = "audio";
  else if (IMAGE_EXTENSIONS.has(extension)) inferred = "image";
  else if (DOCUMENT_EXTENSIONS.has(extension)) inferred = "document";
  else throw new ApiError(400, "无法识别媒体类型，请使用音频、视频、录屏、文档或图片格式");

  if (!requested) return inferred;
  assertMediaKind(requested);
  if (requested === "screen_recording" && inferred === "video") return requested;
  if (requested !== inferred) throw new ApiError(400, "所选媒体类型与文件类型不匹配");
  return requested;
}

function deterministicNumber(seed: string, lower: number, upper: number): number {
  const digest = createHash("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0) / 0xFFFFFFFF;
  return Math.round(lower + (upper - lower) * value);
}

function normalizedFilename(name: string): string {
  return path.basename(name, path.extname(name)).normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120) || "未命名媒体";
}

function deterministicTranscript(input: {
  originalName: string;
  mediaKind: MediaKind;
  mimeType: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
}): string {
  const duration = input.durationMs && input.durationMs > 0 ? `${Math.round(input.durationMs / 1000)} 秒` : "时长待探测";
  const metadataKeys = Object.keys(input.metadata).sort().slice(0, 4).join("、") || "基础登记";
  return `Mock 转写：${normalizedFilename(input.originalName)}；类型为 ${input.mediaKind}（${input.mimeType || "未知 MIME"}），${duration}；依据文件名、类型和元数据字段 ${metadataKeys} 生成。`;
}

function buildThumbnailMetadata(input: {
  objectKey: string;
  originalName: string;
  contentHash: string;
  qiniuHash: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}): { objectKey: string; metadata: Record<string, unknown> } {
  const basis = `${VIDEO_THUMBNAIL_SEED}|${input.contentHash || input.qiniuHash || input.objectKey}|${input.originalName}|${input.durationMs ?? 0}|${input.width ?? 0}x${input.height ?? 0}`;
  const digest = createHash("sha256").update(basis).digest("hex");
  return {
    objectKey: `mock-thumbnails/${digest.slice(0, 32)}.json`,
    metadata: {
      mode: "deterministic_mock",
      seed: VIDEO_THUMBNAIL_SEED,
      digest,
      generatedFrom: ["object_key", "original_name", "duration_ms", "dimensions"],
      alt: `${normalizedFilename(input.originalName)} 视频封面`,
    },
  };
}

function videoPrefilter(input: Pick<MediaAssetSummary, "id" | "objectKey" | "originalName" | "contentHash" | "qiniuHash" | "durationMs" | "width" | "height" | "frameRate">): {
  score: number;
  verdict: MediaReviewVerdict;
  dimensions: Record<string, unknown>;
  notes: string;
} {
  const basis = `${VIDEO_PREFILTER_SEED}|${input.contentHash || input.qiniuHash || input.objectKey}|${input.originalName}|${input.durationMs ?? 0}|${input.width ?? 0}x${input.height ?? 0}|${input.frameRate ?? 0}`;
  const score = deterministicNumber(basis, 58, 92);
  const durationScore = input.durationMs && input.durationMs >= 3_000 ? 1 : 0;
  const resolutionScore = input.width && input.height && input.width >= 640 && input.height >= 360 ? 1 : 0;
  const verdict: MediaReviewVerdict = score >= 74 && durationScore && resolutionScore ? "pass" : score >= 62 ? "revise" : "reject";
  const dimensions = {
    seed: VIDEO_PREFILTER_SEED,
    automated: true,
    composition: deterministicNumber(`${basis}|composition`, 55, 95),
    clarity: deterministicNumber(`${basis}|clarity`, 55, 95),
    duration: input.durationMs,
    resolution: input.width && input.height ? `${input.width}×${input.height}` : "待探测",
    frameRate: input.frameRate,
    technicalMetadataReady: Boolean(input.durationMs || input.width || input.height),
  };
  return {
    score,
    verdict,
    dimensions,
    notes: `自动预筛（${VIDEO_PREFILTER_SEED}）：${verdict === "pass" ? "通过预筛" : verdict === "revise" ? "建议人工复核" : "建议退回"}，分数 ${score}。仅用于预筛，绝不自动批准母带或发布。`,
  };
}

async function findAssetRow(id: string, database = getDb()): Promise<MediaAssetRow> {
  const asset = await database.prepare(`${MEDIA_ASSET_SELECT} WHERE a.id = ?`).get<MediaAssetRow>(id);
  if (!asset) throw new ApiError(404, "媒体资产不存在");
  return asset;
}

async function replaceVideoPrefilter(database: HumDatabase, asset: MediaAssetSummary): Promise<void> {
  if (!isVideoKind(asset.mediaKind)) return;
  const prefilter = videoPrefilter(asset);
  await database.prepare(`
    DELETE FROM media_reviews
    WHERE asset_id = ? AND reviewer_id IS NULL AND review_kind = 'technical' AND notes LIKE ?
  `).run(asset.id, `自动预筛（${VIDEO_PREFILTER_SEED}%`);
  await database.prepare(`
    INSERT INTO media_reviews (
      id, asset_id, rubric_revision_id, round_no, review_kind, verdict, score,
      dimensions_json, notes, reviewer_id, created_at
    ) VALUES (?, ?, NULL, 1, 'technical', ?, ?, ?, ?, NULL, ?)
  `).run(randomUUID(), asset.id, prefilter.verdict, prefilter.score, JSON.stringify(prefilter.dimensions), prefilter.notes, Date.now());
}

function baseRegistrationMetadata(input: {
  provider: StorageProvider;
  scene?: SceneKey;
  requestedMediaKind?: MediaKind;
}): Record<string, unknown> {
  return {
    registration: {
      source: input.provider === "qiniu" ? "qiniu-direct" : "deterministic-mock",
      scene: input.scene ?? null,
      requestedMediaKind: input.requestedMediaKind ?? null,
    },
  };
}

async function insertMediaAsset(database: HumDatabase, input: {
  id: string;
  storageProvider: StorageProvider;
  objectKey: string;
  originalName: string;
  mediaKind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  qiniuHash: string;
  status: MediaStatus;
  durationMs?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  width?: number | null;
  height?: number | null;
  frameRate?: number | null;
  transcript: string;
  transcriptModel: string;
  thumbnailObjectKey?: string;
  metadata: Record<string, unknown>;
  sourceSongId?: string | null;
  sourceCandidateId?: string | null;
  uploadedById: string | null;
}): Promise<void> {
  const now = Date.now();
  await database.prepare(`
    INSERT INTO media_assets (
      id, storage_provider, object_key, original_name, media_kind, mime_type, size_bytes,
      content_hash, qiniu_hash, status, duration_ms, sample_rate, channels, width, height,
      frame_rate, transcript, transcript_model, thumbnail_object_key, metadata_json,
      source_song_id, source_candidate_id, uploaded_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.storageProvider,
    input.objectKey,
    input.originalName,
    input.mediaKind,
    input.mimeType,
    input.sizeBytes,
    input.contentHash,
    input.qiniuHash,
    input.status,
    input.durationMs ?? null,
    input.sampleRate ?? null,
    input.channels ?? null,
    input.width ?? null,
    input.height ?? null,
    input.frameRate ?? null,
    input.transcript,
    input.transcriptModel,
    input.thumbnailObjectKey ?? "",
    JSON.stringify(input.metadata),
    input.sourceSongId ?? null,
    input.sourceCandidateId ?? null,
    input.uploadedById,
    now,
    now,
  );
}

async function insertSong(database: HumDatabase, input: {
  id: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  qiniuHash: string;
  scene: SceneKey;
  uploadedBy: string;
}): Promise<void> {
  const now = Date.now();
  await database.prepare(`
    INSERT INTO songs (id, object_key, original_name, mime_type, size_bytes, qiniu_hash, status, analysis_scene, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?)
  `).run(input.id, input.objectKey, input.originalName, input.mimeType, input.sizeBytes, input.qiniuHash, input.scene, input.uploadedBy, now, now);
}

export async function registerUploadedSongMedia(input: UploadedSongMediaInput, userId: string): Promise<SongMediaRegistration> {
  const database = getDb();
  return database.transaction(async (transaction) => {
    const grant = await transaction.prepare(`
      SELECT user_id, original_name, mime_type, size_bytes, expires_at
      FROM upload_grants WHERE object_key = ?
    `).get<{ user_id: string; original_name: string; mime_type: string; size_bytes: number; expires_at: number }>(input.key);
    if (!grant || grant.expires_at <= Date.now()) throw new ApiError(410, "上传授权已失效，请重新上传");
    if (grant.user_id !== userId || grant.size_bytes !== input.fsize) throw new ApiError(403, "上传结果与授权不匹配");

    const mimeType = input.mimeType.trim() || grant.mime_type;
    const mediaKind = inferMediaKind(mimeType, grant.original_name, input.mediaKind);
    const songId = randomUUID();
    const assetId = randomUUID();
    const metadata = baseRegistrationMetadata({ provider: "qiniu", scene: input.scene, requestedMediaKind: input.mediaKind });
    metadata.integrity = {
      verification: "unverified",
      reason: "direct_upload_not_server_verified",
      clientHashes: clientHashHints({ contentHash: input.contentHash, qiniuHash: input.hash }),
    };
    const status: MediaStatus = "uploaded";
    const thumbnail = isVideoKind(mediaKind)
      ? buildThumbnailMetadata({ objectKey: input.key, originalName: grant.original_name, contentHash: "", qiniuHash: "", durationMs: null, width: null, height: null })
      : undefined;
    if (thumbnail) metadata.thumbnail = thumbnail.metadata;
    const transcript = deterministicTranscript({
      originalName: grant.original_name,
      mediaKind,
      mimeType,
      durationMs: null,
      metadata,
    });

    await insertSong(transaction, {
      id: songId,
      objectKey: input.key,
      originalName: grant.original_name,
      mimeType,
      sizeBytes: input.fsize,
      qiniuHash: "",
      scene: input.scene,
      uploadedBy: userId,
    });
    await insertMediaAsset(transaction, {
      id: assetId,
      storageProvider: "qiniu",
      objectKey: input.key,
      originalName: grant.original_name,
      mediaKind,
      mimeType,
      sizeBytes: input.fsize,
      contentHash: "",
      qiniuHash: "",
      status,
      transcript,
      transcriptModel: MOCK_TRANSCRIPT_MODEL,
      thumbnailObjectKey: thumbnail?.objectKey,
      metadata,
      sourceSongId: songId,
      uploadedById: userId,
    });
    await replaceVideoPrefilter(transaction, mapAsset(await findAssetRow(assetId, transaction)));
    await transaction.prepare("DELETE FROM upload_grants WHERE object_key = ?").run(input.key);
    await recordAudit(userId, "media.register", "media_asset", assetId, {
      songId,
      mediaKind,
      deduplicated: false,
      sizeBytes: input.fsize,
    }, transaction);
    return { songId, assetId, mediaKind, status, deduplicated: false };
  })();
}

export async function registerMockMediaAsset(input: MockMediaInput, userId: string): Promise<MockMediaRegistration> {
  const mediaKind = inferMediaKind(input.mimeType, input.name, input.mediaKind);
  const basis = `${input.name.normalize("NFKC")}|${input.mimeType.trim().toLowerCase()}|${mediaKind}|${input.sizeBytes}`;
  const generatedHash = createHash("sha256").update(basis).digest("hex");
  const id = randomUUID();
  const objectKey = `mock/${id}`;
  const database = getDb();
  return database.transaction(async (transaction) => {
    const metadata = baseRegistrationMetadata({ provider: "mock", requestedMediaKind: input.mediaKind });
    metadata.mockEnabled = true;
    metadata.mockBasis = generatedHash;
    metadata.integrity = {
      verification: "unverified",
      reason: "mock_input_not_media_bytes",
      clientHashes: clientHashHints({ contentHash: input.contentHash }),
    };
    const durationMs = isStreamingKind(mediaKind) ? deterministicNumber(`${generatedHash}|duration`, 20_000, 90_000) : null;
    const width = isVideoKind(mediaKind) || mediaKind === "image" ? 1280 : null;
    const height = isVideoKind(mediaKind) || mediaKind === "image" ? 720 : null;
    const frameRate = isVideoKind(mediaKind) ? 30 : null;
    const sampleRate = mediaKind === "audio" ? 44_100 : null;
    const channels = mediaKind === "audio" ? 2 : null;
    const thumbnail = isVideoKind(mediaKind)
      ? buildThumbnailMetadata({ objectKey, originalName: input.name, contentHash: "", qiniuHash: "", durationMs, width, height })
      : undefined;
    if (thumbnail) metadata.thumbnail = thumbnail.metadata;
    const transcript = deterministicTranscript({ originalName: input.name, mediaKind, mimeType: input.mimeType, durationMs, metadata });
    await insertMediaAsset(transaction, {
      id,
      storageProvider: "mock",
      objectKey,
      originalName: input.name.slice(0, 240),
      mediaKind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      contentHash: "",
      qiniuHash: "",
      status: "ready",
      durationMs,
      sampleRate,
      channels,
      width,
      height,
      frameRate,
      transcript,
      transcriptModel: MOCK_TRANSCRIPT_MODEL,
      thumbnailObjectKey: thumbnail?.objectKey,
      metadata,
      uploadedById: userId,
    });
    await replaceVideoPrefilter(transaction, mapAsset(await findAssetRow(id, transaction)));
    await recordAudit(userId, "media.mock_register", "media_asset", id, {
      mediaKind,
      deduplicated: false,
      mockEnabled: true,
    }, transaction);
    return { assetId: id, deduplicated: false };
  })();
}

export async function listMediaAssets(filters: MediaAssetFilters = {}): Promise<MediaAssetPage> {
  const database = getDb();
  const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 1), 100);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.mediaKind) {
    clauses.push("a.media_kind = ?");
    params.push(filters.mediaKind);
  }
  if (filters.status) {
    clauses.push("a.status = ?");
    params.push(filters.status);
  }
  const search = filters.search?.trim();
  if (search) {
    clauses.push("(a.original_name ILIKE ? OR a.object_key ILIKE ? OR a.transcript ILIKE ?)");
    const term = `%${search.slice(0, 120)}%`;
    params.push(term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = Number(await database.prepare(`SELECT COUNT(*) FROM media_assets a ${where}`).pluck().get(...params) ?? 0);
  const page = Math.min(Math.max(filters.page ?? 1, 1), Math.max(1, Math.ceil(total / pageSize)));
  const rows = await database.prepare(`${MEDIA_ASSET_SELECT} ${where}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all<MediaAssetRow>(...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map(mapAsset), page, pageSize, total };
}

export async function getMediaAsset(id: string): Promise<MediaAssetDetail> {
  const database = getDb();
  const asset = mapAsset(await findAssetRow(id, database));
  const links = await database.prepare(`
    SELECT l.id,
           l.subject_type AS subjectType,
           l.subject_id AS subjectId,
           l.purpose,
           l.position,
           l.created_by AS createdById,
           u.display_name AS createdBy,
           l.created_at AS createdAt
    FROM media_links l
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.asset_id = ?
    ORDER BY l.position ASC, l.created_at ASC
  `).all<MediaLink>(id);
  const reviewRows = await database.prepare(`
    SELECT r.id,
           r.rubric_revision_id AS rubricRevisionId,
           r.round_no AS roundNo,
           r.review_kind AS reviewKind,
           r.verdict,
           r.score,
           r.dimensions_json AS dimensionsJson,
           r.notes,
           r.reviewer_id AS reviewerId,
           u.display_name AS reviewerName,
           r.created_at AS createdAt
    FROM media_reviews r
    LEFT JOIN users u ON u.id = r.reviewer_id
    WHERE r.asset_id = ?
    ORDER BY r.round_no DESC, r.created_at DESC
  `).all<Array<{
    id: string;
    rubricRevisionId: string | null;
    roundNo: number;
    reviewKind: MediaReviewKind;
    verdict: MediaReviewVerdict;
    score: number | null;
    dimensionsJson: string;
    notes: string;
    reviewerId: string | null;
    reviewerName: string | null;
    createdAt: number;
  }>[number]>(id);
  return {
    ...asset,
    links,
    reviews: reviewRows.map(({ dimensionsJson, ...review }) => ({ ...review, dimensions: parseObject(dimensionsJson) })),
  };
}

export async function linkMediaAsset(input: {
  assetId: string;
  subjectType: MediaLinkSubjectType;
  subjectId: string;
  purpose: string;
  position: number;
  userId: string;
}): Promise<MediaAssetDetail> {
  const targetTables: Record<MediaLinkSubjectType, string> = {
    knowledge: "knowledge_items",
    publication: "publications",
    song_spec: "song_specs",
    candidate: "candidates",
    release: "release_packages",
  };
  const table = targetTables[input.subjectType];
  const database = getDb();
  await database.transaction(async (transaction) => {
    await findAssetRow(input.assetId, transaction);
    const target = await transaction.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(input.subjectId);
    if (!target) throw new ApiError(404, "关联目标不存在");
    await transaction.prepare(`
      INSERT INTO media_links (id, asset_id, subject_type, subject_id, purpose, position, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, subject_type, subject_id, purpose) DO UPDATE SET
        position = EXCLUDED.position,
        created_by = EXCLUDED.created_by
    `).run(randomUUID(), input.assetId, input.subjectType, input.subjectId, input.purpose, input.position, input.userId, Date.now());
    await recordAudit(input.userId, "media.link", "media_asset", input.assetId, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      purpose: input.purpose,
      position: input.position,
    }, transaction);
  })();
  return getMediaAsset(input.assetId);
}

export async function reviewMediaAsset(input: {
  assetId: string;
  reviewKind: MediaReviewKind;
  verdict: MediaReviewVerdict;
  score: number | null;
  dimensions: Record<string, unknown>;
  notes: string;
  rubricRevisionId?: string;
  roundNo: number;
  reviewerId: string;
}): Promise<MediaAssetDetail> {
  const dimensionsJson = JSON.stringify(input.dimensions);
  if (dimensionsJson.length > 10_000) throw new ApiError(400, "评审维度数据过大");
  const database = getDb();
  await database.transaction(async (transaction) => {
    await findAssetRow(input.assetId, transaction);
    await transaction.prepare(`
      INSERT INTO media_reviews (
        id, asset_id, rubric_revision_id, round_no, review_kind, verdict, score,
        dimensions_json, notes, reviewer_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.assetId,
      input.rubricRevisionId ?? null,
      input.roundNo,
      input.reviewKind,
      input.verdict,
      input.score,
      dimensionsJson,
      input.notes,
      input.reviewerId,
      Date.now(),
    );
    if (input.verdict === "reject") {
      await transaction.prepare("UPDATE media_assets SET status = 'rejected', updated_at = ? WHERE id = ?").run(Date.now(), input.assetId);
    }
    await recordAudit(input.reviewerId, "media.review", "media_asset", input.assetId, {
      reviewKind: input.reviewKind,
      verdict: input.verdict,
      score: input.score,
      roundNo: input.roundNo,
    }, transaction);
  })();
  return getMediaAsset(input.assetId);
}

async function ensureSongMediaAsset(songId: string): Promise<string> {
  const database = getDb();
  const existing = await database.prepare("SELECT id FROM media_assets WHERE source_song_id = ? ORDER BY created_at ASC LIMIT 1").get<{ id: string }>(songId);
  if (existing) return existing.id;
  return database.transaction(async (transaction) => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`media:song:${songId}`);
    const lockedExisting = await transaction.prepare("SELECT id FROM media_assets WHERE source_song_id = ? ORDER BY created_at ASC LIMIT 1").get<{ id: string }>(songId);
    if (lockedExisting) return lockedExisting.id;
    const song = await transaction.prepare(`
      SELECT id, object_key, original_name, mime_type, size_bytes, qiniu_hash, status, uploaded_by, created_at, updated_at
      FROM songs WHERE id = ?
    `).get<{
      id: string;
      object_key: string;
      original_name: string;
      mime_type: string;
      size_bytes: number;
      qiniu_hash: string;
      status: string;
      uploaded_by: string;
      created_at: number;
      updated_at: number;
    }>(songId);
    if (!song) throw new ApiError(404, "歌曲不存在");
    const existingObject = await transaction.prepare("SELECT id, uploaded_by FROM media_assets WHERE storage_provider = 'qiniu' AND object_key = ?").get<{ id: string; uploaded_by: string | null }>(song.object_key);
    if (existingObject) {
      if (existingObject.uploaded_by !== song.uploaded_by) throw new ApiError(409, "媒体对象归属不匹配，不能复用");
      await transaction.prepare("UPDATE media_assets SET source_song_id = COALESCE(source_song_id, ?), updated_at = ? WHERE id = ?").run(songId, Date.now(), existingObject.id);
      return existingObject.id;
    }
    const mediaKind = inferMediaKind(song.mime_type, song.original_name);
    const metadata: Record<string, unknown> = { ...baseRegistrationMetadata({ provider: "qiniu" }), legacySong: true };
    metadata.integrity = {
      verification: "unverified",
      reason: "legacy_song_not_server_verified",
      clientHashes: clientHashHints({ qiniuHash: song.qiniu_hash }),
    };
    const thumbnail = isVideoKind(mediaKind)
      ? buildThumbnailMetadata({ objectKey: song.object_key, originalName: song.original_name, contentHash: "", qiniuHash: "", durationMs: null, width: null, height: null })
      : undefined;
    if (thumbnail) metadata.thumbnail = thumbnail.metadata;
    const id = randomUUID();
    await insertMediaAsset(transaction, {
      id,
      storageProvider: "qiniu",
      objectKey: song.object_key,
      originalName: song.original_name,
      mediaKind,
      mimeType: song.mime_type,
      sizeBytes: song.size_bytes,
      contentHash: "",
      qiniuHash: "",
      status: song.status === "rejected" ? "rejected" : isStreamingKind(mediaKind) ? "uploaded" : "ready",
      transcript: deterministicTranscript({ originalName: song.original_name, mediaKind, mimeType: song.mime_type, durationMs: null, metadata }),
      transcriptModel: MOCK_TRANSCRIPT_MODEL,
      thumbnailObjectKey: thumbnail?.objectKey,
      metadata,
      sourceSongId: songId,
      uploadedById: song.uploaded_by,
    });
    await replaceVideoPrefilter(transaction, mapAsset(await findAssetRow(id, transaction)));
    return id;
  })();
}

export async function syncSongMediaAnalysis(input: {
  songId: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  analyzedSizeBytes: number;
  trustedContentHash: string;
  reportId: string;
  passed: boolean;
  total: number | null;
  analyzerVersion: string;
  notes: string;
}): Promise<void> {
  if (!isTrustedContentHash(input.trustedContentHash)) throw new Error("服务器音频字节哈希无效");
  const assetId = await ensureSongMediaAsset(input.songId);
  const database = getDb();
  await database.transaction(async (transaction) => {
    const raw = await findAssetRow(assetId, transaction);
    const metadata = parseObject(raw.metadataJson);
    const now = Date.now();
    metadata.audioAnalysis = {
      reportId: input.reportId,
      analyzer: input.analyzerVersion,
      total: input.total,
      passed: input.passed,
      notes: input.notes,
    };
    metadata.technicalProbe = {
      source: "ffprobe",
      ffprobeAvailable: true,
      ffmpegAvailable: false,
      analyzedSizeBytes: input.analyzedSizeBytes,
      error: null,
    };
    metadata.integrity = {
      verification: "verified",
      algorithm: "sha256",
      verifiedAt: now,
    };
    delete metadata.analysisFailure;
    const durationMs = Number.isFinite(input.durationSec) && input.durationSec > 0 ? Math.round(input.durationSec * 1000) : null;
    const transcript = deterministicTranscript({
      originalName: raw.originalName,
      mediaKind: raw.mediaKind,
      mimeType: raw.mimeType,
      durationMs,
      metadata,
    });
    await transaction.prepare(`
      UPDATE media_assets
      SET status = ?, content_hash = ?, duration_ms = ?, sample_rate = ?, channels = ?, transcript = ?, transcript_model = ?, metadata_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('uploaded', 'analyzing')
    `).run(
      input.passed ? "ready" : "rejected",
      input.trustedContentHash,
      durationMs,
      Number.isFinite(input.sampleRate) && input.sampleRate > 0 ? input.sampleRate : null,
      Number.isFinite(input.channels) && input.channels > 0 ? input.channels : null,
      transcript,
      MOCK_TRANSCRIPT_MODEL,
      JSON.stringify(metadata),
      now,
      assetId,
    );
  })();
}

export async function beginSongMediaAnalysis(songId: string): Promise<boolean> {
  const assetId = await ensureSongMediaAsset(songId);
  const result = await getDb().prepare(`
    UPDATE media_assets SET status = 'analyzing', updated_at = ?
    WHERE id = ? AND status = 'uploaded'
  `).run(Date.now(), assetId);
  return result.changes === 1;
}

export async function markSongMediaAnalysisFailed(songId: string, reason: string, trustedContentHash?: string): Promise<void> {
  const assetId = await ensureSongMediaAsset(songId);
  await markMediaAnalysisFailed(assetId, reason, trustedContentHash);
}


function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === "0/0") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const parsed = numerator / denominator;
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(3)) : null;
}

async function hasFfmpeg(): Promise<boolean> {
  if (!ffmpegAvailability) {
    ffmpegAvailability = execFileAsync("ffmpeg", ["-version"], { timeout: 3_000, maxBuffer: 64 * 1024 })
      .then(() => true)
      .catch(() => false);
  }
  return ffmpegAvailability;
}

export async function extractMediaTechnicalMetadata(file: string, expectedSize: number): Promise<MediaTechnicalMetadata> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,size:stream=codec_type,sample_rate,channels,width,height,r_frame_rate,avg_frame_rate",
      "-of", "json",
      file,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; size?: string };
      streams?: Array<{
        codec_type?: string;
        sample_rate?: string;
        channels?: number;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        avg_frame_rate?: string;
      }> ;
    };
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio" || stream.sample_rate || stream.channels);
    const video = parsed.streams?.find((stream) => stream.codec_type === "video" || stream.width || stream.height);
    const duration = Number(parsed.format?.duration ?? 0);
    return {
      durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
      sampleRate: Number.isFinite(Number(audio?.sample_rate)) && Number(audio?.sample_rate) > 0 ? Number(audio?.sample_rate) : null,
      channels: Number.isFinite(Number(audio?.channels)) && Number(audio?.channels) > 0 ? Number(audio?.channels) : null,
      width: Number.isFinite(Number(video?.width)) && Number(video?.width) > 0 ? Number(video?.width) : null,
      height: Number.isFinite(Number(video?.height)) && Number(video?.height) > 0 ? Number(video?.height) : null,
      frameRate: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
      ffprobeAvailable: true,
      ffmpegAvailable: video ? await hasFfmpeg() : false,
      analyzedSizeBytes: Number(parsed.format?.size ?? expectedSize) || expectedSize,
      error: null,
    };
  } catch {
    return {
      durationMs: null,
      sampleRate: null,
      channels: null,
      width: null,
      height: null,
      frameRate: null,
      ffprobeAvailable: false,
      ffmpegAvailable: false,
      analyzedSizeBytes: expectedSize,
      error: "ffprobe 无法读取媒体技术元数据",
    };
  }
}

async function applyTechnicalMetadata(assetId: string, probe: MediaTechnicalMetadata, trustedContentHash: string): Promise<"ready" | "failed" | "ignored"> {
  if (!isTrustedContentHash(trustedContentHash)) throw new Error("服务器媒体字节哈希无效");
  const database = getDb();
  return database.transaction(async (transaction) => {
    const raw = await findAssetRow(assetId, transaction);
    const metadata = parseObject(raw.metadataJson);
    const reason = technicalMetadataFailure(raw.mediaKind, probe);
    const status: MediaStatus = reason ? "failed" : "ready";
    const now = Date.now();
    metadata.technicalProbe = {
      source: probe.ffprobeAvailable ? "ffprobe" : "unavailable",
      ffprobeAvailable: probe.ffprobeAvailable,
      ffmpegAvailable: probe.ffmpegAvailable,
      analyzedSizeBytes: probe.analyzedSizeBytes,
      error: reason,
    };
    metadata.integrity = {
      verification: "verified",
      algorithm: "sha256",
      verifiedAt: now,
    };
    if (reason) {
      metadata.analysisFailure = { phase: "technical_metadata", reason };
    } else {
      delete metadata.analysisFailure;
    }
    const thumbnail = isVideoKind(raw.mediaKind)
      ? buildThumbnailMetadata({
        objectKey: raw.objectKey,
        originalName: raw.originalName,
        contentHash: trustedContentHash,
        qiniuHash: "",
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
      })
      : undefined;
    if (thumbnail) metadata.thumbnail = thumbnail.metadata;
    const transcript = deterministicTranscript({
      originalName: raw.originalName,
      mediaKind: raw.mediaKind,
      mimeType: raw.mimeType,
      durationMs: probe.durationMs,
      metadata,
    });
    const result = await transaction.prepare(`
      UPDATE media_assets
      SET status = ?, content_hash = ?, duration_ms = ?, sample_rate = ?, channels = ?, width = ?, height = ?, frame_rate = ?,
          transcript = ?, transcript_model = ?, thumbnail_object_key = ?, metadata_json = ?, updated_at = ?
      WHERE id = ? AND status = 'analyzing'
    `).run(
      status,
      trustedContentHash,
      probe.durationMs,
      probe.sampleRate,
      probe.channels,
      probe.width,
      probe.height,
      probe.frameRate,
      transcript,
      MOCK_TRANSCRIPT_MODEL,
      thumbnail?.objectKey ?? raw.thumbnailObjectKey,
      JSON.stringify(metadata),
      now,
      assetId,
    );
    if (!result.changes) return "ignored";
    if (status === "ready") {
      await replaceVideoPrefilter(transaction, mapAsset(await findAssetRow(assetId, transaction)));
    }
    return status;
  })();
}

async function markMediaAnalysisFailed(assetId: string, reason: string, trustedContentHash?: string): Promise<void> {
  const database = getDb();
  await database.transaction(async (transaction) => {
    const raw = await findAssetRow(assetId, transaction);
    const metadata = parseObject(raw.metadataJson);
    const now = Date.now();
    const verifiedHash = trustedContentHash && isTrustedContentHash(trustedContentHash) ? trustedContentHash : raw.contentHash;
    metadata.analysisFailure = { phase: "analysis", reason };
    if (trustedContentHash && isTrustedContentHash(trustedContentHash)) {
      metadata.integrity = { verification: "verified", algorithm: "sha256", verifiedAt: now };
    }
    await transaction.prepare(`
      UPDATE media_assets
      SET status = 'failed', content_hash = ?, metadata_json = ?, updated_at = ?
      WHERE id = ? AND status = 'analyzing'
    `).run(verifiedHash, JSON.stringify(metadata), now, assetId);
  })();
}

export async function analyzeQiniuMediaAsset(assetId: string, signal: AbortSignal): Promise<void> {
  const database = getDb();
  const raw = await findAssetRow(assetId, database);
  if (raw.storageProvider !== "qiniu" || !isStreamingKind(raw.mediaKind)) return;
  const settings = await getProviderSettings();
  if (!isQiniuObjectKeyInNamespace(raw.objectKey, settings.qiniu.prefix)) throw new ApiError(403, "媒体对象不在受控七牛命名空间内");
  const claim = await database.prepare(`
    UPDATE media_assets SET status = 'analyzing', updated_at = ?
    WHERE id = ? AND status = 'uploaded'
  `).run(Date.now(), assetId);
  if (!claim.changes) return;

  const directory = path.join(getDataDir(), "media-analysis-tmp", randomUUID());
  const file = path.join(directory, "input-media");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const response = await fetch(await createQiniuObjectUrl(raw.objectKey, 15 * 60), { signal, cache: "no-store" });
    if (!response.ok || !response.body) throw new ApiError(502, `下载七牛媒体失败（HTTP ${response.status}）`);
    let downloaded = 0;
    const digest = createHash("sha256");
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.byteLength;
        if (downloaded > MAX_ANALYSIS_BYTES) {
          callback(new ApiError(413, "下载媒体超过 500MB 分析上限"));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(file, { mode: 0o600 }));
    const outcome = await applyTechnicalMetadata(assetId, await extractMediaTechnicalMetadata(file, downloaded), digest.digest("hex"));
    if (outcome === "failed") throw new ApiError(422, "媒体技术元数据校验失败");
  } catch (error) {
    await markMediaAnalysisFailed(assetId, "媒体分析失败").catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "媒体分析失败");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function getMediaAssetPreview(id: string): Promise<MediaPreview> {
  const asset = mapAsset(await findAssetRow(id));
  if (asset.storageProvider === "mock" || asset.storageProvider === "local") {
    return {
      type: "metadata",
      asset,
      preview: {
        mode: asset.storageProvider === "mock" ? "deterministic_mock" : "local_metadata",
        objectKey: asset.objectKey,
        mediaKind: asset.mediaKind,
        durationMs: asset.durationMs,
        dimensions: asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
        thumbnailObjectKey: asset.thumbnailObjectKey || null,
        transcriptModel: asset.transcriptModel,
        metadata: asset.metadata,
      },
    };
  }
  const settings = await getProviderSettings();
  if (!isQiniuObjectKeyInNamespace(asset.objectKey, settings.qiniu.prefix)) {
    throw new ApiError(403, "媒体对象不在受控七牛命名空间内");
  }
  return { type: "redirect", url: await createQiniuObjectUrl(asset.objectKey) };
}

export async function getSongMediaPreview(songId: string): Promise<MediaPreview> {
  return getMediaAssetPreview(await ensureSongMediaAsset(songId));
}
