"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Dialog, Grid, GridItem, Input, InputArea, Select, Table, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

type Role = "admin" | "approver" | "uploader";
type View = "items" | "domains" | "sources" | "curricula";
type RecordValue = Record<string, unknown>;

type ListResponse = {
  items?: RecordValue[];
  page?: number;
  pageSize?: number;
  total?: number;
  error?: string;
};

type ItemDraft = {
  title: string;
  slug: string;
  domainId: string;
  objective: string;
  lead: string;
  answer: string;
  summary: string;
  ageBand: string;
  contentRisk: "low" | "medium" | "high";
  sourceRevisionId: string;
  sourceLocator: string;
};

type DomainDraft = { name: string; slug: string; description: string; parentId: string };
type SourceDraft = { title: string; sourceType: string; publisher: string; versionLabel: string; license: string; excerpt: string };
type CurriculumDraft = { code: string; name: string; ageBand: string; description: string };

const VIEW_ITEMS: Array<{ value: View; label: string }> = [
  { value: "items", label: "知识点" },
  { value: "domains", label: "领域" },
  { value: "sources", label: "教材" },
  { value: "curricula", label: "课程" },
];

const STATUS_ITEMS = [
  { value: "", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "review", label: "待复审" },
  { value: "published", label: "已发布" },
  { value: "retired", label: "已退役" },
];

const SOURCE_TYPE_ITEMS = [
  { value: "book", label: "图书" },
  { value: "article", label: "文章" },
  { value: "standard", label: "标准" },
  { value: "course", label: "课程" },
  { value: "manual", label: "手册" },
  { value: "original", label: "原创资料" },
];

const RISK_ITEMS = [
  { value: "low", label: "低风险" },
  { value: "medium", label: "中风险" },
  { value: "high", label: "高风险" },
];

const RELATION_ITEMS = [
  { value: "sequence", label: "顺序" },
  { value: "cause", label: "因果" },
  { value: "contrast", label: "对比" },
  { value: "classification", label: "分类" },
  { value: "condition", label: "条件" },
  { value: "result", label: "结果" },
  { value: "prerequisite", label: "前置" },
];

