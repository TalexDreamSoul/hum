import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api";
import { getDataDir } from "./data-dir";

const PREVIEW_DIRECTORY = "music-test-previews";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_ACTIVE_PREVIEWS = 32;
const HANDLE_BYTES = 24;
const HANDLE_LENGTH = 32;
const HANDLE_RE = new RegExp(`^[A-Za-z0-9_-]{${HANDLE_LENGTH}}$`);
const PREVIEW_CONTENT_TYPE = "audio/wav";

interface MusicTestPreviewMetadata {
  createdAt: number;
  expiresAt: number;
  contentType: typeof PREVIEW_CONTENT_TYPE;
}

export interface MusicTestPreview {
  audioUrl: string;
  expiresAt: number;
  sizeBytes: number;
}

export interface StoredMusicTestPreview {
  absolutePath: string;
  contentType: typeof PREVIEW_CONTENT_TYPE;
  sizeBytes: number;
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function previewPaths(root: string, handle: string) {
  return {
    audioPath: path.join(root, `${handle}.wav`),
    metadataPath: path.join(root, `${handle}.json`),
  };
}

function parseMetadata(raw: string): MusicTestPreviewMetadata | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("createdAt" in value) ||
      !("expiresAt" in value) ||
      !("contentType" in value) ||
      typeof value.createdAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.createdAt) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= value.createdAt ||
      value.contentType !== PREVIEW_CONTENT_TYPE
    ) return null;
    return {
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      contentType: PREVIEW_CONTENT_TYPE,
    };
  } catch {
    return null;
  }
}

async function previewRoot(): Promise<string> {
  const root = path.join(getDataDir(), PREVIEW_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try { await chmod(root, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  return root;
}

async function removePreview(root: string, handle: string): Promise<void> {
  const { audioPath, metadataPath } = previewPaths(root, handle);
  await Promise.all([
    rm(audioPath, { force: true }),
    rm(metadataPath, { force: true }),
  ]);
}

async function readMetadata(metadataPath: string): Promise<MusicTestPreviewMetadata | null> {
  try {
    return parseMetadata(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function prunePreviews(root: string, now: number): Promise<void> {
  const handles = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^([A-Za-z0-9_-]{32})\.(?:json|wav)$/.exec(entry.name);
    if (match) handles.add(match[1]);
  }

  let active = 0;
  for (const handle of handles) {
    const { metadataPath } = previewPaths(root, handle);
    const metadata = await readMetadata(metadataPath);
    if (!metadata || metadata.expiresAt <= now) {
      await removePreview(root, handle);
      continue;
    }
    active += 1;
  }

  if (active >= MAX_ACTIVE_PREVIEWS) {
    throw new ApiError(429, "临时试听存储繁忙，请稍后再试");
  }
}

export async function createMusicTestPreview(audioBytes: Uint8Array): Promise<MusicTestPreview> {
  if (!audioBytes.byteLength) throw new ApiError(502, "Mock provider 未返回试听音频");
  if (audioBytes.byteLength > MAX_PREVIEW_BYTES) throw new ApiError(413, "试听音频超过 10 MB 临时交付上限");

  const root = await previewRoot();
  const now = Date.now();
  await prunePreviews(root, now);
  const expiresAt = now + PREVIEW_TTL_MS;
  const metadata = JSON.stringify({ createdAt: now, expiresAt, contentType: PREVIEW_CONTENT_TYPE });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = randomBytes(HANDLE_BYTES).toString("base64url");
    const { audioPath, metadataPath } = previewPaths(root, handle);
    let audioCreated = false;
    try {
      await writeFile(audioPath, audioBytes, { flag: "wx", mode: 0o600 });
      audioCreated = true;
      await writeFile(metadataPath, metadata, { flag: "wx", mode: 0o600 });
      return {
        audioUrl: `/api/admin/music-test/${handle}`,
        expiresAt,
        sizeBytes: audioBytes.byteLength,
      };
    } catch (error) {
      if (audioCreated) await rm(audioPath, { force: true });
      if (hasFileSystemCode(error, "EEXIST")) continue;
      throw error;
    }
  }

  throw new ApiError(503, "无法创建临时试听，请重试");
}

export async function getMusicTestPreview(handle: string): Promise<StoredMusicTestPreview> {
  if (!HANDLE_RE.test(handle)) throw new ApiError(404, "试听不存在");

  const root = await previewRoot();
  const { audioPath, metadataPath } = previewPaths(root, handle);
  const metadata = await readMetadata(metadataPath);
  if (!metadata) {
    await removePreview(root, handle);
    throw new ApiError(404, "试听不存在");
  }
  if (metadata.expiresAt <= Date.now()) {
    await removePreview(root, handle);
    throw new ApiError(410, "试听已过期");
  }

  let details: Stats;
  try {
    details = await stat(audioPath);
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) {
      await rm(metadataPath, { force: true });
      throw new ApiError(404, "试听不存在");
    }
    throw error;
  }
  if (!details.isFile() || details.size <= 0 || details.size > MAX_PREVIEW_BYTES) {
    await removePreview(root, handle);
    throw new ApiError(404, "试听不存在");
  }

  return {
    absolutePath: audioPath,
    contentType: metadata.contentType,
    sizeBytes: details.size,
  };
}
