"use client";

/**
 * 候选试听器：播放器 + 跟随播放进度滚动的歌词卡。
 *
 * MiniMax 不返回逐行时间戳，所以按字数在总时长里加权分配每行的时间——
 * 这是估算，卡片里会写明；等以后接了词级对齐再换成真实时间轴。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Grid, GridItem, LinkButton, Text } from "@cloudflare/kumo";
import { ConsoleSection } from "@/components/console/console-ui";
import { buildLyricsTimeline, type LyricLineTiming } from "@/lib/analysis/lyrics-timeline";

const SECTION_TAG = /^\[(.+)\]$/;

/** 歌词卡贴在抽屉顶部跟着滚，内部自己滚动，用 Kumo 自带工具类。 */
const STICKY_PANEL = "sticky top-0 max-h-[60vh] overflow-y-auto";

/** 段落标记（[Chorus] 之类）不参与计时，但要显示在对应行前面。 */
function sectionOf(lyrics: string): string[] {
  const sections: string[] = [];
  let current = "";
  for (const raw of lyrics.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tag = line.match(SECTION_TAG);
    if (tag) {
      current = tag[1];
      continue;
    }
    sections.push(current);
  }
  return sections;
}

export function CandidatePlayer({
  audioUrl,
  lyrics,
  prompt,
  briefZh,
  timeline,
  lrcUrl,
}: {
  audioUrl: string | null;
  lyrics: string;
  prompt?: string;
  /** 中文编曲设想，给运营看；英文版已经拼进 prompt */
  briefZh?: string;
  /** 质检时用留白检测反推的时间轴；没有就按字数估算。 */
  timeline?: LyricLineTiming[];
  lrcUrl?: string;
}) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => sectionOf(lyrics), [lyrics]);
  const aligned = Boolean(timeline?.length && timeline.some((line) => line.aligned));
  const lines = useMemo(() => {
    const base = timeline?.length ? timeline : buildLyricsTimeline(lyrics, duration, []);
    return base.map((line, index) => ({ ...line, section: sections[index] ?? "" }));
  }, [timeline, lyrics, duration, sections]);
  const activeIndex = lines.findIndex((line) => time >= line.start && time < line.end);

  // 当前行滚进可视区，卡片跟着播放走
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  function seek(line: { start: number }) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = line.start;
    void audio.play().catch(() => { /* 未交互前 play 会被拦，忽略 */ });
  }

  return (
    <Grid variant="1-2" gap="base">
      <GridItem>
        <Grid gap="sm" className={STICKY_PANEL}>
          <ConsoleSection
            title="歌词"
            status={
              <>
                <Badge variant={aligned ? "success" : "neutral"}>{aligned ? "留白对齐" : "按字数估算"}</Badge>
                <Badge variant={activeIndex >= 0 ? "info" : "neutral"}>
                  {activeIndex >= 0 ? `第 ${activeIndex + 1} / ${lines.length} 行` : `${lines.length} 行`}
                </Badge>
              </>
            }
          >
            <Grid gap="sm">
              {lines.map((line, index) => (
                <div key={`${line.text}-${index}`} ref={index === activeIndex ? activeRef : undefined}>
                  <Grid gap="sm">
                    {line.section && (index === 0 || lines[index - 1].section !== line.section) && (
                      <Text variant="secondary" size="xs">{line.section}</Text>
                    )}
                    <Text
                      variant={index === activeIndex ? "body" : "secondary"}
                      bold={index === activeIndex}
                      size="sm"
                      onClick={() => seek(line)}
                    >
                      {line.text}
                    </Text>
                  </Grid>
                </div>
              ))}
              {!lines.length && <Text variant="secondary">这份规格没有歌词。</Text>}
            </Grid>
          </ConsoleSection>
          <Grid gap="sm">
            <Text variant="secondary" size="xs">
              {aligned
                ? "行时间由留白检测反推（取最长的句间停顿做分界），不是词级强制对齐；点某一行可以跳到对应位置。"
                : "还没有质检时间轴，行时间按字数在总时长里估算；点某一行可以跳到对应位置。"}
            </Text>
            {lrcUrl && <LinkButton size="sm" variant="secondary" href={lrcUrl}>下载 .lrc</LinkButton>}
          </Grid>
        </Grid>
      </GridItem>

      <GridItem>
        <Grid gap="sm">
          {audioUrl ? (
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={audioUrl}
              onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            />
          ) : (
            <Text variant="secondary">没有可试听的音频：这个候选没有生成成功。</Text>
          )}
          {briefZh && (
            <ConsoleSection title="编曲设想（中文）">
              <Text variant="secondary">{briefZh}</Text>
            </ConsoleSection>
          )}
          {prompt && (
            <ConsoleSection title="发给模型的提示词（英文）">
              <Text variant="mono-secondary">{prompt}</Text>
            </ConsoleSection>
          )}
        </Grid>
      </GridItem>
    </Grid>
  );
}