function textOf(value: unknown, fallback = "") {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

function numberOf(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function badgeVariant(status: string): "success" | "info" | "warning" | "error" | "neutral" {
  if (status === "published" || status === "pass") return "success";
  if (status === "review") return "info";
  if (status === "revise" || status === "draft") return "warning";
  if (status === "reject" || status === "retired") return "error";
  return "neutral";
}

function dateOf(value: unknown) {
  const time = numberOf(value);
  return time ? new Date(time).toLocaleString("zh-CN") : "—";
}

function arrayOf(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is RecordValue => Boolean(item) && typeof item === "object") : [];
}

function itemDraftOf(record: RecordValue | null): ItemDraft {
  const revisionCandidate = record?.currentRevision ?? record?.revision;
  const revision = revisionCandidate && typeof revisionCandidate === "object" && !Array.isArray(revisionCandidate)
    ? revisionCandidate as RecordValue
    : record;
  return {
    title: textOf(revision?.title), slug: textOf(record?.slug), domainId: textOf(record?.domainId),
    objective: textOf(revision?.objective), lead: textOf(revision?.lead), answer: textOf(revision?.answer),
    summary: textOf(revision?.summary), ageBand: textOf(revision?.ageBand),
    contentRisk: textOf(revision?.contentRisk, "low") as ItemDraft["contentRisk"],
    sourceRevisionId: textOf(revision?.sourceRevisionId), sourceLocator: textOf(revision?.sourceLocator),
  };
}

function domainDraftOf(record: RecordValue | null): DomainDraft {
  return { name: textOf(record?.name), slug: textOf(record?.slug), description: textOf(record?.description), parentId: textOf(record?.parentId) };
}

function sourceDraftOf(record: RecordValue | null): SourceDraft {
  const revisionCandidate = record?.currentRevision ?? record?.revision;
  const revision = revisionCandidate && typeof revisionCandidate === "object" && !Array.isArray(revisionCandidate)
    ? revisionCandidate as RecordValue
    : record;
  return {
    title: textOf(record?.title), sourceType: textOf(record?.sourceType, "book"), publisher: textOf(record?.publisher),
    versionLabel: textOf(revision?.versionLabel), license: textOf(revision?.license), excerpt: textOf(revision?.excerpt),
  };
}

function curriculumDraftOf(record: RecordValue | null): CurriculumDraft {
  return { code: textOf(record?.code), name: textOf(record?.name), ageBand: textOf(record?.ageBand), description: textOf(record?.description) };
}

function rowTitle(view: View, item: RecordValue) {
  if (view === "items") return textOf((item.currentRevision as RecordValue | undefined)?.title, textOf(item.title, textOf(item.slug)));
  return textOf(item.name, textOf(item.title, textOf(item.code)));
}

function rowSubtitle(view: View, item: RecordValue) {
  if (view === "items") return `${textOf(item.slug)} · ${textOf(item.domainName, textOf(item.domainId))}`;
  if (view === "sources") return `${textOf(item.sourceType)} · ${textOf(item.publisher, "未标注出版方")}`;
  if (view === "curricula") return `${textOf(item.code)} · ${textOf(item.ageBand)}`;
  return textOf(item.slug);
}

export function KnowledgeWorkspace({ role }: { role: Role }) {
  const toast = useConsoleToast();
  const [view, setView] = useState<View>("items");
  const [items, setItems] = useState<RecordValue[]>([]);
  const [domains, setDomains] = useState<RecordValue[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [domainId, setDomainId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const detailIdRef = useRef("");
  const listRequestRef = useRef(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<RecordValue | null>(null);
  const [busy, setBusy] = useState("");
  const [theme, setTheme] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [relation, setRelation] = useState("prerequisite");
  const [relationConnector, setRelationConnector] = useState("");
  const [itemDraft, setItemDraft] = useState<ItemDraft>(itemDraftOf(null));
  const [domainDraft, setDomainDraft] = useState<DomainDraft>(domainDraftOf(null));
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>(sourceDraftOf(null));
  const [curriculumDraft, setCurriculumDraft] = useState<CurriculumDraft>(curriculumDraftOf(null));

  const canAuthor = role === "admin" || role === "uploader";
  const canReview = role === "admin" || role === "approver";
  const canManageStructure = role === "admin";
  const isItem = view === "items";
  const domainOptions = useMemo(() => [{ value: "", label: "全部领域" }, ...domains.map((domain) => ({ value: textOf(domain.id), label: textOf(domain.name, textOf(domain.slug)) }))], [domains]);

  const loadDomains = useCallback(async () => {
    const response = await fetch("/api/admin/knowledge?resource=domains&page=1&pageSize=100", { cache: "no-store" });
    const payload = await response.json() as ListResponse;
    if (!response.ok) throw new Error(payload.error || "读取领域失败");
    setDomains(payload.items ?? []);
  }, []);

  const loadList = useCallback(async (nextPage = page, nextPageSize = pageSize, selectedId = detailIdRef.current) => {
    const requestId = ++listRequestRef.current;
    const params = new URLSearchParams({ resource: view, page: String(nextPage), pageSize: String(nextPageSize) });
    if (query.trim()) params.set("search", query.trim());
    if (status) params.set("status", status);
    if (isItem && domainId) params.set("domain", domainId);
    const response = await fetch(`/api/admin/knowledge?${params}`, { cache: "no-store" });
    const payload = await response.json() as ListResponse;
    if (requestId !== listRequestRef.current) return null;
    if (!response.ok) throw new Error(payload.error || "读取知识库失败");
    const nextItems = payload.items ?? [];
    setItems(nextItems);
    setTotal(payload.total ?? 0);
    if (payload.page && payload.page !== page) setPage(payload.page);

    if (selectedId && !detailIdRef.current) return null;
    const activeSelectedId = detailIdRef.current;
    if (!activeSelectedId) return null;
    const fresh = nextItems.find((item) => textOf(item.id, "") === activeSelectedId) ?? null;
    if (!fresh) {
      detailIdRef.current = "";
      setDetail(null);
      setDetailOpen(false);
      return null;
    }
    setDetail((current) => {
      if (!current || textOf(current.id) !== activeSelectedId) return fresh;
      const sameRevision = textOf(current.currentRevision) === textOf(fresh.currentRevision);
      return sameRevision ? { ...current, ...fresh } : fresh;
    });
    return fresh;
  }, [domainId, isItem, page, pageSize, query, status, view]);

  useEffect(() => {
    Promise.all([loadDomains(), loadList(page, pageSize)])
      .then(() => setLoadError(""))
      .catch((error) => {
        const message = error instanceof Error ? error.message : "未知错误";
        setLoadError(message);
        toast.error("读取知识库失败", message);
      })
      .finally(() => setLoading(false));
  }, [loadDomains, loadList]);

  const refresh = useCallback(async (selectedId = detailIdRef.current, nextPage = page) => {
    const [, fresh] = await Promise.all([loadDomains(), loadList(nextPage, pageSize, selectedId)]);
    return fresh;
  }, [loadDomains, loadList, page, pageSize]);

  function closeDetail() {
    detailIdRef.current = "";
    setDetail(null);
    setDetailOpen(false);
  }

  function openDetail(id: string) {
    const selected = items.find((item) => textOf(item.id, "") === id);
    if (!selected) {
      toast.error("读取详情失败", "当前列表中没有这个对象，请刷新后重试");
      closeDetail();
      return;
    }
    detailIdRef.current = id;
    setDetail(selected);
    setDetailOpen(true);
  }

  async function mutate(resource: string, action: string, payload: RecordValue, success: string, focusId = detailIdRef.current) {
    setBusy(`${resource}:${action}`);
    try {
      const response = await fetch("/api/admin/knowledge", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource, action, payload }),
      });
      const result = await response.json() as RecordValue & { error?: string };
      if (!response.ok) throw new Error(result.error || `${success}失败`);

      const nested = resource === "items" ? result.item : resource === "domains" ? result.domain : resource === "sources" ? result.source : resource === "curricula" ? result.curriculum : null;
      const record = nested && typeof nested === "object" ? nested as RecordValue : result;
      const responseId = textOf(record.id, textOf(result.id));
      const resolvedFocusId = focusId || (resource === view ? responseId : "");

      if (resolvedFocusId) {
        detailIdRef.current = resolvedFocusId;
        setDetail((current) => {
          if (current && textOf(current.id) !== resolvedFocusId) return current;
          if (resource === "edges") {
            if (!current) return current;
            const existing = arrayOf(current.relations ?? current.edges);
            if (action === "create" && result.edge && typeof result.edge === "object") return { ...current, relations: [...existing, result.edge] };
            if (action === "delete") return { ...current, relations: existing.filter((edge) => textOf(edge.id) !== textOf(payload.id)) };
            return current;
          }
          const next: RecordValue = { ...(current ?? { id: resolvedFocusId }), ...record, id: resolvedFocusId };
          if (resource === "items" && action === "review") {
            next.reviewVerdict = result.verdict;
            next.reviewedRevision = current?.currentRevision;
          } else if (resource === "items" && (action === "revise" || action === "submit")) {
            delete next.reviewVerdict;
            delete next.reviewedRevision;
          }
          return next;
        });
        setDetailOpen(true);
      }

      toast.success(success);
      await refresh(resolvedFocusId, resolvedFocusId && resource === view ? 1 : page);
      return result;
    } catch (error) {
      toast.error(`${success}失败`, error instanceof Error ? error.message : undefined);
      return null;
    } finally {
      setBusy("");
    }
  }

  function beginCreate() {
    setEditing(null);
    setItemDraft(itemDraftOf(null));
    setDomainDraft(domainDraftOf(null));
    setSourceDraft(sourceDraftOf(null));
    setCurriculumDraft(curriculumDraftOf(null));
    setEditorOpen(true);
  }

  function beginRevise() {
    if (!detail) return;
    setEditing(detail);
    setItemDraft(itemDraftOf(detail));
    setDomainDraft(domainDraftOf(detail));
    setSourceDraft(sourceDraftOf(detail));
    setCurriculumDraft(curriculumDraftOf(detail));
    setEditorOpen(true);
  }

  async function saveEditor() {
    const id = textOf(editing?.id);
    const action = id ? (view === "items" || view === "sources" ? "revise" : "update") : "create";
    const itemPayload: RecordValue = {
      title: itemDraft.title,
      objective: itemDraft.objective,
      lead: itemDraft.lead,
      answer: itemDraft.answer,
      summary: itemDraft.summary,
      ageBand: itemDraft.ageBand,
      contentRisk: itemDraft.contentRisk,
      ...(itemDraft.sourceRevisionId.trim() ? { sourceRevisionId: itemDraft.sourceRevisionId.trim() } : {}),
      sourceLocator: itemDraft.sourceLocator,
    };
    const payload: RecordValue = view === "items"
      ? id
        ? { id, ...itemPayload }
        : { ...itemPayload, domainId: itemDraft.domainId, slug: itemDraft.slug }
      : view === "domains"
        ? { ...domainDraft, ...(id ? { id } : {}) }
        : view === "sources"
          ? id
            ? { id, versionLabel: sourceDraft.versionLabel, license: sourceDraft.license, excerpt: sourceDraft.excerpt }
            : sourceDraft
          : { ...curriculumDraft, ...(id ? { id } : {}) };
    if (await mutate(view, action, payload, id ? "已保存修订" : "已创建")) setEditorOpen(false);
  }

  async function changeStatus(action: string, label: string, payload: RecordValue = {}) {
    if (!detail) return;
    const currentStatus = textOf(detail.status);
    const allowed = action === "submit" ? currentStatus === "draft" : action === "review" ? currentStatus === "review" : action === "publish" ? currentStatus === "review" && reviewPassed : action === "retire" ? currentStatus === "published" : false;
    if (!allowed) {
      toast.error("当前状态不可执行此操作", `当前状态为 ${currentStatus || "未知"}，请刷新详情后重试`);
      return;
    }
    const id = textOf(detail.id);
    await mutate(view, action, { id, ...payload }, label, id);
  }

  async function createRelation() {
    if (!detail || !relationTarget) return;
    const fromRevisionId = textOf(detail.revisionId, textOf((detail.currentRevision as RecordValue | undefined)?.id, textOf(detail.currentRevisionId)));
    if (await mutate("edges", "create", { fromRevisionId, toRevisionId: relationTarget, relation, connector: relationConnector }, "已创建知识关系", textOf(detail.id))) {
      setRelationTarget("");
      setRelationConnector("");
    }
  }

  async function generateMockPlan() {
    if (!theme.trim()) {
      toast.error("请输入梳理主题");
      return;
    }
    if (!domainId) {
      toast.error("请先在领域筛选中选择归属领域");
      return;
    }
    if (await mutate("mock-plan", "create", { domainId, theme: theme.trim() }, "已生成待人工预筛主题", "")) {
      setTheme("");
    }
  }

  const detailStatus = textOf(detail?.status);
  const currentRevisionId = textOf(detail?.revisionId, textOf((detail?.currentRevision as RecordValue | undefined)?.id));
  const reviews = arrayOf(detail?.reviews);
  const reviewPassed = detailStatus === "review" && (
    textOf(detail?.reviewVerdict) === "pass" && textOf(detail?.reviewedRevision) === textOf(detail?.currentRevision)
    || reviews.some((review) => textOf(review.verdict) === "pass" && (!textOf(review.itemRevisionId) || textOf(review.itemRevisionId) === currentRevisionId))
  );
  const revision = (detail?.currentRevision ?? detail?.revision ?? detail) as RecordValue | null;
  const chapters = arrayOf(detail?.chapters ?? detail?.revisionChapters);
  const relations = arrayOf(detail?.relations ?? detail?.edges);
  const bindings = arrayOf(detail?.items ?? detail?.curriculumItems);

  if (loading) return <Text variant="secondary">正在读取知识库…</Text>;

  return (
    <Grid gap="base">
      <ConsoleSection title="知识工作台" status={<Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => refresh().catch((error) => toast.error("刷新失败", error.message))}>刷新</Button>}>
        <Grid gap="base">
          {loadError && <Banner variant="alert" title="读取知识库失败" description={loadError} />}
          <Grid variant="4up" gap="sm">
            {VIEW_ITEMS.map((entry) => <GridItem key={entry.value}><Button variant={view === entry.value ? "primary" : "secondary"} onClick={() => { closeDetail(); setView(entry.value); setPage(1); }}>{entry.label}</Button></GridItem>)}
          </Grid>
          <Grid variant="4up" gap="sm">
            <GridItem><Input label="搜索" placeholder="标题、名称或编码" value={query} onValueChange={(value) => { setQuery(value); setPage(1); }} /></GridItem>
            <GridItem><Select label="状态" value={status} items={STATUS_ITEMS} onValueChange={(value) => { setStatus(value ?? ""); setPage(1); }} /></GridItem>
            <GridItem>{isItem ? <Select label="领域" value={domainId} items={domainOptions} onValueChange={(value) => { setDomainId(value ?? ""); setPage(1); }} /> : <Text variant="secondary">当前视图不按领域筛选。</Text>}</GridItem>
            <GridItem>{(canAuthor && (isItem || view === "sources")) || (canManageStructure && (view === "domains" || view === "curricula")) ? <Button onClick={beginCreate}>新建{VIEW_ITEMS.find((entry) => entry.value === view)?.label}</Button> : <Text variant="secondary">你的角色不能在当前视图创建记录。</Text>}</GridItem>
          </Grid>
          {isItem && canAuthor && <Grid variant="2up" gap="sm">
            <GridItem><Input label="Mock 梳理主题" placeholder="例如：植物为什么需要阳光" value={theme} onValueChange={setTheme} /></GridItem>
            <GridItem><Text variant="secondary">先在上方选择归属领域；自动梳理仅生成待人工核验候选，不会直接发布。</Text></GridItem>
            <GridItem><Button disabled={busy === "mock-plan:create"} onClick={generateMockPlan}>{busy === "mock-plan:create" ? "正在梳理…" : "Mock 预筛主题"}</Button></GridItem>
          </Grid>}
          <Table>
            <thead><tr><th>名称</th><th>状态</th><th>修订</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              {items.map((item) => <tr key={textOf(item.id)}>
                <td><Text bold>{rowTitle(view, item)}</Text><Text variant="secondary">{rowSubtitle(view, item)}</Text></td>
                <td><Badge variant={badgeVariant(textOf(item.status))}>{textOf(item.status, "—")}</Badge></td>
                <td>{textOf(item.currentRevision, textOf(item.revision, "—"))}</td>
                <td>{dateOf(item.updatedAt ?? item.createdAt)}</td>
                <td><Button size="sm" variant="ghost" disabled={busy === "detail"} onClick={() => openDetail(textOf(item.id))}>查看详情</Button></td>
              </tr>)}
              {!items.length && <tr><td colSpan={5}><Text variant="secondary">没有符合当前筛选条件的记录。你可以清除搜索或新建一条记录。</Text></td></tr>}
            </tbody>
          </Table>
          <ConsolePagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
        </Grid>
      </ConsoleSection>

      <ConsoleDrawer open={detailOpen} onOpenChange={(open) => { if (open) setDetailOpen(true); else closeDetail(); }} title={detail ? rowTitle(view, detail) : "知识详情"} description={detail ? `${rowSubtitle(view, detail)} · ${detailStatus || "未标注状态"}` : undefined}>
        {!detail ? <Text variant="secondary">尚未选择记录。</Text> : <Grid gap="base">
          <ConsoleSection title="内容与修订" status={detailStatus ? <Badge variant={badgeVariant(detailStatus)}>{detailStatus}</Badge> : undefined}>
            <Grid gap="sm">
              <Text bold>{textOf(revision?.title, rowTitle(view, detail))}</Text>
              {textOf(revision?.objective) && <Text>{textOf(revision?.objective)}</Text>}
              {textOf(revision?.lead) && <Text>提示：{textOf(revision?.lead)}</Text>}
              {textOf(revision?.answer) && <Text>答案：{textOf(revision?.answer)}</Text>}
              {textOf(revision?.summary) && <Text variant="secondary">{textOf(revision?.summary)}</Text>}
              <Text variant="mono-secondary">ID：{textOf(detail.id)} · 修订：{textOf(detail.currentRevision, textOf(revision?.revision, "—"))}</Text>
            </Grid>
          </ConsoleSection>

          {(canAuthor && (view === "items" || view === "sources")) || (canManageStructure && view === "domains") ? <ConsoleSection title="编辑">
            <Button onClick={beginRevise}>创建修订或更新记录</Button>
          </ConsoleSection> : null}

          {view === "items" && <ConsoleSection title="流转动作">
            <Grid variant="4up" gap="sm">
              {canAuthor && detailStatus === "draft" && <GridItem><Button disabled={Boolean(busy)} onClick={() => changeStatus("submit", "已提交复审")}>提交复审</Button></GridItem>}
              {canReview && detailStatus === "review" && !reviewPassed && <GridItem><Button disabled={Boolean(busy)} onClick={() => changeStatus("review", "已完成复审", { verdict: "pass", notes: "人工复审通过" })}>通过复审</Button></GridItem>}
              {canReview && detailStatus === "review" && <GridItem><Button variant="secondary" disabled={Boolean(busy)} onClick={() => changeStatus("review", "已退回修订", { verdict: "revise", notes: "请补充或修订内容" })}>退回修订</Button></GridItem>}
              {canManageStructure && detailStatus === "review" && <GridItem><Button disabled={Boolean(busy) || !reviewPassed} onClick={() => changeStatus("publish", "已发布知识点")}>{reviewPassed ? "发布知识点" : "通过复审后可发布"}</Button></GridItem>}
              {canManageStructure && detailStatus === "published" && <GridItem><Button variant="secondary" disabled={Boolean(busy)} onClick={() => changeStatus("retire", "已退役知识点")}>退役</Button></GridItem>}
              {!canAuthor && !canReview && <GridItem><Text variant="secondary">你的角色仅可查看流转状态。</Text></GridItem>}
            </Grid>
          </ConsoleSection>}

          {chapters.length > 0 && <ConsoleSection title={`教材章节（${chapters.length}）`}>
            <Table><thead><tr><th>章节</th><th>定位</th><th>顺序</th></tr></thead><tbody>{chapters.map((chapter) => <tr key={textOf(chapter.id)}><td>{textOf(chapter.title)}</td><td>{textOf(chapter.locator, "—")}</td><td>{textOf(chapter.position, "—")}</td></tr>)}</tbody></Table>
          </ConsoleSection>}
          {view === "sources" && chapters.length === 0 && <ConsoleSection title="教材章节"><Text variant="secondary">还没有章节。新建或修订教材后，可通过章节创建与重排动作维护目录。</Text></ConsoleSection>}

          {view === "items" && <ConsoleSection title={`知识关系（${relations.length}）`}>
            <Grid gap="sm">
              <Table><thead><tr><th>关系</th><th>目标</th><th>连接词</th><th>操作</th></tr></thead><tbody>
                {relations.map((edge) => <tr key={textOf(edge.id)}><td>{textOf(edge.relation)}</td><td>{textOf(edge.toTitle, textOf(edge.toRevisionId))}</td><td>{textOf(edge.connector, "—")}</td><td>{canAuthor ? <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => mutate("edges", "delete", { id: textOf(edge.id) }, "已删除知识关系", textOf(detail.id))}>删除</Button> : "—"}</td></tr>)}
                {!relations.length && <tr><td colSpan={4}><Text variant="secondary">尚未建立知识关系。</Text></td></tr>}
              </tbody></Table>
              {canAuthor && <Grid variant="4up" gap="sm">
                <GridItem><Input label="目标修订 ID" value={relationTarget} onValueChange={setRelationTarget} /></GridItem>
                <GridItem><Select label="关系类型" value={relation} items={RELATION_ITEMS} onValueChange={(value) => setRelation(value ?? "prerequisite")} /></GridItem>
                <GridItem><Input label="连接词" value={relationConnector} onValueChange={setRelationConnector} /></GridItem>
                <GridItem><Button disabled={Boolean(busy) || !relationTarget} onClick={createRelation}>建立关系</Button></GridItem>
              </Grid>}
            </Grid>
          </ConsoleSection>}

          {view === "curricula" && <ConsoleSection title={`课程编排（${bindings.length}）`}>
            <Table><thead><tr><th>位置</th><th>知识点</th><th>修订</th></tr></thead><tbody>{bindings.map((binding) => <tr key={textOf(binding.itemRevisionId, textOf(binding.id))}><td>{textOf(binding.position, "—")}</td><td>{textOf(binding.title, textOf(binding.itemTitle, textOf(binding.itemRevisionId)))}</td><td>{textOf(binding.revision, "—")}</td></tr>)}{!bindings.length && <tr><td colSpan={3}><Text variant="secondary">课程尚未绑定知识点。</Text></td></tr>}</tbody></Table>
          </ConsoleSection>}

          {reviews.length > 0 && <ConsoleSection title={`复审记录（${reviews.length}）`}>
            <Table><thead><tr><th>结论</th><th>分数</th><th>备注</th><th>时间</th></tr></thead><tbody>{reviews.map((review) => <tr key={textOf(review.id)}><td><Badge variant={badgeVariant(textOf(review.verdict))}>{textOf(review.verdict)}</Badge></td><td>{textOf(review.score, "—")}</td><td>{textOf(review.notes, "—")}</td><td>{dateOf(review.createdAt)}</td></tr>)}</tbody></Table>
          </ConsoleSection>}
        </Grid>}
      </ConsoleDrawer>

      <Dialog.Root open={editorOpen} onOpenChange={setEditorOpen}>
        <Dialog size="lg">
          <Grid gap="base">
            <Dialog.Close render={(props) => <Button size="sm" variant="secondary" {...props}>关闭</Button>} />
            <Dialog.Title>{editing ? `修订${VIEW_ITEMS.find((entry) => entry.value === view)?.label}` : `新建${VIEW_ITEMS.find((entry) => entry.value === view)?.label}`}</Dialog.Title>
            <Dialog.Description>提交的内容会进入对应的人工复审与发布流程；自动生成内容不会越过该流程。</Dialog.Description>
            {view === "items" && <Grid variant="2up" gap="sm">
              <GridItem><Input label="标题" value={itemDraft.title} onValueChange={(value) => setItemDraft({ ...itemDraft, title: value })} /></GridItem>
              {!editing && <GridItem><Input label="Slug" value={itemDraft.slug} onValueChange={(value) => setItemDraft({ ...itemDraft, slug: value })} /></GridItem>}
              {!editing && <GridItem><Select label="领域" value={itemDraft.domainId} items={domains.map((domain) => ({ value: textOf(domain.id), label: textOf(domain.name) }))} onValueChange={(value) => setItemDraft({ ...itemDraft, domainId: value ?? "" })} /></GridItem>}
              {editing && <GridItem><Text variant="secondary">Slug 与领域属于知识点身份，创建修订时保持不变。</Text></GridItem>}
              <GridItem><Input label="适龄段" value={itemDraft.ageBand} onValueChange={(value) => setItemDraft({ ...itemDraft, ageBand: value })} /></GridItem>
              <GridItem><Input label="学习目标" value={itemDraft.objective} onValueChange={(value) => setItemDraft({ ...itemDraft, objective: value })} /></GridItem>
              <GridItem><Input label="提示语" value={itemDraft.lead} onValueChange={(value) => setItemDraft({ ...itemDraft, lead: value })} /></GridItem>
              <GridItem><Input label="答案" value={itemDraft.answer} onValueChange={(value) => setItemDraft({ ...itemDraft, answer: value })} /></GridItem>
              <GridItem><Select label="内容风险" value={itemDraft.contentRisk} items={RISK_ITEMS} onValueChange={(value) => setItemDraft({ ...itemDraft, contentRisk: (value ?? "low") as ItemDraft["contentRisk"] })} /></GridItem>
              <GridItem><Input label="来源修订 ID" value={itemDraft.sourceRevisionId} onValueChange={(value) => setItemDraft({ ...itemDraft, sourceRevisionId: value })} /></GridItem>
              <GridItem><Input label="来源定位" value={itemDraft.sourceLocator} onValueChange={(value) => setItemDraft({ ...itemDraft, sourceLocator: value })} /></GridItem>
              <GridItem><InputArea label="摘要" value={itemDraft.summary} autoResize minRows={3} maxRows={8} onValueChange={(value) => setItemDraft({ ...itemDraft, summary: value })} /></GridItem>
            </Grid>}
            {view === "domains" && <Grid gap="sm"><Input label="名称" value={domainDraft.name} onValueChange={(value) => setDomainDraft({ ...domainDraft, name: value })} /><Input label="Slug" value={domainDraft.slug} onValueChange={(value) => setDomainDraft({ ...domainDraft, slug: value })} /><Select label="上级领域" value={domainDraft.parentId} items={[{ value: "", label: "无上级领域" }, ...domains.filter((domain) => textOf(domain.id) !== textOf(editing?.id)).map((domain) => ({ value: textOf(domain.id), label: textOf(domain.name) }))]} onValueChange={(value) => setDomainDraft({ ...domainDraft, parentId: value ?? "" })} /><InputArea label="说明" value={domainDraft.description} autoResize minRows={3} maxRows={8} onValueChange={(value) => setDomainDraft({ ...domainDraft, description: value })} /></Grid>}
            {view === "sources" && <Grid gap="sm"><Input label="教材名称" value={sourceDraft.title} onValueChange={(value) => setSourceDraft({ ...sourceDraft, title: value })} /><Select label="资料类型" value={sourceDraft.sourceType} items={SOURCE_TYPE_ITEMS} onValueChange={(value) => setSourceDraft({ ...sourceDraft, sourceType: value ?? "book" })} /><Input label="出版方或来源" value={sourceDraft.publisher} onValueChange={(value) => setSourceDraft({ ...sourceDraft, publisher: value })} /><Input label="版本标签" value={sourceDraft.versionLabel} onValueChange={(value) => setSourceDraft({ ...sourceDraft, versionLabel: value })} /><Input label="授权说明" value={sourceDraft.license} onValueChange={(value) => setSourceDraft({ ...sourceDraft, license: value })} /><InputArea label="摘录" value={sourceDraft.excerpt} autoResize minRows={4} maxRows={10} onValueChange={(value) => setSourceDraft({ ...sourceDraft, excerpt: value })} /></Grid>}
            {view === "curricula" && <Grid gap="sm"><Input label="课程编码" value={curriculumDraft.code} onValueChange={(value) => setCurriculumDraft({ ...curriculumDraft, code: value })} /><Input label="课程名称" value={curriculumDraft.name} onValueChange={(value) => setCurriculumDraft({ ...curriculumDraft, name: value })} /><Input label="适龄段" value={curriculumDraft.ageBand} onValueChange={(value) => setCurriculumDraft({ ...curriculumDraft, ageBand: value })} /><InputArea label="课程说明" value={curriculumDraft.description} autoResize minRows={3} maxRows={8} onValueChange={(value) => setCurriculumDraft({ ...curriculumDraft, description: value })} /></Grid>}
            <Button disabled={Boolean(busy) || (view === "items" && (!itemDraft.title.trim() || !itemDraft.objective.trim() || !itemDraft.lead.trim() || !itemDraft.answer.trim() || !itemDraft.ageBand.trim() || (!editing && (!itemDraft.slug.trim() || !itemDraft.domainId))))} onClick={saveEditor}>{busy ? "正在保存…" : editing ? "保存修订" : "创建记录"}</Button>
          </Grid>
        </Dialog>
      </Dialog.Root>
    </Grid>
  );
}
