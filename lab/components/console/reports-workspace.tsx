"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox, Grid, GridItem, Input, InputArea, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";
import { THEME_SCENE_ITEMS } from "@/lib/theme-song";

interface ReportSummary {
  id: string;
  subjectType: "candidate" | "song";
  subjectId: string;
  subjectTitle: string;
  reportKind: string;
  evaluator: string;
  evaluatorVersion: string;
  verdict: "pass" | "fail" | "warning" | "info";
  totalScore: number | null;
  grade: string;
  domain: string;
  ageBand: string;
  scene: string;
  provider: string;
  model: string;
  specId: string | null;
  specRevision: number | null;
  promptSnapshotId: string | null;
  createdAt: number;
}

interface ReportDetail extends ReportSummary {
  summary: string;
  dimensions: Array<{ key: string; label: string; score: number | null; verdict: string; evidence: { detail?: string; weight?: number } }>;
  knowledge: null | { title: string; objective: string; points: Array<{ lead: string; answer: string; cue?: string }>; contentHash: string };
  promptSnapshot: null | { id: string; prompt: string; lyrics: string; request: unknown; builderVersion: string; tuning: string; skillBundleHash: string };
}

interface TestSetSummary {
  id: string;
  name: string;
  description: string;
  itemCount: number;
}

