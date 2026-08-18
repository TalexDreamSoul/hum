"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, buttonVariants, Dialog, Select, Table, Toast, Toasty } from "@cloudflare/kumo";
import { analyze, STAGE_LABELS, type AnalysisReport, type StageKey } from "@/lib/analysis/engine";
import { SCENES, type SceneKey } from "@/lib/analysis/score";
import { parseLrc, computeLyricsLocal } from "@/lib/lrc";
import { analyzeLyricsAI, loadAIConfig } from "@/lib/ai";
import { ReportCard, type LyricsBundle } from "@/components/report";
import { AISettingsDialog } from "@/components/ai-settings";

interface Item {
  id: string;
  name: string;
  status: "decoding" | "analyzing" | "done" | "error";
  stage?: StageKey;
  report?: AnalysisReport;
  error?: string;
  file?: File;
  audioUrl?: string;
  lyrics?: LyricsBundle | null;
  aiBusy?: boolean;
  aiError?: string | null;
  shareBusy?: boolean;
  shareUrl?: string | null;
  shareError?: string | null;
}

interface HistoryEntry {
  name: string; total: number; grade: string; scene: SceneKey; date: string; dur: number;
}

const HISTORY_KEY = "hum-lab-history-v1";
const stem = (name: string) => name.replace(/\.[^.]+$/, "").trim().toLowerCase();

export default function Page() {
  return (
    <Toasty>
      <Inner />
    </Toasty>
  );
}

