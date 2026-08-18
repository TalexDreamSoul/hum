"use client";

import { useState } from "react";
import { Banner, Button, Checkbox, Grid, GridItem, Input, InputArea, Select, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { MINIMAX_BATCH_MODELS, MINIMAX_MUSIC_MODEL_LABELS, type MiniMaxBatchModel } from "@/lib/minimax";
import {
  THEME_AGE_BAND_ITEMS,
  THEME_SCENE_ITEMS,
  THEME_TUNING_ITEMS,
  type ThemeAgeBand,
  type ThemeScene,
  type ThemeTuning,
} from "@/lib/theme-song";

interface ThemeSongWizardProps {
  ai: { ready: boolean; model: string };
  minimaxReady: boolean;
  defaultModel: MiniMaxBatchModel;
  onSubmitted: (manualConfirmation: boolean) => void;
}

async function requestJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

export function ThemeSongWizard({ ai, minimaxReady, defaultModel, onSubmitted }: ThemeSongWizardProps) {
  const toast = useConsoleToast();
  const [theme, setTheme] = useState("");
  const [ageBand, setAgeBand] = useState<ThemeAgeBand>("5-6");
  const [scene, setScene] = useState<ThemeScene>("commute");
  const [tuning, setTuning] = useState<ThemeTuning>("general");
  const [models, setModels] = useState<MiniMaxBatchModel[]>([defaultModel]);
  const [sourceNotes, setSourceNotes] = useState("");
  const [manualConfirmation, setManualConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await requestJson<{ job: { id: string } }>("/api/admin/production-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme, ageBand, scene, tuning, models, sourceNotes, manualConfirmation }),
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
            label="调优"
            value={tuning}
            items={[...THEME_TUNING_ITEMS]}
            onValueChange={(value: ThemeTuning | null) => value && setTuning(value)}
            renderValue={(value: ThemeTuning) => THEME_TUNING_ITEMS.find((item) => item.value === value)?.label ?? value}
          />
          <Text variant="secondary">
            {THEME_TUNING_ITEMS.find((item) => item.value === tuning)?.description}
          </Text>
          <Text bold>同提示词模型</Text>
          <Grid variant="2up" gap="sm">
            {MINIMAX_BATCH_MODELS.map((model) => (
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
          <Text variant="secondary">知识内容始终需要确认一次；不勾选时，确认知识后会自动批准规格、生成候选并评分。</Text>
          <Button disabled={!ai.ready || theme.trim().length < 2 || busy} onClick={submit}>
            {busy ? "正在提交…" : "开始创作"}
          </Button>
        </Grid>
      </ConsoleSection>
    </Grid>
  );
}
