"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Banner, Loader } from "@cloudflare/kumo";
import type { AnalysisReport } from "@/lib/analysis/engine";
import type { SceneKey } from "@/lib/analysis/score";
import { ReportCard, type LyricsBundle } from "@/components/report";

interface ShareBundle {
  version: number;
  scene: SceneKey;
  sharedAt: string;
  report: AnalysisReport;
  lyrics?: LyricsBundle;
  _share?: { hasAudio: boolean };
}

export default function SharePage() {
  const [state, setState] = useState<{ status: "loading" | "error" | "ok"; bundle?: ShareBundle; id?: string; error?: string }>({ status: "loading" });

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("id");
    if (!id || !/^[a-z0-9]{10}$/.test(id)) {
      setState({ status: "error", error: "分享链接无效" });
      return;
    }
    fetch(`/api/share/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "分享不存在或已删除" : `加载失败（${r.status}）`);
        return r.json();
      })
      .then((bundle: ShareBundle) => setState({ status: "ok", bundle, id }))
      .catch((e) => setState({ status: "error", error: e instanceof Error ? e.message : "加载失败" }));
  }, []);

  return (
    <main className="wrap" style={{ paddingTop: "2.4rem" }}>
      <p className="text-kumo-subtle" style={{ fontSize: "0.85rem", margin: 0 }}>
        分享的分析报告 · <Link href="/">去分析我自己的音频 →</Link>
      </p>
      {state.status === "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "2rem" }}>
          <Loader /> <span className="text-kumo-subtle">加载分享内容…</span>
        </div>
      )}
      {state.status === "error" && (
        <div style={{ marginTop: "1.5rem" }}>
          <Banner variant="error" title={state.error ?? "加载失败"} />
        </div>
      )}
      {state.status === "ok" && state.bundle && (
        <>
          <ReportCard
            report={state.bundle.report}
            scene={state.bundle.scene}
            lyrics={state.bundle.lyrics ?? null}
            audioUrl={state.bundle._share?.hasAudio ? `/api/share/${state.id}/audio` : undefined}
            readonly
          />
          <p className="text-kumo-subtle" style={{ fontSize: "0.78rem", marginTop: "0.8rem" }}>
            分享于 {state.bundle.sharedAt?.slice(0, 10)} · 分数按分享时的场景（{state.bundle.scene}）计算
          </p>
        </>
      )}
    </main>
  );
}
