"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, Dialog, Grid, GridItem, Input, InputArea, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

type Role = "admin" | "approver" | "uploader";
type Resource = "dashboard" | "roles" | "rubrics" | "rounds" | "benchmarks" | "gates" | "audit";
type Row = Record<string, unknown>;
type ListResponse = { items?: Row[]; page?: number; pageSize?: number; total?: number; error?: string };

type ResourceDefinition = {
  resource: Resource;
  title: string;
  description: string;
  fields: string[];
};

const RESOURCE_ITEMS: ResourceDefinition[] = [
  { resource: "rubrics", title: "量表", description: "把英语、儿歌、数学的发布标准拆成可评分维度。", fields: ["名称", "场景", "版本", "状态"] },
  { resource: "rounds", title: "复审轮次", description: "按轮次分派人工复核，不以自动预筛代替终审。", fields: ["对象", "轮次", "负责人", "结论"] },
  { resource: "benchmarks", title: "基准", description: "维护可比对的种子样本与质量基线。", fields: ["名称", "学科", "基准分", "状态"] },
  { resource: "gates", title: "发布门禁", description: "只允许通过人工终审和适用量表的对象发布。", fields: ["对象", "量表", "终审", "门禁"] },
  { resource: "audit", title: "审计", description: "七类证据视图覆盖对象、评审、发布和权限变更。", fields: ["时间", "视图", "操作者", "动作"] },
];

const ROLE_ITEMS = [
  { value: "admin", label: "A · 管理员" },
  { value: "approver", label: "B · 审批人" },
  { value: "uploader", label: "C · 上传人" },
] as const;

const SUBJECT_ITEMS = [
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "knowledge", label: "知识" },
  { value: "publication", label: "出版物" },
] as const;

const VERDICT_ITEMS = [
  { value: "pass", label: "通过" },
  { value: "fail", label: "不通过" },
  { value: "needs_inpaint", label: "需要修补" },
] as const;

const FINAL_TARGET_ITEMS = [
  { value: "candidate", label: "候选音频" },
  { value: "publicationRevision", label: "出版物修订" },
] as const;

const AUDIT_VIEW_ITEMS = [
  { value: "object", label: "对象台账" },
  { value: "assignment", label: "分派记录" },
  { value: "review", label: "复审记录" },
  { value: "rubric", label: "量表变更" },
  { value: "benchmark", label: "基准变更" },
  { value: "gate", label: "门禁决策" },
  { value: "publication", label: "发布证据" },
] as const;

const fieldValue = (row: Row, names: string[]): string => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "—";
};

function titleOf(row: Row): string {
  return fieldValue(row, ["title", "name", "label", "subject", "id"]);
}

