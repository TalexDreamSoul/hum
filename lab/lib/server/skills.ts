import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "./api";
import { getDb } from "./database";
import { getEvaluationReport, getTestSet } from "./reports";

export type SkillPurpose = "generation" | "evaluation" | "both";

export interface SkillBindingInput {
  purpose: SkillPurpose;
  domain?: string;
  ageBand?: string;
  scene?: string;
  priority?: number;
}

interface AiContextReport {
  subjectTitle: string;
  verdict: string;
  totalScore: number | null;
  grade: string;
  model: string;
  scene: string;
  evaluator: string;
  evaluatorVersion: string;
  specId: string | null;
  specRevision: number | null;
  summary: string;
  dimensions: Array<{ label: string; key: string; score: number | null; evidence: { detail?: string } }>;
  knowledge: null | { objective: string; contentHash: string; points: Array<{ lead: string; answer: string }> };
  promptSnapshot: null | { id: string; builderVersion: string; tuning: string; prompt: string; lyrics: string };
}

interface AiContextSkillRef { name: string; revision: number; contentHash: string }
interface AiContextTestSet {
  name?: string;
  description?: string;
  reports?: Array<{ subjectTitle?: string; totalScore?: number | null; grade?: string; verdict?: string; model?: string }>;
}

type AiContextData =
  | { type: "report"; report: AiContextReport; skills: AiContextSkillRef[] }
  | { type: "test_set"; testSet: AiContextTestSet };

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseFrontmatter(markdown: string): { name: string; description: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new ApiError(400, "Skill 必须以包含 name 和 description 的 YAML frontmatter 开头");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
    fields[key] = value;
  }
  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!name || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(name)) throw new ApiError(400, "Skill name 必须是 2–80 位 kebab-case");
  if (!description || description.length > 300) throw new ApiError(400, "Skill description 必须是 1–300 个字符");
  const body = match[2].trim();
  if (!body || body.length > 20_000) throw new ApiError(400, "Skill 正文必须是 1–20000 个字符");
  return { name, description, body };
}

export async function listSkills() {
  return getDb().prepare(`
    SELECT s.id, s.name, s.description, s.status, s.created_at AS createdAt, s.updated_at AS updatedAt,
           r.id AS revisionId, r.revision, r.content_hash AS contentHash, r.body_markdown AS bodyMarkdown,
           COALESCE((SELECT COUNT(*) FROM skill_bindings b WHERE b.skill_revision_id = r.id AND b.active = 1), 0) AS bindingCount
    FROM skills s
    LEFT JOIN LATERAL (
      SELECT * FROM skill_revisions latest WHERE latest.skill_id = s.id ORDER BY latest.revision DESC LIMIT 1
    ) r ON true
    ORDER BY s.updated_at DESC, s.name
  `).all();
}

