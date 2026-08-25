/**
 * Mock provider、媒体分类的核心合同。
 * 跑法：node --experimental-transform-types test/mock-provider-contracts.ts
 * Node 24 以 transform-types 处理参数属性；不连接数据库或外部服务。
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const NEXT_EXTENSIONLESS_SUBPATHS = new Set([
  "next/server",
  "next/headers",
  "next/navigation",
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20{}",
      };
    }

    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }

    if (NEXT_EXTENSIONLESS_SUBPATHS.has(specifier)) {
      try {
        return nextResolve(`${specifier}.js`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }

    if (
      (specifier.startsWith("./") || specifier.startsWith("../"))
      && extname(specifier) === ""
    ) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        return nextResolve(specifier, context);
      }
    }

    return nextResolve(specifier, context);
  },
});

let failed = 0;

function check(name: string, ok: boolean, got: string) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${got}`);
  if (!ok) failed++;
}

function wavHeaderIsValid(bytes: Uint8Array): boolean {
  const wav = Buffer.from(bytes);
  return wav.length >= 44
    && wav.toString("ascii", 0, 4) === "RIFF"
    && wav.readUInt32LE(4) + 8 === wav.length
    && wav.toString("ascii", 8, 12) === "WAVE"
    && wav.toString("ascii", 12, 16) === "fmt "
    && wav.readUInt16LE(20) === 1
    && wav.readUInt16LE(22) === 1
    && wav.readUInt32LE(24) === 44_100
    && wav.readUInt16LE(34) === 16
    && wav.toString("ascii", 36, 40) === "data"
    && wav.readUInt32LE(40) === wav.length - 44;
}

function createTinyWav(): Uint8Array {
  const pcm = Buffer.from([0, 0, 0, 0]);
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44_100, 24);
  wav.writeUInt32LE(88_200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function captureFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
    return { status: undefined, message: undefined };
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
    return { status, message: error instanceof Error ? error.message : undefined };
  }
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "hum-mock-provider-contracts-"));
  const originalDataDir = process.env.HUM_DATA_DIR;
  const originalDateNow = Date.now;
  const databaseGlobal = globalThis as typeof globalThis & {
    __humDatabase?: unknown;
    __humDatabaseReady?: Promise<void>;
  };
  const databaseDescriptor = Object.getOwnPropertyDescriptor(databaseGlobal, "__humDatabase");
  const readyDescriptor = Object.getOwnPropertyDescriptor(databaseGlobal, "__humDatabaseReady");
  let now = 1_700_000_000_000;

  process.env.HUM_DATA_DIR = dataDir;
  Date.now = () => now;

  try {
    const [
      {
        MOCK_ENABLED,
        MOCK_MUSIC_MODEL,
        MOCK_PROVIDER,
        MOCK_REQUESTS_PER_MINUTE,
        createMockKnowledgeExpansion,
        mockMarker,
      },
      { inferMediaKind },
      { generateMiniMaxMusic },
      { createMusicTestPreview, getMusicTestPreview },
    ] = await Promise.all([
      import("../lib/server/mock-provider.ts"),
      import("../lib/server/media.ts"),
      import("../lib/server/minimax.ts"),
      import("../lib/server/music-test-preview.ts"),
    ]);

    const marker = mockMarker();
    check(
      "Mock provider policy is immutable",
      MOCK_ENABLED === true
        && MOCK_PROVIDER === "mock"
        && MOCK_MUSIC_MODEL === "music-3.0-free"
        && MOCK_REQUESTS_PER_MINUTE === 3
        && marker.mock === true
        && marker.provider === "mock",
      JSON.stringify({ enabled: MOCK_ENABLED, provider: marker.provider, model: MOCK_MUSIC_MODEL, rpm: MOCK_REQUESTS_PER_MINUTE }),
    );

    const expansionInput = { theme: "  水 循环  ", maxPoints: 4 };
    const firstExpansion = createMockKnowledgeExpansion(expansionInput);
    const secondExpansion = createMockKnowledgeExpansion(expansionInput);
    check(
      "Knowledge expansion is deterministic for the same request",
      JSON.stringify(firstExpansion) === JSON.stringify(secondExpansion),
      firstExpansion.slug,
    );

    for (const { maxPoints, expectedPoints } of [
      { maxPoints: 2, expectedPoints: 3 },
      { maxPoints: 4, expectedPoints: 4 },
      { maxPoints: 6, expectedPoints: 5 },
    ]) {
      const expansion = createMockKnowledgeExpansion({ theme: "植物生长", maxPoints });
      const completeChain = expansion.logicLinks.length === expansion.points.length - 1
        && expansion.logicLinks.every((link, index) => link.fromIndex === index && link.toIndex === index + 1);
      check(
        `Knowledge expansion clamps to ${expectedPoints} points with a complete logic chain`,
        expansion.points.length === expectedPoints && completeChain,
        `${expansion.points.length} points, ${expansion.logicLinks.length} links`,
      );
    }

    const exchanges: Array<{ endpoint: string; requestBody: Record<string, unknown>; status: number; responseText: string }> = [];
    const musicInput = {
      model: "music-3.0-free" as const,
      prompt: "A 45 seconds learning song",
      lyrics: "观察，梳理，表达，复习。",
      lyricsOptimizer: false,
      instrumental: false,
    };
    const firstRun = await generateMiniMaxMusic({
      ...musicInput,
      signal: new AbortController().signal,
      onExchange: (exchange) => exchanges.push(exchange),
    });
    const secondRun = await generateMiniMaxMusic({ ...musicInput, signal: new AbortController().signal });
    const firstBytes = firstRun.audioBytes;
    const secondBytes = secondRun.audioBytes;
    const firstHash = firstBytes ? createHash("sha256").update(firstBytes).digest("hex") : "";
    const secondHash = secondBytes ? createHash("sha256").update(secondBytes).digest("hex") : "";
    const exchange = exchanges[0];

    check(
      "Free Mock music returns a valid deterministic WAV with stable duration metadata",
      firstRun.ok
        && secondRun.ok
        && firstRun.model === "music-3.0-free"
        && firstRun.provider === "mock"
        && firstRun.mock === true
        && firstRun.durationMs === 45_000
        && firstRun.sampleRate === 44_100
        && firstRun.channels === 1
        && Boolean(firstBytes && wavHeaderIsValid(firstBytes))
        && firstHash === secondHash
        && firstRun.traceId === secondRun.traceId
        && exchange?.endpoint === "mock://music-3.0-free"
        && exchange?.status === 200
        && exchange?.requestBody.model === "music-3.0-free"
        && exchange?.requestBody.actualFormat === "wav",
      JSON.stringify({ durationMs: firstRun.durationMs, bytes: firstRun.sizeBytes, hash: firstHash.slice(0, 12) }),
    );

    const tinyWav = createTinyWav();
    const preview = await createMusicTestPreview(tinyWav);
    const handle = preview.audioUrl.split("/").at(-1) ?? "";
    const previewRoot = join(dataDir, "music-test-previews");
    const audioPath = join(previewRoot, `${handle}.wav`);
    const metadataPath = join(previewRoot, `${handle}.json`);
    const [directoryStats, audioStats, metadataStats, storedPreview, storedBytes] = await Promise.all([
      stat(previewRoot),
      stat(audioPath),
      stat(metadataPath),
      getMusicTestPreview(handle),
      readFile(audioPath),
    ]);
    const serializedPreview = JSON.stringify(preview);
    check(
      "Music-test preview returns a short same-origin handle and never serializes WAV bytes",
      wavHeaderIsValid(tinyWav)
        && /^[-_A-Za-z0-9]{32}$/.test(handle)
        && preview.audioUrl === `/api/admin/music-test/${handle}`
        && !preview.audioUrl.includes("://")
        && !("audioBytes" in preview)
        && serializedPreview.length < 256,
      JSON.stringify({ url: preview.audioUrl, responseBytes: serializedPreview.length }),
    );
    check(
      "Music-test preview stores private WAV files and exposes correct MIME and byte metadata",
      (directoryStats.mode & 0o777) === 0o700
        && (audioStats.mode & 0o777) === 0o600
        && (metadataStats.mode & 0o777) === 0o600
        && storedPreview.contentType === "audio/wav"
        && storedPreview.sizeBytes === tinyWav.byteLength
        && storedBytes.equals(Buffer.from(tinyWav)),
      JSON.stringify({ mime: storedPreview.contentType, bytes: storedPreview.sizeBytes, mode: (audioStats.mode & 0o777).toString(8) }),
    );

    await Promise.all([
      writeFile(join(dataDir, "escape.wav"), tinyWav, { mode: 0o600 }),
      writeFile(join(dataDir, "escape.json"), JSON.stringify({
        createdAt: now,
        expiresAt: preview.expiresAt + 600_000,
        contentType: "audio/wav",
      }), { mode: 0o600 }),
    ]);
    now = preview.expiresAt;
    const expired = await captureFailure(() => getMusicTestPreview(handle));
    const missingAfterExpiry = await captureFailure(() => getMusicTestPreview(handle));
    const traversal = await captureFailure(() => getMusicTestPreview("../escape"));
    check(
      "Expired music-test preview is gone once, then missing; invalid handles cannot escape its directory",
      expired.status === 410
        && expired.message === "试听已过期"
        && missingAfterExpiry.status === 404
        && missingAfterExpiry.message === "试听不存在"
        && traversal.status === 404
        && traversal.message === "试听不存在",
      JSON.stringify({ expired: expired.status, afterExpiry: missingAfterExpiry.status, traversal: traversal.status }),
    );

    let paidModelError: unknown;
    try {
      await generateMiniMaxMusic({
        ...musicInput,
        model: "music-3.0",
        signal: new AbortController().signal,
      });
    } catch (error) {
      paidModelError = error;
    }
    const rejection = paidModelError instanceof Error && "status" in paidModelError
      ? paidModelError as Error & { status: unknown }
      : undefined;
    check(
      "Paid model cannot bypass the free Mock provider",
      rejection?.status === 400
        && rejection.message === "当前 Mock provider 只允许 music-3.0-free",
      JSON.stringify({ status: rejection?.status, error: rejection?.message }),
    );

    const mediaKind = inferMediaKind("video/webm", "lesson-screen-recording.webm", "screen_recording");
    check(
      "Requested WebM screen recording retains screen-recording classification",
      mediaKind === "screen_recording",
      mediaKind,
    );

    databaseGlobal.__humDatabase = {
      prepare: () => ({ get: async () => ({ probe: 1 }) }),
    } as unknown as NonNullable<typeof databaseGlobal.__humDatabase>;
    databaseGlobal.__humDatabaseReady = Promise.resolve();
    const { GET: readinessGet } = await import("../app/api/health/ready/route.ts");
    const readyResponse = await readinessGet();
    const readyPayload = await readyResponse.json() as { status?: unknown; database?: unknown };
    check(
      "Readiness returns no-store 200 only after the database probe succeeds",
      readyResponse.status === 200
        && readyResponse.headers.get("cache-control") === "no-store"
        && readyPayload.status === "ready"
        && readyPayload.database === "ready",
      JSON.stringify({ status: readyResponse.status, cacheControl: readyResponse.headers.get("cache-control") }),
    );

    const connectionDetail = "postgres://private-user:private-password@db.internal/hum";
    databaseGlobal.__humDatabaseReady = Promise.reject(new Error(connectionDetail));
    const unavailableResponse = await readinessGet();
    const unavailableText = await unavailableResponse.text();
    const unavailablePayload = JSON.parse(unavailableText) as { status?: unknown; database?: unknown };
    check(
      "Readiness maps database failures to no-store 503 without exposing connection details",
      unavailableResponse.status === 503
        && unavailableResponse.headers.get("cache-control") === "no-store"
        && unavailablePayload.status === "unavailable"
        && unavailablePayload.database === "unavailable"
        && !unavailableText.includes(connectionDetail),
      JSON.stringify({ status: unavailableResponse.status, body: unavailablePayload }),
    );

    console.log(failed ? `\n${failed} 项未通过` : "\n全部通过");
    if (failed) process.exitCode = 1;
  } finally {
    Date.now = originalDateNow;
    if (originalDataDir === undefined) delete process.env.HUM_DATA_DIR;
    else process.env.HUM_DATA_DIR = originalDataDir;
    restoreProperty(databaseGlobal, "__humDatabase", databaseDescriptor);
    restoreProperty(databaseGlobal, "__humDatabaseReady", readyDescriptor);
    await rm(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