function stateOf(row: Row): string {
  return fieldValue(row, ["status", "state", "verdict", "decision", "action"]);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function GovernanceWorkspace({ role }: { role: Role }) {
  const toast = useConsoleToast();
  const [dashboard, setDashboard] = useState<Row[]>([]);
  const [itemsByResource, setItemsByResource] = useState<Record<Resource, Row[]>>({ dashboard: [], roles: [], rubrics: [], rounds: [], benchmarks: [], gates: [], audit: [] });
  const [totals, setTotals] = useState<Record<Resource, number>>({ dashboard: 0, roles: 0, rubrics: 0, rounds: 0, benchmarks: 0, gates: 0, audit: 0 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [resource, setResource] = useState<Resource>("rounds");
  const [search, setSearch] = useState("");
  const [auditView, setAuditView] = useState<(typeof AUDIT_VIEW_ITEMS)[number]["value"]>("object");
  const [detail, setDetail] = useState<Row | null>(null);
  const [dialog, setDialog] = useState<"create" | "assign" | "submit" | "final" | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    rubricKey: string;
    subject: (typeof SUBJECT_ITEMS)[number]["value"];
    dimensionKey: string;
    dimensionLabel: string;
    dimensionWeight: string;
    threshold: string;
    targetId: string;
    assigneeId: string;
    musicReviewerId: string;
    reviewKind: "content" | "music";
    verdict: "" | (typeof VERDICT_ITEMS)[number]["value"];
    finalTargetType: (typeof FINAL_TARGET_ITEMS)[number]["value"];
    notes: string;
    score: string;
  }>({
    title: "",
    rubricKey: "",
    subject: "audio",
    dimensionKey: "overall_quality",
    dimensionLabel: "整体质量",
    dimensionWeight: "100",
    threshold: "80",
    targetId: "",
    assigneeId: "",
    musicReviewerId: "",
    reviewKind: "content",
    verdict: "",
    finalTargetType: "candidate",
    notes: "",
    score: "",
  });

  const isAdmin = role === "admin";
  const canApprove = role === "admin" || role === "approver";
  const dimensionWeight = Number(form.dimensionWeight);
  const rubricThreshold = Number(form.threshold);
  const rubricFormValid = /^[a-z][a-z0-9_-]*$/.test(form.rubricKey.trim())
    && /^[a-z][a-z0-9_]*$/.test(form.dimensionKey.trim())
    && Boolean(form.title.trim() && form.dimensionLabel.trim())
    && Number.isInteger(dimensionWeight)
    && dimensionWeight === 100
    && Number.isInteger(rubricThreshold)
    && rubricThreshold >= 0
    && rubricThreshold <= 100;
  const reviewScore = Number(form.score);
  const reviewFormValid = Boolean(form.targetId.trim() && form.verdict && form.score.trim())
    && Number.isFinite(reviewScore)
    && reviewScore >= 0
    && reviewScore <= 100;
  const activeDefinition = RESOURCE_ITEMS.find((item) => item.resource === resource);
  const currentItems = resource === "dashboard" ? dashboard : itemsByResource[resource];

  async function load(resourceName: Resource, nextPage = page) {
    const params = new URLSearchParams({ resource: resourceName, page: String(nextPage), pageSize: String(pageSize) });
    if (search.trim() && resourceName !== "dashboard") params.set("search", search.trim());
    if (resourceName === "audit") params.set("view", auditView);
    const response = await fetch(`/api/admin/governance?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json() as ListResponse;
    if (!response.ok) throw new Error(payload.error || "读取治理数据失败");
    const nextItems = payload.items ?? [];
    if (resourceName === "dashboard") setDashboard(nextItems);
    setItemsByResource((current) => ({ ...current, [resourceName]: nextItems }));
    setTotals((current) => ({ ...current, [resourceName]: payload.total ?? nextItems.length }));
    setPage(payload.page ?? nextPage);
    setPageSize(payload.pageSize ?? pageSize);
  }

  async function reloadAll() {
    try {
      await Promise.all((["dashboard", "roles", "rubrics", "rounds", "benchmarks", "gates", "audit"] as Resource[]).map((name) => load(name, name === resource ? page : 1)));
    } catch (error) {
      toast.error("读取治理工作台失败", error instanceof Error ? error.message : "未知错误");
    }
  }

  useEffect(() => {
    load(resource).catch((error) => toast.error("读取治理数据失败", error instanceof Error ? error.message : "未知错误"));
  }, [resource, page, pageSize, search, auditView]);

  useEffect(() => {
    load("dashboard", 1).catch((error) => toast.error("读取治理概览失败", error instanceof Error ? error.message : "未知错误"));
    load("roles", 1).catch((error) => toast.error("读取权限矩阵失败", error instanceof Error ? error.message : "未知错误"));
  }, []);

  async function submitAction(targetResource: Exclude<Resource, "dashboard">, action: string, payload: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/governance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: targetResource, action, payload }),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "治理动作未完成");
      toast.success("治理动作已记录");
      setDialog(null);
      setForm({
        title: "",
        rubricKey: "",
        subject: "audio",
        dimensionKey: "overall_quality",
        dimensionLabel: "整体质量",
        dimensionWeight: "100",
        threshold: "80",
        targetId: "",
        assigneeId: "",
        musicReviewerId: "",
        reviewKind: "content",
        verdict: "",
        finalTargetType: "candidate",
        notes: "",
        score: "",
      });
      await reloadAll();
    } catch (error) {
      toast.error("治理动作失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setBusy(false);
    }
  }

  const seedCoverage = useMemo(() => {
    const labels = ["英语", "儿歌", "数学"];
    return labels.map((label, index) => ({ label, value: fieldValue(dashboard[index] ?? {}, ["coverage", "count", "value", "total"]) }));
  }, [dashboard]);

  return (
    <Grid gap="base">
      <Banner variant="default" title="治理工作台" description="自动项仅能预筛；创建、分派、提交复审和终审发布均留下可追溯审计证据。" />

      <ConsoleSection title="十项治理能力" status={<Badge variant="info">A / B / C 最小权限</Badge>}>
        <Grid variant="3up" gap="sm">
          <GridItem><Text bold>1. Dashboard</Text><Text variant="secondary">待审、风险、门禁与覆盖总览。</Text></GridItem>
          <GridItem><Text bold>2. 角色矩阵</Text><Text variant="secondary">A 管理，B 复审，C 上传。</Text></GridItem>
          <GridItem><Text bold>3. 复审轮次</Text><Text variant="secondary">可分派、可提交、可回溯。</Text></GridItem>
          <GridItem><Text bold>4. 量表</Text><Text variant="secondary">版本化评分维度和阈值。</Text></GridItem>
          <GridItem><Text bold>5. 基准</Text><Text variant="secondary">种子样本质量比较基线。</Text></GridItem>
          <GridItem><Text bold>6. 发布门禁</Text><Text variant="secondary">人工终审前禁止发布。</Text></GridItem>
          <GridItem><Text bold>7. 审计七视图</Text><Text variant="secondary">对象至发布的完整证据链。</Text></GridItem>
          <GridItem><Text bold>8. 筛选分页</Text><Text variant="secondary">统一资源列表与检索。</Text></GridItem>
          <GridItem><Text bold>9. 详情抽屉</Text><Text variant="secondary">查看原始治理记录。</Text></GridItem>
          <GridItem><Text bold>10. 受控动作</Text><Text variant="secondary">创建、分派、复审、终审。</Text></GridItem>
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="种子覆盖" status={<Badge variant="success">英语 / 儿歌 / 数学</Badge>}>
        <Grid variant="3up" gap="sm">
          {seedCoverage.map((item) => <GridItem key={item.label}><Text bold>{item.label}</Text><Text variant="secondary">{item.value} 个可治理种子</Text></GridItem>)}
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="Dashboard" status={<Badge variant="neutral">实时快照</Badge>}>
        <Table>
          <thead><tr><th>指标</th><th>当前值</th><th>状态</th><th>说明</th></tr></thead>
          <tbody>
            {dashboard.map((item, index) => <tr key={fieldValue(item, ["id", "key", "label"]) || String(index)}><td>{titleOf(item)}</td><td>{fieldValue(item, ["value", "count", "total", "coverage"])}</td><td><Badge variant={stateOf(item) === "pass" || stateOf(item) === "ready" ? "success" : "neutral"}>{stateOf(item)}</Badge></td><td>{fieldValue(item, ["description", "detail", "notes"])}</td></tr>)}
            {!dashboard.length && <tr><td colSpan={4}><Text variant="secondary">暂无 dashboard 数据。</Text></td></tr>}
          </tbody>
        </Table>
      </ConsoleSection>

      <ConsoleSection title="A / B / C 权限矩阵" status={<Badge variant="neutral">只显示当前角色可执行动作</Badge>}>
        <Table>
          <thead><tr><th>角色</th><th>查看</th><th>创建</th><th>分派 / 复审</th><th>终审发布</th></tr></thead>
          <tbody>
            {ROLE_ITEMS.map((item) => <tr key={item.value}><td>{item.label}</td><td>允许</td><td>{item.value === "admin" || item.value === "uploader" ? "允许" : "只读"}</td><td>{item.value === "admin" || item.value === "approver" ? "允许" : "只读"}</td><td>{item.value === "admin" ? "允许" : "只读"}</td></tr>)}
          </tbody>
        </Table>
      </ConsoleSection>

      <ConsoleSection title="治理资源" status={<Badge variant="neutral">{totals[resource]} 项</Badge>}>
        <Grid gap="sm">
          <Grid variant="2up" gap="sm">
            <GridItem>
              <Select label="资源" value={resource} items={RESOURCE_ITEMS.map(({ resource: value, title: label }) => ({ value, label }))} onValueChange={(value: Resource | null) => { if (value) { setResource(value); setPage(1); } }} renderValue={(value: Resource) => RESOURCE_ITEMS.find((item) => item.resource === value)?.title ?? value} />
            </GridItem>
            <GridItem>
              <Input label="搜索名称、对象或操作者" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
            </GridItem>
          </Grid>
          {resource === "audit" && <Select label="审计视图" value={auditView} items={[...AUDIT_VIEW_ITEMS]} onValueChange={(value) => { if (value) { setAuditView(value); setPage(1); } }} renderValue={(value: string) => AUDIT_VIEW_ITEMS.find((item) => item.value === value)?.label ?? value} />}
          <Text variant="secondary">{activeDefinition?.description}</Text>
          <Grid variant="4up" gap="sm">
            <GridItem>{isAdmin && (resource === "rubrics" || resource === "benchmarks" || resource === "rounds") && <Button variant="secondary" onClick={() => setDialog("create")}>{resource === "rounds" ? "打开复审" : "创建"}</Button>}</GridItem>
            <GridItem>{canApprove && resource === "rounds" && <Button variant="secondary" onClick={() => setDialog("assign")}>分派</Button>}</GridItem>
            <GridItem>{canApprove && resource === "rounds" && <Button variant="secondary" onClick={() => setDialog("submit")}>提交复审</Button>}</GridItem>
            <GridItem>{isAdmin && resource === "gates" && <Button onClick={() => setDialog("final")}>终审并发布</Button>}</GridItem>
          </Grid>
          <Table>
            <thead><tr><th>{activeDefinition?.fields[0] ?? "对象"}</th><th>{activeDefinition?.fields[1] ?? "状态"}</th><th>{activeDefinition?.fields[2] ?? "负责人"}</th><th>{activeDefinition?.fields[3] ?? "时间"}</th><th>操作</th></tr></thead>
            <tbody>
              {currentItems.map((item, index) => <tr key={fieldValue(item, ["id", "key"]) || String(index)}><td>{titleOf(item)}</td><td>{fieldValue(item, ["subject", "status", "roundNo", "version", "view", "action"])}</td><td>{fieldValue(item, ["assigneeName", "reviewerName", "ownerName", "actorName", "createdBy"])}</td><td>{fieldValue(item, ["updatedAt", "createdAt", "occurredAt", "publishedAt"])}</td><td><Button size="sm" variant="secondary" onClick={() => setDetail(item)}>详情</Button></td></tr>)}
              {!currentItems.length && <tr><td colSpan={5}><Text variant="secondary">没有符合筛选条件的治理记录。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination page={page} pageSize={pageSize} total={totals[resource]} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
        </Grid>
      </ConsoleSection>

      <ConsoleDrawer open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }} title={detail ? titleOf(detail) : "治理详情"} description={detail ? stateOf(detail) : undefined}>
        {detail && <Table><tbody>{Object.entries(detail).map(([key, value]) => <tr key={key}><th>{key}</th><td>{formatValue(value)}</td></tr>)}</tbody></Table>}
      </ConsoleDrawer>

      <Dialog.Root open={dialog === "create"} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <Dialog size="base">
          <Grid gap="sm">
            <Dialog.Title>{resource === "rounds" ? "打开复审轮次" : "创建治理对象"}</Dialog.Title>
            <Dialog.Description>自动项仅能预筛；新对象不会自行发布。</Dialog.Description>
            {resource === "rounds" ? <Input label="候选 ID" value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })} /> : <Input label="名称" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />}
            {resource === "rubrics" && <Input label="量表 key" description="小写字母开头，仅使用小写字母、数字、下划线或连字符。" value={form.rubricKey} onChange={(event) => setForm({ ...form, rubricKey: event.target.value })} />}
            {resource === "rubrics" && <Select label="适用对象" value={form.subject} items={[...SUBJECT_ITEMS]} onValueChange={(value) => value && setForm({ ...form, subject: value })} />}
            {resource === "rubrics" && <Grid variant="3up" gap="sm">
              <GridItem><Input label="维度 key" description="小写字母开头，可使用数字与下划线。" value={form.dimensionKey} onChange={(event) => setForm({ ...form, dimensionKey: event.target.value })} /></GridItem>
              <GridItem><Input label="维度名称" value={form.dimensionLabel} onChange={(event) => setForm({ ...form, dimensionLabel: event.target.value })} /></GridItem>
              <GridItem><Input label="维度权重" description="当前量表只有一个维度，权重必须为 100。" value={form.dimensionWeight} onChange={(event) => setForm({ ...form, dimensionWeight: event.target.value })} /></GridItem>
            </Grid>}
            {resource === "rubrics" && <Input label="通过阈值（0–100）" value={form.threshold} onChange={(event) => setForm({ ...form, threshold: event.target.value })} />}
            {resource === "benchmarks" && <InputArea label="说明" value={form.notes} onValueChange={(value) => setForm({ ...form, notes: value })} minRows={2} />}
            <Button disabled={busy || (resource === "rounds" ? !form.targetId.trim() : resource === "rubrics" ? !rubricFormValid : !form.title.trim())} onClick={() => {
              if (resource === "rounds") return submitAction("rounds", "open", { candidateId: form.targetId.trim() });
              if (resource === "rubrics") return submitAction("rubrics", "create", {
                rubricKey: form.rubricKey.trim(),
                name: form.title.trim(),
                subjectType: form.subject,
                dimensions: [{ key: form.dimensionKey.trim(), label: form.dimensionLabel.trim(), weight: dimensionWeight }],
                threshold: rubricThreshold,
              });
              return submitAction("benchmarks", "create", { name: form.title.trim(), description: form.notes || undefined });
            }}>{busy ? "保存中…" : resource === "rounds" ? "打开复审" : "创建"}</Button>
            <Dialog.Close render={(props) => <Button variant="secondary" {...props}>取消</Button>} />
          </Grid>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={dialog === "assign"} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <Dialog size="base">
          <Grid gap="sm">
            <Dialog.Title>分派复审轮次</Dialog.Title>
            <Dialog.Description>仅 A / B 可分派内容与音乐两位人工复审人。</Dialog.Description>
            <Input label="复审轮次 ID" value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })} />
            <Input label="内容复审人 ID" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })} />
            <Input label="音乐复审人 ID" value={form.musicReviewerId} onChange={(event) => setForm({ ...form, musicReviewerId: event.target.value })} />
            <Button disabled={busy || !form.targetId.trim() || !form.assigneeId.trim() || !form.musicReviewerId.trim()} onClick={() => submitAction("rounds", "assign", { roundId: form.targetId.trim(), contentReviewerId: form.assigneeId.trim(), musicReviewerId: form.musicReviewerId.trim() })}>{busy ? "分派中…" : "确认分派"}</Button>
            <Dialog.Close render={(props) => <Button variant="secondary" {...props}>取消</Button>} />
          </Grid>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={dialog === "submit"} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <Dialog size="base">
          <Grid gap="sm">
            <Dialog.Title>提交人工复审</Dialog.Title>
            <Dialog.Description>自动预筛结果只能作为参考；A 或 B 必须提交人工结论。</Dialog.Description>
            <Input label="复审轮次 ID" value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })} />
            <Select label="复审类型" value={form.reviewKind} items={[{ value: "content", label: "内容复审" }, { value: "music", label: "音乐复审" }]} onValueChange={(value) => value && setForm({ ...form, reviewKind: value === "music" ? "music" : "content" })} />
            <Select label="人工结论" value={form.verdict || null} items={[...VERDICT_ITEMS]} onValueChange={(value) => value && setForm({ ...form, verdict: value })} />
            <Input label="量表分数（0–100）" value={form.score} onChange={(event) => setForm({ ...form, score: event.target.value })} />
            <InputArea label="人工复审说明" value={form.notes} onValueChange={(value) => setForm({ ...form, notes: value })} minRows={3} />
            <Button disabled={busy || !reviewFormValid} onClick={() => submitAction("rounds", "submit", { roundId: form.targetId.trim(), reviewKind: form.reviewKind, verdict: form.verdict, score: reviewScore, notes: form.notes.trim() })}>{busy ? "提交中…" : "提交人工复审"}</Button>
            <Dialog.Close render={(props) => <Button variant="secondary" {...props}>取消</Button>} />
          </Grid>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={dialog === "final"} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <Dialog size="base">
          <Grid gap="sm">
            <Dialog.Title>终审发布门禁</Dialog.Title>
            <Dialog.Description>只有管理员能在人工终审、量表与基准均通过后放行发布。</Dialog.Description>
            <Select label="终审对象类型" value={form.finalTargetType} items={[...FINAL_TARGET_ITEMS]} onValueChange={(value) => value && setForm({ ...form, finalTargetType: value, targetId: "" })} />
            <Input label={form.finalTargetType === "candidate" ? "候选 ID" : "出版物修订 ID"} value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })} />
            <Button disabled={busy || !form.targetId.trim()} onClick={() => submitAction("gates", "final-pass", form.finalTargetType === "candidate" ? { candidateId: form.targetId.trim() } : { publicationRevisionId: form.targetId.trim() })}>{busy ? "终审中…" : "确认终审并发布"}</Button>
            <Dialog.Close render={(props) => <Button variant="secondary" {...props}>取消</Button>} />
          </Grid>
        </Dialog>
      </Dialog.Root>
    </Grid>
  );
}