export async function importSkill(markdown: string, binding: SkillBindingInput, userId: string) {
  const parsed = parseFrontmatter(markdown);
  const database = getDb();
  const now = Date.now();
  const contentHash = hash(`${parsed.name}\n${parsed.description}\n${parsed.body}`);
  let skillId = "";
  let revisionId = "";
  let revision = 1;
  await database.transaction(async (transaction) => {
    const existing = await transaction.prepare("SELECT id FROM skills WHERE name = ?").get(parsed.name) as { id: string } | undefined;
    skillId = existing?.id ?? randomUUID();
    if (!existing) {
      await transaction.prepare(`
        INSERT INTO skills (id, name, description, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(skillId, parsed.name, parsed.description, userId, now, now);
    } else {
      await transaction.prepare("UPDATE skills SET description = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(parsed.description, now, skillId);
    }
    const previous = await transaction.prepare(`
      SELECT id, revision, content_hash FROM skill_revisions WHERE skill_id = ? ORDER BY revision DESC LIMIT 1
    `).get(skillId) as { id: string; revision: number; content_hash: string } | undefined;
    if (previous?.content_hash === contentHash) {
      revisionId = previous.id;
      revision = previous.revision;
    } else {
      revision = (previous?.revision ?? 0) + 1;
      revisionId = randomUUID();
      await transaction.prepare(`
        INSERT INTO skill_revisions (id, skill_id, revision, body_markdown, references_json, content_hash, created_by, created_at)
        VALUES (?, ?, ?, ?, '[]', ?, ?, ?)
      `).run(revisionId, skillId, revision, parsed.body, contentHash, userId, now);
    }
    await transaction.prepare(`
      UPDATE skill_bindings SET active = 0
      WHERE skill_revision_id IN (SELECT id FROM skill_revisions WHERE skill_id = ?)
    `).run(skillId);
    await transaction.prepare(`
      INSERT INTO skill_bindings (
        id, skill_revision_id, purpose, domain, age_band, scene, priority, active, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      randomUUID(),
      revisionId,
      binding.purpose,
      binding.domain?.trim().slice(0, 160) ?? "",
      binding.ageBand?.trim().slice(0, 80) ?? "",
      binding.scene?.trim().slice(0, 80) ?? "",
      Math.min(Math.max(binding.priority ?? 0, -100), 100),
      userId,
      now,
    );
  })();
  return { skillId, revisionId, revision, contentHash };
}

export async function setSkillStatus(id: string, status: "active" | "disabled"): Promise<void> {
  const result = await getDb().prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  if (!result.changes) throw new ApiError(404, "Skill 不存在");
}

export async function resolveSkills(input: {
  purpose: Exclude<SkillPurpose, "both">;
  domain?: string;
  ageBand?: string;
  scene?: string;
}) {
  const rows = await getDb().prepare(`
    SELECT s.id AS skillId, s.name, s.description, r.id AS revisionId, r.revision,
           r.body_markdown AS bodyMarkdown, r.content_hash AS contentHash, b.priority
    FROM skill_bindings b
    JOIN skill_revisions r ON r.id = b.skill_revision_id
    JOIN skills s ON s.id = r.skill_id
    WHERE b.active = 1 AND s.status = 'active'
      AND b.purpose IN (?, 'both')
      AND (b.domain = '' OR b.domain = ?)
      AND (b.age_band = '' OR b.age_band = ?)
      AND (b.scene = '' OR b.scene = ?)
    ORDER BY b.priority DESC, s.name
    LIMIT 12
  `).all(input.purpose, input.domain ?? "", input.ageBand ?? "", input.scene ?? "") as Array<{
    skillId: string;
    name: string;
    description: string;
    revisionId: string;
    revision: number;
    bodyMarkdown: string;
    contentHash: string;
    priority: number;
  }>;
  const rendered = rows.map((row) => [
    `<skill name="${row.name}" revision="${row.revision}">`,
    row.bodyMarkdown,
    "</skill>",
  ].join("\n")).join("\n\n").slice(0, 6000);
  return {
    skills: rows,
    rendered,
    bundleHash: rows.length ? hash(rows.map((row) => `${row.revisionId}:${row.contentHash}`).join("\n")) : "",
  };
}

async function contextData(subjectType: "report" | "test_set", subjectId: string): Promise<AiContextData> {
  if (subjectType === "report") {
    const report = await getEvaluationReport(subjectId);
    const skillRows = report.promptSnapshot?.id
      ? await getDb().prepare(`
          SELECT s.name, r.revision, r.content_hash AS contentHash
          FROM run_skill_snapshots rs
          JOIN skill_revisions r ON r.id = rs.skill_revision_id
          JOIN skills s ON s.id = r.skill_id
          WHERE rs.prompt_snapshot_id = ? ORDER BY s.name
        `).all(report.promptSnapshot.id) as AiContextSkillRef[]
      : [];
    return { type: "report" as const, report, skills: skillRows };
  }
  return { type: "test_set" as const, testSet: await getTestSet(subjectId) };
}

function contextMarkdown(data: AiContextData): string {
  if (data.type === "test_set") {
    const testSet = data.testSet;
    return [
      `# hum 测试集：${testSet.name ?? "未命名"}`,
      testSet.description ?? "",
      "## 报告",
      ...(testSet.reports ?? []).map((report) => `- ${report.subjectTitle ?? "对象"}｜${report.model || "上传音频"}｜${report.totalScore ?? "—"}/${report.grade || "—"}｜${report.verdict ?? "—"}`),
    ].join("\n");
  }
  const report = data.report;
  return [
    `# hum 评分报告：${report.subjectTitle}`,
    `- 结论：${report.verdict}`,
    `- 总分：${report.totalScore ?? "—"} / ${report.grade || "—"}`,
    `- 模型：${report.model || "上传音频"}`,
    `- 场景：${report.scene || "—"}`,
    `- 评测器：${report.evaluator}/${report.evaluatorVersion}`,
    `- SongSpec：${report.specId ?? "—"} v${report.specRevision ?? "—"}`,
    "## 结论摘要",
    report.summary,
    "## 维度",
    ...report.dimensions.map((item) => `- ${item.label} (${item.key})：${item.score ?? "—"}｜${item.evidence.detail || ""}`),
    ...(report.knowledge ? [
      "## 知识快照",
      `目标：${report.knowledge.objective}`,
      ...report.knowledge.points.map((point) => `- ${point.lead}【${point.answer}】`),
      `内容哈希：${report.knowledge.contentHash}`,
    ] : []),
    ...(report.promptSnapshot ? [
      "## 提示词快照",
      `构建器：${report.promptSnapshot.builderVersion}`,
      `调优：${report.promptSnapshot.tuning}`,
      report.promptSnapshot.prompt,
      "## 歌词",
      report.promptSnapshot.lyrics,
    ] : []),
    ...(data.skills.length ? ["## Skills", ...data.skills.map((skill) => `- ${skill.name} v${skill.revision} (${skill.contentHash})`)] : []),
  ].join("\n");
}

export async function createAiContextLink(
  subjectType: "report" | "test_set",
  subjectId: string,
  userId: string,
  format: "markdown" | "json" = "markdown",
) {
  const data = await contextData(subjectType, subjectId);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const now = Date.now();
  await getDb().prepare(`
    INSERT INTO ai_context_links (token_hash, subject_type, subject_id, format, created_by, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(tokenHash, subjectType, subjectId, format, userId, now, now + 15 * 60 * 1000);
  return {
    token,
    expiresAt: now + 15 * 60 * 1000,
    markdown: contextMarkdown(data),
  };
}

export async function resolveAiContextLink(token: string) {
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const link = await getDb().prepare(`
    SELECT subject_type, subject_id, format FROM ai_context_links
    WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL
  `).get(tokenHash, Date.now()) as { subject_type: "report" | "test_set"; subject_id: string; format: "markdown" | "json" } | undefined;
  if (!link) throw new ApiError(404, "AI 上下文链接不存在、已过期或已撤销");
  const data = await contextData(link.subject_type, link.subject_id);
  return link.format === "json" ? { format: "json" as const, value: data } : { format: "markdown" as const, value: contextMarkdown(data) };
}

export async function revokeAiContextLink(token: string, userId: string): Promise<void> {
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const result = await getDb().prepare("UPDATE ai_context_links SET revoked_at = ? WHERE token_hash = ? AND created_by = ?")
    .run(Date.now(), tokenHash, userId);
  if (!result.changes) throw new ApiError(404, "AI 上下文链接不存在或无权撤销");
}
