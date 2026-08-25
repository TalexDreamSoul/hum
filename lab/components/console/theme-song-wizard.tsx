"use client";

import { useState } from "react";
import { Banner, Button, Checkbox, Grid, GridItem, Input, InputArea, Select, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { MINIMAX_MUSIC_MODEL_LABELS, type MiniMaxCurrentMusicModel } from "@/lib/minimax";
import {
  THEME_AGE_BAND_ITEMS,
  THEME_AGE_DURATION_SEC,
  THEME_LYRIC_STYLE_ITEMS,
  THEME_SCENE_ITEMS,
  THEME_TUNING_ITEMS,
  type ThemeAgeBand,
  type ThemeLyricStyle,
  type ThemeScene,
  type ThemeTuning,
} from "@/lib/theme-song";

const LYRICS_MODE_ITEMS = [
  { value: "spec", label: "按 SongSpec 确定性生成" },
  { value: "minimax-edit", label: "MiniMax 润色（保留知识答案）" },
] as const;
const SAMPLE_RATE_ITEMS = [16000, 24000, 32000, 44100].map((value) => ({ value: String(value), label: `${value} Hz` }));
const BITRATE_ITEMS = [32000, 64000, 128000, 256000].map((value) => ({ value: String(value), label: `${value / 1000} kbps` }));
const AUDIO_FORMAT_ITEMS = ["mp3", "wav", "pcm"].map((value) => ({ value, label: value.toUpperCase() }));

interface ThemeSongWizardProps {
  ai: { ready: boolean; model: string };
  minimaxReady: boolean;
  defaultModel: MiniMaxCurrentMusicModel;
  availableModels: MiniMaxCurrentMusicModel[];
  onSubmitted: (manualConfirmation: boolean) => void;
}

async function requestJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

export function ThemeSongWizard({ ai, minimaxReady, defaultModel, availableModels, onSubmitted }: ThemeSongWizardProps) {
  const toast = useConsoleToast();
  const [theme, setTheme] = useState("");
  const [ageBand, setAgeBand] = useState<ThemeAgeBand>("5-6");
  const [scene, setScene] = useState<ThemeScene>("commute");
  const [tuning, setTuning] = useState<ThemeTuning>("general");
  const [lyricStyle, setLyricStyle] = useState<ThemeLyricStyle>("general");
  const [models, setModels] = useState<MiniMaxCurrentMusicModel[]>([defaultModel]);
  const [promptInstruction, setPromptInstruction] = useState("");
  const [lyricsInstruction, setLyricsInstruction] = useState("");
  const [lyricsMode, setLyricsMode] = useState<"spec" | "minimax-edit">("spec");
  const [sampleRate, setSampleRate] = useState("44100");
  const [bitrate, setBitrate] = useState("256000");
  const [format, setFormat] = useState<"mp3" | "wav" | "pcm">("mp3");
  const [sourceNotes, setSourceNotes] = useState("");
  const [manualConfirmation, setManualConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await requestJson<{ job: { id: string } }>("/api/admin/production-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          theme, ageBand, scene, tuning, lyricStyle, models, sourceNotes, manualConfirmation,
          promptInstruction, lyricsInstruction, lyricsMode,
          audioSetting: { sampleRate: Number(sampleRate), bitrate: Number(bitrate), format },
        }),
      }, "提交创作任务失败");
      onSubmitted(manualConfirmation);
    } catch (error) {
      toast.error("提交创作任务失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Grid gap="base">
      {!ai.ready && <Banner variant="alert" title="主题拆解 AI 尚未配置" description="请先在系统配置中填写 AI Base URL、API Key 和模型。" />}
      {!minimaxReady && <Banner variant="alert" title="MiniMax 尚未配置" description="可以先拆解并确认知识内容；生成候选前仍需配置可用的 MiniMax。" />}

      <ConsoleSection title="给一个主题">
        <Grid gap="sm">
          <Input
            label="学习主题"
            description="例如：认识红绿灯、乘法口诀 7、春天为什么会下雨。"
            value={theme}
            onValueChange={setTheme}
          />
          <Grid variant="2up" gap="sm">
            <GridItem>
              <Select
                label="年龄段"
                value={ageBand}
                items={[...THEME_AGE_BAND_ITEMS]}
                onValueChange={(value: ThemeAgeBand | null) => value && setAgeBand(value)}
                renderValue={(value: ThemeAgeBand) => THEME_AGE_BAND_ITEMS.find((item) => item.value === value)?.label ?? value}
              />
            </GridItem>
            <GridItem>
              <Select
                label="使用场景"
                value={scene}
                items={[...THEME_SCENE_ITEMS]}
                onValueChange={(value: ThemeScene | null) => value && setScene(value)}
                renderValue={(value: ThemeScene) => THEME_SCENE_ITEMS.find((item) => item.value === value)?.label ?? value}
              />
            </GridItem>
          </Grid>
          <Select
            label="音乐风格"
            value={tuning}
            items={[...THEME_TUNING_ITEMS]}
            onValueChange={(value: ThemeTuning | null) => value && setTuning(value)}
            renderValue={(value: ThemeTuning) => THEME_TUNING_ITEMS.find((item) => item.value === value)?.label ?? value}
          />
          <Text variant="secondary">
            {THEME_TUNING_ITEMS.find((item) => item.value === tuning)?.description}
          </Text>
          <Select
            label="歌词风格"
            value={lyricStyle}
            items={[...THEME_LYRIC_STYLE_ITEMS]}
            onValueChange={(value: ThemeLyricStyle | null) => value && setLyricStyle(value)}
            renderValue={(value: ThemeLyricStyle) => THEME_LYRIC_STYLE_ITEMS.find((item) => item.value === value)?.label ?? value}
          />
          <Text variant="secondary">
            {THEME_LYRIC_STYLE_ITEMS.find((item) => item.value === lyricStyle)?.description}
          </Text>
          <ConsoleSection title="高级创作设置">
            <Grid gap="sm">
              <InputArea
                label="音乐提示词补充（可选）"
                description="在系统依据年龄、场景和音乐风格生成的提示词之后追加；不能覆盖儿童安全和知识答案约束。"
                value={promptInstruction}
                onValueChange={setPromptInstruction}
                minRows={2}
                maxRows={5}
              />
              <Select label="歌词来源" value={lyricsMode} items={[...LYRICS_MODE_ITEMS]}
                onValueChange={(value: "spec" | "minimax-edit" | null) => value && setLyricsMode(value)}
                renderValue={(value: "spec" | "minimax-edit") => LYRICS_MODE_ITEMS.find((item) => item.value === value)?.label ?? value} />
              <InputArea
                label="歌词创作指令（可选）"
                description="仅在选择 MiniMax 润色时发送；系统会拒绝遗漏 SongSpec 句尾知识答案的结果。"
                value={lyricsInstruction}
                onValueChange={setLyricsInstruction}
                minRows={2}
                maxRows={5}
              />
              <Grid variant="3up" gap="sm">
                <GridItem><Select label="采样率" value={sampleRate} items={SAMPLE_RATE_ITEMS}
                  onValueChange={(value: string | null) => value && setSampleRate(value)} renderValue={(value: string) => `${value} Hz`} /></GridItem>
                <GridItem><Select label="比特率" value={bitrate} items={BITRATE_ITEMS}
                  onValueChange={(value: string | null) => value && setBitrate(value)} renderValue={(value: string) => `${Number(value) / 1000} kbps`} /></GridItem>
                <GridItem><Select label="音频格式" value={format} items={AUDIO_FORMAT_ITEMS}
                  onValueChange={(value: string | null) => value && setFormat(value as "mp3" | "wav" | "pcm")} renderValue={(value: string) => value.toUpperCase()} /></GridItem>
              </Grid>
            </Grid>
          </ConsoleSection>
          <Text variant="secondary">
            当前年龄目标 {THEME_AGE_DURATION_SEC[ageBand]} 秒。MiniMax 云端接口没有 duration 参数且未公布输出硬上限；系统用歌词和曲式间接控制，出音后按实际时长评分。开源 Music 3 的 300 秒 max_duration 不等于当前云端 API。
          </Text>
          <Text bold>同提示词模型</Text>
          <Grid variant="2up" gap="sm">
            {availableModels.map((model) => (
              <GridItem key={model}>
                <Checkbox
                  label={MINIMAX_MUSIC_MODEL_LABELS[model]}
                  checked={models.includes(model)}
                  disabled={models.length === 1 && models[0] === model}
                  onCheckedChange={(checked) => setModels((current) => checked
                    ? [...new Set([...current, model])]
                    : current.filter((item) => item !== model))}
                />
              </GridItem>
            ))}
          </Grid>
          <Text variant="secondary">选择多个模型时，系统固定同一份 SongSpec、歌词和提示词快照并行生成，报告可直接横向比较。</Text>
          <InputArea
            label="教材或核验资料（可选）"
            description="建议粘贴教材原文、课程标准或必须遵守的事实。"
            value={sourceNotes}
            onValueChange={setSourceNotes}
            minRows={4}
            maxRows={10}
          />
          <Checkbox
            label="每个生产阶段都需要我确认后再继续"
            checked={manualConfirmation}
            onCheckedChange={setManualConfirmation}
          />
          <Text variant="secondary">知识内容确认后只会提交规格审核；管理员仍须显式批准 SongSpec。不勾选时，批准后自动生成候选并评分。</Text>
          <Button disabled={!ai.ready || theme.trim().length < 2 || busy} onClick={submit}>
            {busy ? "正在提交…" : "开始创作"}
          </Button>
        </Grid>
      </ConsoleSection>
    </Grid>
  );
}
