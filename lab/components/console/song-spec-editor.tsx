"use client";

import { useState } from "react";
import { Banner, Button, Grid, Input, InputArea, Text } from "@cloudflare/kumo";
import type { SongSpecContent } from "@/lib/song-spec";
import type { StoredSongSpec } from "@/lib/server/song-specs";

const NEW_SPEC_CONTENT: SongSpecContent = {
  schemaVersion: 1,
  title: "",
  language: "zh-CN",
  domain: "",
  audience: "3–8 岁儿童",
  scene: "commute",
  hook: "",
  notes: "",
  source: {
    type: "internal",
    title: "",
    version: "v1",
    license: "internal",
    excerpt: "",
    sourceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  },
  learning: {
    objective: "",
    retrievalMode: "sentence-final-answer",
    prerequisites: [],
    contentRisk: "low",
  },
  music: {
    tuning: { id: "general", version: 1 },
    durationSec: 90,
    bpm: 112,
    key: "C major",
    lowestNote: "C4",
    highestNote: "C5",
    voice: "warm clear female vocal, child-friendly diction",
    positiveStyle: ["children song", "gentle pop", "clear mandarin"],
    negativeStyle: ["rap", "vocal runs", "dense percussion"],
  },
  sections: [
    { id: "verse-1", type: "verse", targetSec: 30 },
    { id: "chorus-1", type: "chorus", targetSec: 30 },
  ],
  points: [
    {
      id: "point-1",
      lead: "",
      answer: "",
      answerPosition: "line_end",
      minAnswerWindowMs: 1200,
      maxAnswerWindowMs: 2400,
      cue: "",
    },
  ],
  generation: {
    requiredOutputs: ["mixed"],
    seedPolicy: "record-required",
    providerPolicy: "batch-compare",
  },
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function SongSpecEditor({
  source,
  onSaved,
  onCancel,
}: {
  source?: StoredSongSpec;
  onSaved: (songSpec: StoredSongSpec) => void;
  onCancel: () => void;
}) {
  const [specKey, setSpecKey] = useState(source?.specKey ?? "");
  const [contentJson, setContentJson] = useState(JSON.stringify(source?.content ?? NEW_SPEC_CONTENT, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const content = JSON.parse(contentJson) as SongSpecContent;
      if (!content.source || typeof content.source.excerpt !== "string" || !content.source.excerpt.trim()) {
        throw new Error("来源摘录不能为空");
      }
      content.source.sourceHash = await sha256(content.source.excerpt);
      const response = await fetch("/api/admin/song-specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specKey, parentId: source?.id, content }),
      });
      const payload = await response.json() as { songSpec?: StoredSongSpec; error?: string };
      if (!response.ok || !payload.songSpec) throw new Error(payload.error || "保存 SongSpec 失败");
      onSaved(payload.songSpec);
    } catch (caught) {
      setError(caught instanceof SyntaxError
        ? "规格 JSON 格式错误，请检查逗号、引号和括号"
        : caught instanceof Error ? caught.message : "保存 SongSpec 失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Grid gap="sm">
        {error && <Banner variant="error" title={error} />}
        <Input
          label="规格标识"
          description="仅小写字母、数字和连字符；创建修订时沿用原标识。"
          value={specKey}
          disabled={Boolean(source)}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSpecKey(event.target.value)}
        />
        {source && (
          <Text variant="secondary">基于 {source.specKey} v{source.revision} 创建 v{source.revision + 1}；必须修改内容后再保存。</Text>
        )}
        <InputArea
          label="SongSpec v1 JSON"
          description="保存时会按来源摘录自动重算 sourceHash；结构、字段范围和同标识修订链由服务端校验。"
          value={contentJson}
          onValueChange={setContentJson}
          minRows={20}
          maxRows={32}
        />
        <Grid variant="2up" gap="sm">
          <Button type="submit" disabled={busy || !specKey.trim()}>{busy ? "正在校验并保存…" : source ? "创建新修订" : "创建 SongSpec"}</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>取消</Button>
        </Grid>
      </Grid>
    </form>
  );
}
