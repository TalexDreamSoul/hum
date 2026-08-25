"use client";

import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Grid,
  GridItem,
  InputArea,
  LinkButton,
  Select,
  Text,
} from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import {
  MINIMAX_CURRENT_MUSIC_MODELS,
  MINIMAX_MUSIC_MODEL_LABELS,
  type MiniMaxCurrentMusicModel,
  type MiniMaxMusicModel,
} from "@/lib/minimax";

interface MusicRun {
  model: MiniMaxMusicModel;
  ok: boolean;
  latencyMs: number;
  audioUrl?: string;
  durationMs?: number;
  sampleRate?: number;
  bitrate?: number;
  sizeBytes?: number;
  error?: string;
}

interface MusicTestResponse {
  runs?: MusicRun[];
  expiresAt?: number;
  persisted?: boolean;
  error?: string;
}

const MODEL_ITEMS = MINIMAX_CURRENT_MUSIC_MODELS.map((value) => ({
  value,
  label: MINIMAX_MUSIC_MODEL_LABELS[value],
}));

const DEFAULT_PROMPT = "Mandarin children's educational pop, 112 BPM, warm clear female vocal, simple melody within one octave, precise diction, gentle piano and music box, restrained percussion, four obvious call-and-response pauses per minute, clean spacious mix";
const DEFAULT_LYRICS = `[Verse]\n红灯停，绿灯行\n路口先把左右看清\n\n[Chorus]\n我等一等——\n你来接一句\n安全过马路\n每天都记住\n\n[Bridge]\n一步，两步\n小手牵牢不着急`;

function formatDuration(value?: number): string {
  if (!value) return "—";
  return `${Math.round(value / 1000)} 秒`;
}

function formatSize(value?: number): string {
  if (!value) return "—";
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function MusicLab({
  ready,
  defaultModel,
}: {
  ready: boolean;
  defaultModel: MiniMaxCurrentMusicModel;
}) {
  const toast = useConsoleToast();
  const [model, setModel] = useState<MiniMaxCurrentMusicModel>(defaultModel);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [lyrics, setLyrics] = useState(DEFAULT_LYRICS);
  const [lyricsOptimizer, setLyricsOptimizer] = useState(false);
  const [instrumental, setInstrumental] = useState(false);
  const [compareWithPrevious, setCompareWithPrevious] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<MusicRun[]>([]);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRuns([]);
    setExpiresAt(null);
    try {
      const response = await fetch("/api/admin/music-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, lyrics, lyricsOptimizer, instrumental, compareWithPrevious }),
      });
      const payload = await response.json() as MusicTestResponse;
      setRuns(payload.runs ?? []);
      setExpiresAt(payload.expiresAt ?? null);
      if (!response.ok) throw new Error(payload.error || "模型测试失败");
      toast.success("模型测试完成", "结果只在浏览器试听，未自动入库");
    } catch (error) {
      toast.error("模型测试失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return <Banner variant="alert" title="MiniMax 尚未配置" description="请先到系统配置保存 MiniMax API Key。建议默认使用 music-3.0-free。" />;
  }

  return (
    <Grid gap="base">
      <ConsoleSection title="生成条件" status={<Badge variant="info">管理员测试</Badge>}>
        <form onSubmit={submit}>
          <Grid gap="sm">
            <Select
              label="Music 3.0 模型"
              value={model}
              items={MODEL_ITEMS}
              onValueChange={(value: MiniMaxCurrentMusicModel | null) => value && setModel(value)}
              renderValue={(value: MiniMaxCurrentMusicModel) => MINIMAX_MUSIC_MODEL_LABELS[value]}
            />
            <InputArea
              label="音乐描述"
              description="最多 2000 字；建议明确 BPM、调性、音域、咬字、乐器和接唱留白。"
              value={prompt}
              onValueChange={setPrompt}
              autoResize
              minRows={4}
              maxRows={10}
            />
            {!instrumental && (
              <InputArea
                label="歌词"
                description="最多 3500 字，支持 Verse、Chorus、Bridge、Outro 等结构标签。"
                value={lyrics}
                onValueChange={setLyrics}
                autoResize
                minRows={8}
                maxRows={18}
                disabled={lyricsOptimizer}
              />
            )}
            <Grid variant="3up" gap="sm">
              <GridItem>
                <Checkbox
                  label="纯音乐"
                  checked={instrumental}
                  onCheckedChange={(checked) => {
                    setInstrumental(checked);
                    if (checked) setLyricsOptimizer(false);
                  }}
                />
              </GridItem>
              <GridItem>
                <Checkbox
                  label="由 MiniMax 自动生成歌词"
                  checked={lyricsOptimizer}
                  disabled={instrumental}
                  onCheckedChange={setLyricsOptimizer}
                />
              </GridItem>
              <GridItem>
                <Checkbox
                  label="同时对比 Music 2.6"
                  checked={compareWithPrevious}
                  onCheckedChange={setCompareWithPrevious}
                />
              </GridItem>
            </Grid>
            <Button type="submit" disabled={busy}>{busy ? "正在生成，可能需要数分钟…" : "开始模型测试"}</Button>
          </Grid>
        </form>
      </ConsoleSection>

      <Banner
        variant="default"
        title="测试结果不会自动入库"
        description="Mock 音频仅以受管理员会话保护的同源临时地址试听，10 分钟后失效；不会写入 songs/candidates 或转存七牛。"
      />

      {runs.map((run) => (
        <ConsoleSection
          key={run.model}
          title={MINIMAX_MUSIC_MODEL_LABELS[run.model]}
          status={<Badge variant={run.ok ? "success" : "warning"}>{run.ok ? "生成成功" : "生成失败"}</Badge>}
        >
          {run.ok && run.audioUrl ? (
            <Grid gap="sm">
              <audio controls preload="none" src={run.audioUrl} />
              <Grid variant="4up" gap="sm">
                <GridItem><Text variant="secondary">耗时</Text><Text>{(run.latencyMs / 1000).toFixed(1)} 秒</Text></GridItem>
                <GridItem><Text variant="secondary">时长</Text><Text>{formatDuration(run.durationMs)}</Text></GridItem>
                <GridItem><Text variant="secondary">采样率</Text><Text>{run.sampleRate ? `${run.sampleRate} Hz` : "—"}</Text></GridItem>
                <GridItem><Text variant="secondary">大小</Text><Text>{formatSize(run.sizeBytes)}</Text></GridItem>
              </Grid>
              <LinkButton href={run.audioUrl} external variant="secondary">打开临时音频地址</LinkButton>
            </Grid>
          ) : (
            <Banner variant="error" title={run.error || "MiniMax 生成失败"} />
          )}
        </ConsoleSection>
      ))}

      {expiresAt && runs.some((run) => run.ok) && (
        <Text variant="secondary">临时试听将在 {new Date(expiresAt).toLocaleString("zh-CN")} 失效，访问需要管理员会话。</Text>
      )}
    </Grid>
  );
}