function Inner() {
  const toasts = Toast.useToastManager();
  const [scene, setScene] = useState<SceneKey>("general");
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [videoPending, setVideoPending] = useState<File[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasAI, setHasAI] = useState(false);
  const busy = useRef(false);
  const queue = useRef<File[]>([]);
  const pendingLrc = useRef(new Map<string, string>());
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch { /* 忽略 */ }
    setHasAI(!!loadAIConfig());
  }, []);

  const saveHistory = (entry: HistoryEntry) => {
    setHistory((h) => {
      const next = [entry, ...h].slice(0, 60);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* 满则放弃 */ }
      return next;
    });
  };

  const patch = (id: string, p: Partial<Item>) =>
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const attachLyricsToItem = useCallback((item: Item, raw: string): Partial<Item> => {
    const lines = parseLrc(raw);
    if (!lines.length) return { lyrics: { raw, local: null } };
    const local = item.report
      ? computeLyricsLocal(lines, item.report.meta.durationSec, item.report.gaps.spans)
      : null;
    return { lyrics: { raw, local } };
  }, []);

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      const file = queue.current.shift()!;
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      const audioUrl = URL.createObjectURL(file);
      setItems((xs) => [...xs, { id, name: file.name, status: "decoding", file, audioUrl }]);
      try {
        const buf = await file.arrayBuffer();
        ctxRef.current ??= new AudioContext();
        const audio = await ctxRef.current.decodeAudioData(buf.slice(0));
        const channels: Float32Array[] = [];
        for (let c = 0; c < Math.min(audio.numberOfChannels, 2); c++) {
          channels.push(audio.getChannelData(c).slice(0));
        }
        patch(id, { status: "analyzing" });
        const report = await analyze(file.name, channels, audio.sampleRate, scene, (stage) => patch(id, { stage }));
        const raw = pendingLrc.current.get(stem(file.name));
        let lyrics: LyricsBundle | null = null;
        if (raw) {
          pendingLrc.current.delete(stem(file.name));
          const lines = parseLrc(raw);
          lyrics = { raw, local: lines.length ? computeLyricsLocal(lines, report.meta.durationSec, report.gaps.spans) : null };
        }
        patch(id, { status: "done", report, lyrics });
        saveHistory({
          name: file.name, total: report.score.total, grade: report.score.grade,
          scene: report.score.scene, date: new Date().toISOString().slice(0, 10),
          dur: report.meta.durationSec,
        });
      } catch {
        patch(id, { status: "error", error: "解码失败：编码格式可能不受浏览器支持" });
      }
    }
    busy.current = false;
  }, [scene]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const videos: File[] = [];
    for (const f of Array.from(files)) {
      const isLrc = /\.lrc$/i.test(f.name);
      if (isLrc) {
        void f.text().then((raw) => {
          setItems((xs) => {
            const target = xs.find((x) => stem(x.name) === stem(f.name))
              ?? xs.filter((x) => x.status === "done" && !x.lyrics).at(-1);
            if (!target) {
              pendingLrc.current.set(stem(f.name), raw);
              toasts.add({ title: "歌词已暂存", description: `等待同名音频：${f.name}` });
              return xs;
            }
            const p = attachLyricsToItem(target, raw);
            toasts.add({ title: "歌词已关联", description: `${f.name} → ${target.name}` });
            return xs.map((x) => (x.id === target.id ? { ...x, ...p } : x));
          });
        });
        continue;
      }
      if (f.type.startsWith("video/")) { videos.push(f); continue; }
      queue.current.push(f);
    }
    if (videos.length) setVideoPending((v) => [...v, ...videos]);
    void pump();
  }, [pump, attachLyricsToItem, toasts]);

  const confirmVideos = () => {
    for (const f of videoPending) queue.current.push(f);
    setVideoPending([]);
    void pump();
  };

  const runAI = async (id: string) => {
    const cfg = loadAIConfig();
    if (!cfg) { setSettingsOpen(true); return; }
    const item = items.find((x) => x.id === id);
    if (!item?.lyrics?.raw || !item.report) return;
    patch(id, { aiBusy: true, aiError: null });
    try {
      const ai = await analyzeLyricsAI(cfg, item.lyrics.raw, {
        durationSec: item.report.meta.durationSec,
        bpm: item.report.tempo.bpm,
        local: item.lyrics.local ?? undefined,
      });
      patch(id, { aiBusy: false, lyrics: { ...item.lyrics, ai } });
      toasts.add({ title: "AI 歌词分析完成", description: ai.summary.slice(0, 40) });
    } catch (e) {
      patch(id, { aiBusy: false, aiError: e instanceof Error ? e.message : "AI 分析失败" });
    }
  };

  const share = async (id: string) => {
    const item = items.find((x) => x.id === id);
    if (!item?.report) return;
    patch(id, { shareBusy: true, shareError: null });
    try {
      const bundle = {
        version: 1,
        scene,
        sharedAt: new Date().toISOString(),
        report: item.report,
        lyrics: item.lyrics ?? undefined,
      };
      const fd = new FormData();
      fd.append("report", JSON.stringify(bundle));
      if (item.file && item.file.size <= 20 * 1024 * 1024) fd.append("audio", item.file, item.file.name);
      const res = await fetch("/api/share", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error(data.error || `上传失败（${res.status}）`);
      const url = `${location.origin}/share?id=${data.id}`;
      patch(id, { shareBusy: false, shareUrl: url });
      try { await navigator.clipboard.writeText(url); } catch { /* 剪贴板被拒 */ }
      toasts.add({ title: "分享链接已生成并复制", description: url });
    } catch (e) {
      patch(id, { shareBusy: false, shareError: e instanceof Error ? e.message : "上传失败" });
    }
  };

  const doneItems = items.filter((x) => x.status === "done");
  const activeItems = items.filter((x) => x.status === "decoding" || x.status === "analyzing");
  const errorItems = items.filter((x) => x.status === "error");
  const sceneKeys = Object.keys(SCENES) as SceneKey[];

  return (
    <main className="wrap py-8">
      <h1 style={{ maxWidth: "34rem" }}>这首歌，适不适合给孩子反复听？</h1>
      <p className="mt-2 text-kumo-subtle" style={{ maxWidth: "37rem" }}>
        拖入音频（或视频，将自动提取音轨）+ 同名 .lrc 歌词，浏览器本地跑完 8 个声学维度
        与歌词文本分析。每个指标为什么这么定，见<Link href="/methodology">评分原理</Link>。
        音频与歌词不上传——除非你主动点「生成分享链接」。
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Select
          value={scene}
          onValueChange={(v: SceneKey | null) => { if (v) setScene(v); }}
          items={sceneKeys.map((k) => ({ value: k, label: SCENES[k].label }))}
          renderValue={(v: SceneKey) => `场景：${SCENES[v].label}`}
        />
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          AI 配置{hasAI ? "" : "（未设）"}
        </Button>
        <span className="text-xs text-kumo-subtle">切换场景即时重算所有报告</span>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
        className={`mt-4 rounded-xl border border-dashed border-kumo-line p-8 text-center ${dragOver ? "bg-kumo-elevated" : ""}`}
      >
        <p className="m-0">把 mp3 / wav / m4a / mp4 / .lrc 拖到这里（可多选，音频与歌词同名自动配对）</p>
        <p className="mt-1 mb-2 text-sm text-kumo-subtle">或者</p>
        <label className={buttonVariants({ variant: "secondary" })}>
          选择文件
          <input
            type="file" accept="audio/*,video/*,.lrc" multiple className="hidden"
            onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = ""; } }}
          />
        </label>
      </div>

      {activeItems.map((x) => (
        <p key={x.id} className="mt-4 text-sm text-kumo-subtle">
          {x.name} — {x.status === "decoding" ? "解码中…" : `分析中：${x.stage ? STAGE_LABELS[x.stage] : "…"}`}
        </p>
      ))}
      {errorItems.map((x) => (
        <p key={x.id} className="mt-4 text-sm" style={{ color: "var(--bad)" }}>
          {x.name} — {x.error}
        </p>
      ))}

      {doneItems.map((x) => x.report && (
        <ReportCard
          key={x.id}
          report={x.report}
          scene={scene}
          audioUrl={x.audioUrl}
          lyrics={x.lyrics}
          onAttachLrc={(f) => {
            void f.text().then((raw) => {
              const p = attachLyricsToItem(x, raw);
              patch(x.id, p);
            });
          }}
          onRunAI={() => void runAI(x.id)}
          aiBusy={x.aiBusy}
          aiError={x.aiError}
          hasAIConfig={hasAI}
          onOpenAISettings={() => setSettingsOpen(true)}
          onShare={() => void share(x.id)}
          shareBusy={x.shareBusy}
          shareUrl={x.shareUrl}
          shareError={x.shareError}
        />
      ))}

      {history.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2">本机历史</h2>
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <th>文件</th><th>总分</th><th>等级</th><th>场景</th><th>时长</th><th>日期</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td>{h.name.length > 32 ? h.name.slice(0, 32) + "…" : h.name}</td>
                    <td className="tabular-nums">{h.total}</td>
                    <td>{h.grade}</td>
                    <td>{SCENES[h.scene]?.label ?? h.scene}</td>
                    <td className="tabular-nums">{h.dur}s</td>
                    <td className="text-kumo-subtle">{h.date}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <div className="mt-2">
            <Button variant="ghost" size="sm"
              onClick={() => { setHistory([]); try { localStorage.removeItem(HISTORY_KEY); } catch { /* noop */ } }}>
              清空历史
            </Button>
          </div>
        </section>
      )}

      <Dialog.Root open={videoPending.length > 0} onOpenChange={(v: boolean) => { if (!v) setVideoPending([]); }}>
        <Dialog className="p-6">
          <Dialog.Title>检测到视频文件</Dialog.Title>
          <Dialog.Description>
            将自动提取音轨进行分析，视频画面不会被使用或上传。
          </Dialog.Description>
          <div className="mt-2 mb-2 flex flex-wrap gap-2">
            {videoPending.map((f, i) => <Badge key={i} variant="neutral">{f.name}</Badge>)}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setVideoPending([])}>取消</Button>
            <Button onClick={confirmVideos}>提取音轨并分析</Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <AISettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={(c) => setHasAI(!!c)} />
    </main>
  );
}