const VERDICT_LABEL: Record<string, string> = { pass: "合格", fail: "不合格", warning: "需关注", info: "信息" };
const PRESET_ITEMS = [
  { value: "all", label: "全部报告" },
  { value: "fail", label: "不合格" },
  { value: "high", label: "高分（≥85）" },
  { value: "weak", label: "单维弱项（≤60）" },
] as const;

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export function ReportsWorkspace() {
  const toast = useConsoleToast();
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [preset, setPreset] = useState<(typeof PRESET_ITEMS)[number]["value"]>("all");
  const [search, setSearch] = useState("");
  const [scene, setScene] = useState("");
  const [model, setModel] = useState("");
  const [dimension, setDimension] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [comparison, setComparison] = useState<ReportDetail[]>([]);
  const [testSets, setTestSets] = useState<TestSetSummary[]>([]);
  const [testSetId, setTestSetId] = useState("");
  const [newTestSetName, setNewTestSetName] = useState("");
  const [busy, setBusy] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) params.set("search", search.trim());
    if (scene) params.set("scene", scene);
    if (model.trim()) params.set("model", model.trim());
    if (preset === "fail") params.set("verdict", "fail");
    if (preset === "high") params.set("minScore", "85");
    if (preset === "weak" && dimension.trim()) {
      params.set("dimension", dimension.trim());
      params.set("dimensionMax", "60");
    }
    return params.toString();
  }, [dimension, model, page, pageSize, preset, scene, search]);

  const load = useCallback(async () => {
    const payload = await readJson<{ reports: ReportSummary[]; total: number; page: number }>(`/api/admin/reports?${query}`);
    setReports(payload.reports);
    setTotal(payload.total);
    if (payload.page !== page) setPage(payload.page);
  }, [page, query]);

  const loadTestSets = useCallback(async () => {
    const payload = await readJson<{ testSets: TestSetSummary[] }>("/api/admin/test-sets");
    setTestSets(payload.testSets);
    if (!testSetId && payload.testSets[0]) setTestSetId(payload.testSets[0].id);
  }, [testSetId]);

  useEffect(() => { load().catch((error) => toast.error("读取报告失败", error.message)); }, [load]);
  useEffect(() => { loadTestSets().catch(() => undefined); }, [loadTestSets]);

  async function openReport(id: string) {
    setBusy("detail");
    try {
      const payload = await readJson<{ report: ReportDetail }>(`/api/admin/reports/${id}`);
      setDetail(payload.report);
    } catch (error) {
      toast.error("读取报告失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function copyAiContext(mode: "markdown" | "link") {
    if (!detail) return;
    setBusy("context");
    try {
      const payload = await readJson<{ markdown: string; url: string; expiresAt: number }>("/api/admin/ai-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectType: "report", subjectId: detail.id, format: "markdown" }),
      });
      const value = mode === "markdown" ? payload.markdown : new URL(payload.url, window.location.origin).toString();
      await navigator.clipboard.writeText(value);
      toast.success(mode === "markdown" ? "AI 上下文已复制" : "15 分钟只读链接已复制");
    } catch (error) {
      toast.error("生成 AI 上下文失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function compareSelected() {
    if (selected.size < 2) return;
    setBusy("compare");
    try {
      const payload = await readJson<{ reports: ReportDetail[] }>(`/api/admin/reports/compare?ids=${encodeURIComponent([...selected].join(","))}`);
      setComparison(payload.reports);
    } catch (error) {
      toast.error("对比失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function addToTestSet(targetId: string) {
    if (!targetId || !selected.size) return;
    setBusy("test-set");
    try {
      await readJson(`/api/admin/test-sets/${targetId}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportIds: [...selected] }),
      });
      await loadTestSets();
      toast.success(`已加入 ${selected.size} 份报告`);
    } catch (error) {
      toast.error("加入测试集失败", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy("");
    }
  }

  async function createAndAddTestSet() {
    if (!newTestSetName.trim() || !selected.size) return;
    setBusy("test-set");
    try {
      const created = await readJson<{ id: string }>("/api/admin/test-sets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newTestSetName, description: "从评分报告中心创建" }),
      });
      await addToTestSet(created.id);
      setNewTestSetName("");
      setTestSetId(created.id);
      await loadTestSets();
    } catch (error) {
      toast.error("创建测试集失败", error instanceof Error ? error.message : undefined);
      setBusy("");
    }
  }

  const comparisonDimensions = useMemo(() => {
    const keys = new Map<string, string>();
    comparison.forEach((report) => report.dimensions.forEach((item) => keys.set(item.key, item.label)));
    return [...keys.entries()];
  }, [comparison]);

  return (
    <Grid gap="base">
      <ConsoleSection title="筛选报告">
        <Grid gap="sm">
          <Grid variant="2up" gap="sm">
            <GridItem><Input label="搜索" value={search} onValueChange={(value) => { setSearch(value); setPage(1); }} /></GridItem>
            <GridItem><Select label="快捷视图" value={preset} items={[...PRESET_ITEMS]} onValueChange={(value) => { if (value) { setPreset(value); setPage(1); } }} /></GridItem>
            <GridItem><Select label="场景" value={scene} items={[{ value: "", label: "全部场景" }, ...THEME_SCENE_ITEMS]} onValueChange={(value) => { setScene(value ?? ""); setPage(1); }} /></GridItem>
            <GridItem><Input label="模型" value={model} onValueChange={(value) => { setModel(value); setPage(1); }} /></GridItem>
          </Grid>
          {preset === "weak" && <Input label="维度 key" description="例如 loudness、tempo、singability；筛出该维度 ≤60 的报告。" value={dimension} onValueChange={(value) => { setDimension(value); setPage(1); }} />}
        </Grid>
      </ConsoleSection>

      <ConsoleSection
        title="评分报告"
        status={<Badge variant="neutral">{total} 份</Badge>}
      >
        <Grid gap="sm">
          {selected.size > 0 && (
            <Grid gap="sm">
              <Text bold>已选 {selected.size} 份报告</Text>
              <Grid variant="2up" gap="sm">
                <GridItem><Button disabled={selected.size < 2 || Boolean(busy)} onClick={compareSelected}>横向对比</Button></GridItem>
                <GridItem>
                  <Select
                    label="加入已有测试集"
                    value={testSetId}
                    items={testSets.map((item) => ({ value: item.id, label: `${item.name}（${item.itemCount}）` }))}
                    onValueChange={(value) => setTestSetId(value ?? "")}
                  />
                </GridItem>
              </Grid>
              <Button variant="secondary" disabled={!testSetId || Boolean(busy)} onClick={() => addToTestSet(testSetId)}>加入测试集</Button>
              <Grid variant="2up" gap="sm">
                <GridItem><Input label="新测试集名称" value={newTestSetName} onValueChange={setNewTestSetName} /></GridItem>
                <GridItem><Button variant="secondary" disabled={!newTestSetName.trim() || Boolean(busy)} onClick={createAndAddTestSet}>新建并加入</Button></GridItem>
              </Grid>
            </Grid>
          )}
          <Table>
            <thead><tr><th>选择</th><th>对象</th><th>结果</th><th>领域 / 场景</th><th>模型</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td><Checkbox label="选择" checked={selected.has(report.id)} onCheckedChange={(checked) => setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(report.id); else next.delete(report.id);
                    return next;
                  })} /></td>
                  <td><Text bold>{report.subjectTitle}</Text><Text variant="mono-secondary">{report.subjectType} · {report.id.slice(0, 8)}</Text></td>
                  <td><Badge variant={report.verdict === "pass" ? "success" : report.verdict === "fail" ? "error" : "neutral"}>{VERDICT_LABEL[report.verdict] ?? report.verdict}</Badge><Text>{report.totalScore ?? "—"} / {report.grade || "—"}</Text></td>
                  <td><Text>{report.domain || "—"}</Text><Text variant="secondary">{report.ageBand || "—"} · {report.scene || "—"}</Text></td>
                  <td>{report.model || "上传音频"}</td>
                  <td>{new Date(report.createdAt).toLocaleString("zh-CN")}</td>
                  <td><Button size="sm" variant="ghost" disabled={busy === "detail"} onClick={() => openReport(report.id)}>查看</Button></td>
                </tr>
              ))}
              {!reports.length && <tr><td colSpan={7}><Text variant="secondary">没有匹配的评分报告。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(value: number) => { setPageSize(value); setPage(1); }} />
        </Grid>
      </ConsoleSection>

      <ConsoleDrawer open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)} title={detail?.subjectTitle ?? "报告详情"} description={detail ? `${VERDICT_LABEL[detail.verdict]} · ${detail.totalScore ?? "—"} 分 · ${detail.evaluatorVersion}` : undefined}>
        {detail && <Grid gap="base">
          <Grid variant="2up" gap="sm">
            <GridItem><Button disabled={busy === "context"} onClick={() => copyAiContext("markdown")}>复制 AI 上下文</Button></GridItem>
            <GridItem><Button variant="secondary" disabled={busy === "context"} onClick={() => copyAiContext("link")}>复制临时读取链接</Button></GridItem>
          </Grid>
          <ConsoleSection title="结论"><Text>{detail.summary}</Text></ConsoleSection>
          <ConsoleSection title="维度">
            <Table><thead><tr><th>维度</th><th>分数</th><th>判断</th><th>证据</th></tr></thead><tbody>
              {detail.dimensions.map((item) => <tr key={item.key}><td>{item.label}<Text variant="mono-secondary">{item.key}</Text></td><td>{item.score ?? "—"}</td><td>{VERDICT_LABEL[item.verdict] ?? item.verdict}</td><td>{item.evidence.detail || "—"}</td></tr>)}
            </tbody></Table>
          </ConsoleSection>
          {detail.knowledge && <ConsoleSection title="知识快照">
            <Text bold>{detail.knowledge.title}</Text><Text>{detail.knowledge.objective}</Text>
            <Table><thead><tr><th>提示</th><th>答案</th></tr></thead><tbody>{detail.knowledge.points.map((point, index) => <tr key={`${point.lead}-${index}`}><td>{point.lead}</td><td>{point.answer}</td></tr>)}</tbody></Table>
            <Text variant="mono-secondary">{detail.knowledge.contentHash}</Text>
          </ConsoleSection>}
          {detail.promptSnapshot && <ConsoleSection title="提示词快照">
            <Text variant="mono-secondary">{detail.promptSnapshot.builderVersion} · {detail.promptSnapshot.tuning} · {detail.promptSnapshot.id}</Text>
            <InputArea label="提示词" value={detail.promptSnapshot.prompt} readOnly autoResize minRows={4} maxRows={16} />
            <InputArea label="歌词" value={detail.promptSnapshot.lyrics} readOnly autoResize minRows={6} maxRows={20} />
            <InputArea label="请求参数" value={JSON.stringify(detail.promptSnapshot.request, null, 2)} readOnly autoResize minRows={3} maxRows={12} />
          </ConsoleSection>}
        </Grid>}
      </ConsoleDrawer>

      <ConsoleDrawer open={comparison.length > 0} onOpenChange={(open) => !open && setComparison([])} title="报告对比" description={comparison.length ? `${comparison.length} 份报告，同一维度横向比较` : undefined}>
        {comparison.length > 0 && <Grid gap="base">
          <Table><thead><tr><th>维度</th>{comparison.map((report) => <th key={report.id}>{report.subjectTitle}<Text variant="secondary">{report.model || "上传音频"}</Text></th>)}</tr></thead><tbody>
            <tr><td>总分</td>{comparison.map((report) => <td key={report.id}>{report.totalScore ?? "—"} / {report.grade || "—"}</td>)}</tr>
            {comparisonDimensions.map(([key, label]) => <tr key={key}><td>{label}</td>{comparison.map((report) => <td key={report.id}>{report.dimensions.find((item) => item.key === key)?.score ?? "—"}</td>)}</tr>)}
          </tbody></Table>
          {comparison.map((report) => report.promptSnapshot && <ConsoleSection key={report.id} title={`${report.subjectTitle} · 提示词`}>
            <InputArea label={`${report.model || "上传音频"} · ${report.promptSnapshot.tuning}`} value={report.promptSnapshot.prompt} readOnly autoResize minRows={3} maxRows={10} />
          </ConsoleSection>)}
        </Grid>}
      </ConsoleDrawer>
    </Grid>
  );
}
