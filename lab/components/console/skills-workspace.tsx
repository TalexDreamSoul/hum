"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Grid, GridItem, Input, InputArea, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { THEME_AGE_BAND_ITEMS, THEME_SCENE_ITEMS } from "@/lib/theme-song";

interface SkillRow {
  id: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  revisionId: string | null;
  revision: number | null;
  contentHash: string | null;
  bodyMarkdown: string | null;
  bindingCount: number;
  updatedAt: number;
}

const PURPOSE_ITEMS = [
  { value: "generation", label: "生成" },
  { value: "evaluation", label: "评测" },
  { value: "both", label: "生成与评测" },
] as const;

const DEFAULT_SKILL = `---
name: catchy-children-song
description: 强化儿童歌曲朗朗上口、自然人声和低电音感
---

- 副歌使用四句以内的级进短钩子，至少重复两次。
- 主唱自然靠前，优先木吉他、钢琴、拍手和轻现场鼓。
- 避免 EDM drop、synth lead、sidechain pumping、sub-bass 和机器人声线。
- 知识答案必须落在句尾，答案前保留清楚呼吸与接唱停顿。`;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export function SkillsWorkspace() {
  const toast = useConsoleToast();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [markdown, setMarkdown] = useState(DEFAULT_SKILL);
  const [purpose, setPurpose] = useState<(typeof PURPOSE_ITEMS)[number]["value"]>("both");
  const [domain, setDomain] = useState("");
  const [ageBand, setAgeBand] = useState("");
  const [scene, setScene] = useState("");
  const [priority, setPriority] = useState("0");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const payload = await requestJson<{ skills: SkillRow[] }>("/api/admin/skills");
    setSkills(payload.skills);
  }, []);

  useEffect(() => { load().catch((error) => toast.error("读取 Skills 失败", error.message)); }, [load]);

  async function save() {
    setBusy("save");
    try {
      await requestJson("/api/admin/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          markdown,
          binding: { purpose, domain, ageBand, scene, priority: Number(priority) || 0 },
        }),
      });
      await load();
      toast.success("Skill 已发布为不可变新版本");
    } catch (error) {
      toast.error("保存 Skill 失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function toggle(skill: SkillRow) {
    setBusy(skill.id);
    try {
      await requestJson(`/api/admin/skills/${skill.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: skill.status === "active" ? "disabled" : "active" }),
      });
      await load();
    } catch (error) {
      toast.error("更新 Skill 失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  return (
    <Grid gap="base">
      <ConsoleSection title="导入或发布新版本">
        <Grid gap="sm">
          <InputArea
            label="SKILL.md"
            description="兼容 YAML name/description + Markdown 正文；仅作为文本上下文，不执行脚本。相同 name 再次保存会创建新 revision。"
            value={markdown}
            onValueChange={setMarkdown}
            minRows={12}
            maxRows={24}
          />
          <Grid variant="2up" gap="sm">
            <GridItem><Select label="用途" value={purpose} items={[...PURPOSE_ITEMS]} onValueChange={(value) => value && setPurpose(value)} /></GridItem>
            <GridItem><Input label="领域（可空）" value={domain} onValueChange={setDomain} /></GridItem>
            <GridItem><Select label="年龄段" value={ageBand} items={[{ value: "", label: "全部年龄" }, ...THEME_AGE_BAND_ITEMS]} onValueChange={(value) => setAgeBand(value ?? "")} /></GridItem>
            <GridItem><Select label="场景" value={scene} items={[{ value: "", label: "全部场景" }, ...THEME_SCENE_ITEMS]} onValueChange={(value) => setScene(value ?? "")} /></GridItem>
            <GridItem><Input label="优先级" description="-100 到 100，越大越靠前。" value={priority} onValueChange={setPriority} /></GridItem>
          </Grid>
          <Button disabled={busy === "save" || !markdown.trim()} onClick={save}>{busy === "save" ? "正在保存…" : "发布 Skill"}</Button>
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="Skills" status={<Badge variant="neutral">{skills.length} 个</Badge>}>
        <Table>
          <thead><tr><th>名称</th><th>版本</th><th>状态</th><th>绑定</th><th>内容哈希</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>
            {skills.map((skill) => (
              <tr key={skill.id}>
                <td><Text bold>{skill.name}</Text><Text variant="secondary">{skill.description}</Text></td>
                <td>v{skill.revision ?? "—"}</td>
                <td><Badge variant={skill.status === "active" ? "success" : "neutral"}>{skill.status === "active" ? "启用" : "停用"}</Badge></td>
                <td>{skill.bindingCount}</td>
                <td><Text variant="mono-secondary">{skill.contentHash?.slice(0, 24) ?? "—"}</Text></td>
                <td>{new Date(skill.updatedAt).toLocaleString("zh-CN")}</td>
                <td><Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => toggle(skill)}>{skill.status === "active" ? "停用" : "启用"}</Button></td>
              </tr>
            ))}
            {!skills.length && <tr><td colSpan={7}><Text variant="secondary">还没有 Skill。发布后会按用途、领域、年龄和场景自动装配，并把 revision 写进运行快照。</Text></td></tr>}
          </tbody>
        </Table>
      </ConsoleSection>
    </Grid>
  );
}
