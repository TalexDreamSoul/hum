"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Grid, GridItem, Input, InputArea, Select, Table, Tabs, Text } from "@cloudflare/kumo";
import { ConsoleDrawer, ConsolePagination, ConsoleSection, useConsoleToast } from "@/components/console/console-ui";

type Role = "admin" | "approver" | "uploader";
type Resource = "publications" | "tags" | "rights" | "releases" | "imports";
type View = "catalog" | "rights" | "releases" | "transfer";
type CatalogRow = Record<string, unknown> & { id?: string; title?: string; name?: string; slug?: string; kind?: string; status?: string };
type ListPayload = { items?: CatalogRow[]; page?: number; pageSize?: number; total?: number; error?: string };
type ActionDialog = "create" | "curate" | "reorder" | "submit" | "publish" | "recall" | null;

const VIEW_TABS = [
  { value: "catalog", label: "书籍、专辑、集合" },
  { value: "rights", label: "标签与版权" },
  { value: "releases", label: "发布包" },
  { value: "transfer", label: "导入与导出" },
] as const;

const KIND_ITEMS = [
  { value: "all", label: "全部类型" },
  { value: "book", label: "书籍" },
  { value: "album", label: "专辑" },
  { value: "collection", label: "集合" },
] as const;

const STATUS_ITEMS = [
  { value: "all", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "review", label: "待审核" },
  { value: "published", label: "已发布" },
  { value: "retired", label: "已退役" },
] as const;

const TAG_CATEGORY_ITEMS = [
  { value: "audience", label: "受众" },
  { value: "scene", label: "场景" },
  { value: "theme", label: "主题" },
  { value: "domain", label: "领域" },
  { value: "format", label: "形式" },
] as const;

const IMPORT_KIND_ITEMS = [
  { value: "publication", label: "出版物" },
  { value: "knowledge", label: "知识内容（仅校验）" },
  { value: "media", label: "媒体资产（仅校验）" },
] as const;

const RIGHT_SUBJECT_ITEMS = [
  { value: "source", label: "教材来源" },
  { value: "publication", label: "出版物" },
  { value: "media", label: "媒体资产" },
  { value: "song_spec", label: "歌曲规格" },
] as const;

function textOf(value: unknown, fallback = "—"): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return fallback;
}

function dateOf(value: unknown): string {
  if (value === 0 || value === "0") return "内置";
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(numeric) ? new Date(numeric).toLocaleString("zh-CN") : "—";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

export function CatalogWorkspace({ role }: { role: Role }) {
  const toast = useConsoleToast();
  const [view, setView] = useState<View>("catalog");
  const [rightsMode, setRightsMode] = useState<"tags" | "rights">("tags");
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<(typeof KIND_ITEMS)[number]["value"]>("all");
  const [status, setStatus] = useState<(typeof STATUS_ITEMS)[number]["value"]>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<CatalogRow | null>(null);
  const detailIdRef = useRef("");
  const loadRequestRef = useRef(0);
  const [detailTab, setDetailTab] = useState("revision");
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const [busy, setBusy] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [publicationKind, setPublicationKind] = useState<"book" | "album" | "collection">("book");
  const [itemType, setItemType] = useState("media");
  const [itemId, setItemId] = useState("");
  const [itemLabel, setItemLabel] = useState("");
  const [orderedIds, setOrderedIds] = useState("");
  const [importKind, setImportKind] = useState<(typeof IMPORT_KIND_ITEMS)[number]["value"]>("publication");
  const [importSourceName, setImportSourceName] = useState("");
  const [importText, setImportText] = useState("[]");
  const [importBatchId, setImportBatchId] = useState("");
  const [transferResult, setTransferResult] = useState<CatalogRow | null>(null);
  const [tagSlug, setTagSlug] = useState("");
  const [tagName, setTagName] = useState("");
  const [tagCategory, setTagCategory] = useState<(typeof TAG_CATEGORY_ITEMS)[number]["value"]>("theme");
  const [bindPublicationId, setBindPublicationId] = useState("");
  const [bindTagId, setBindTagId] = useState("");
  const [rightSubjectType, setRightSubjectType] = useState<(typeof RIGHT_SUBJECT_ITEMS)[number]["value"]>("publication");
  const [rightSubjectId, setRightSubjectId] = useState("");
  const [rightHolder, setRightHolder] = useState("");
  const [rightLicense, setRightLicense] = useState("");
  const [rightTerritory, setRightTerritory] = useState("global");
  const [rightStartsAt, setRightStartsAt] = useState("");
  const [rightExpiresAt, setRightExpiresAt] = useState("");
  const [rightEvidence, setRightEvidence] = useState("");

  const resource = useMemo<Resource>(() => {
    if (view === "catalog") return "publications";
    if (view === "rights") return rightsMode;
    if (view === "releases") return "releases";
    return "imports";
  }, [rightsMode, view]);
  const canCreate = role === "admin" || role === "uploader";
  const canManageRights = role === "admin" || role === "approver";
  const canPublish = role === "admin";

  const load = useCallback(async (nextPage = page, selectedId = detailIdRef.current) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const params = new URLSearchParams({ resource, page: String(nextPage), pageSize: String(pageSize) });
      if (resource === "publications" && kind !== "all") params.set("kind", kind);
      if (resource !== "imports" && status !== "all") params.set("status", status);
      if (search.trim()) params.set("search", search.trim());
      const payload = await requestJson<ListPayload>(`/api/admin/catalog?${params.toString()}`);
      if (requestId !== loadRequestRef.current) return null;
      const nextRows = payload.items ?? [];
      setRows(nextRows);
      setPage(payload.page ?? nextPage);
      setPageSize(payload.pageSize ?? pageSize);
      setTotal(payload.total ?? 0);

      const activeSelectedId = detailIdRef.current;
      if (!activeSelectedId) return null;
      const fresh = nextRows.find((row) => textOf(row.id, "") === activeSelectedId) ?? null;
      if (!fresh) {
        detailIdRef.current = "";
        setDetail(null);
        return null;
      }
      setDetail(fresh);
      return fresh;
    } catch (error) {
      if (requestId !== loadRequestRef.current) return null;
      const message = error instanceof Error ? error.message : "未知错误";
      setLoadError(message);
      setRows([]);
      setTotal(0);
      if (selectedId) {
        detailIdRef.current = "";
        setDetail(null);
      }
      return null;
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [kind, page, pageSize, resource, search, status]);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  function resetDialog() {
    setDialog(null);
    setSelectedId("");
    setItemId("");
    setItemLabel("");
    setOrderedIds("");
  }

  function closeDetail() {
    detailIdRef.current = "";
    setDetail(null);
  }

  function openDetail(row: CatalogRow) {
    const id = textOf(row.id, "");
    if (!id || !rows.some((candidate) => textOf(candidate.id, "") === id)) {
      closeDetail();
      toast.error("读取详情失败", "当前列表中没有这个对象，请刷新后重试");
      return;
    }
    detailIdRef.current = id;
    setDetail(row);
    setDetailTab("revision");
  }

  async function act(resourceName: Resource | "publications" | "releases", action: string, payload: Record<string, unknown>, success: string, focusId = "") {
    setBusy(`${resourceName}:${action}`);
    try {
      const result = await requestJson<CatalogRow>("/api/admin/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: resourceName, action, payload }),
      });
      setTransferResult(result);

      const nested = result.publication ?? result.release ?? result.right;
      const record = nested && typeof nested === "object" ? nested as CatalogRow : result;
      const responseId = textOf(record.id, textOf(result.publicationId, textOf(result.releaseId, textOf(result.rightId, ""))));
      const resolvedFocusId = focusId || (resourceName === resource && resourceName !== "imports" ? responseId : "");
      if (resolvedFocusId && resourceName === resource) {
        const revision = result.revision && typeof result.revision === "object" ? result.revision as CatalogRow : null;
        detailIdRef.current = resolvedFocusId;
        setDetail((current) => ({
          ...(current && textOf(current.id, "") === resolvedFocusId ? current : { id: resolvedFocusId }),
          ...record,
          id: resolvedFocusId,
          ...(revision && revision.revision !== undefined ? { currentRevision: revision.revision } : {}),
        }));
      }

      toast.success(success);
      resetDialog();
      await load(resourceName === resource ? 1 : page, resolvedFocusId);
      return result;
    } catch (error) {
      toast.error(`${success}失败`, error instanceof Error ? error.message : "未知错误");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function createPublication() {
    if (!title.trim() || !slug.trim()) {
      toast.error("请填写标题和 slug");
      return;
    }
    const result = await act("publications", "create", {
      kind: publicationKind,
      title: title.trim(),
      slug: slug.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    }, "已创建出版物草稿");
    if (result) {
      setTitle("");
      setSlug("");
      setDescription("");
    }
  }

  async function curatePublication() {
    if (!selectedId || !itemId.trim()) {
      toast.error("请选择出版物并填写内容项标识");
      return;
    }
    const selected = rows.find((row) => textOf(row.id, "") === selectedId);
    if (!selected || textOf(selected.status) !== "draft") {
      toast.error("只有草稿出版物可以编排内容");
      resetDialog();
      return;
    }
    await act("publications", "add-item", { publicationId: selectedId, itemType, itemId: itemId.trim(), ...(itemLabel.trim() ? { label: itemLabel.trim() } : {}) }, "已加入编排项", selectedId);
  }

  async function reorderPublication() {
    if (!selectedId || !orderedIds.trim()) {
      toast.error("请选择出版物并填入排序后的内容项 ID");
      return;
    }
    const itemIds = orderedIds.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    if (!itemIds.length) {
      toast.error("至少需要一个内容项 ID");
      return;
    }
    const selected = rows.find((row) => textOf(row.id, "") === selectedId);
    if (!selected || textOf(selected.status) !== "draft") {
      toast.error("只有草稿出版物可以重排内容");
      resetDialog();
      return;
    }
    await act("publications", "reorder", { publicationId: selectedId, itemIds }, "已保存内容排序", selectedId);
  }

  async function submitPublication() {
    if (!selectedId) return;
    const selected = rows.find((row) => textOf(row.id, "") === selectedId);
    if (!selected || textOf(selected.status) !== "draft") {
      toast.error("只有草稿出版物可以提交审核");
      resetDialog();
      return;
    }
    await act("publications", "submit", { publicationId: selectedId }, "已提交出版审核", selectedId);
  }

  async function publishPublication() {
    if (!selectedId) return;
    const selected = rows.find((row) => textOf(row.id, "") === selectedId);
    if (!selected || textOf(selected.status) !== "review") {
      toast.error("只有待审核出版物可以发布");
      resetDialog();
      return;
    }
    await act("publications", "publish", { publicationId: selectedId }, "出版物已发布", selectedId);
  }

  async function createRelease(publicationId: string) {
    const publication = rows.find((row) => textOf(row.id, "") === publicationId);
    if (!publication || textOf(publication.status) !== "published") {
      toast.error("只能为已发布出版物创建发布包");
      return;
    }
    await act("releases", "create", { publicationId }, "已创建发布包", publicationId);
  }

  async function createTag() {
    if (!tagSlug.trim() || !tagName.trim()) {
      toast.error("请填写标签 slug 和名称");
      return;
    }
    if (await act("tags", "create", { slug: tagSlug.trim(), name: tagName.trim(), category: tagCategory }, "已创建标签")) {
      setTagSlug("");
      setTagName("");
    }
  }

  async function bindTag() {
    if (!bindPublicationId.trim() || !bindTagId.trim()) {
      toast.error("请填写出版物 ID 和标签 ID");
      return;
    }
    await act("tags", "bind", { publicationId: bindPublicationId.trim(), tagId: bindTagId.trim() }, "已绑定标签");
  }

  async function createRight() {
    if (!rightSubjectId.trim() || !rightHolder.trim() || !rightLicense.trim() || !rightEvidence.trim()) {
      toast.error("请填写版权主体、权利人、许可证和证据");
      return;
    }
    const startsAt = rightStartsAt.trim() ? Number(rightStartsAt) : undefined;
    const expiresAt = rightExpiresAt.trim() ? Number(rightExpiresAt) : undefined;
    if ((startsAt !== undefined && (!Number.isInteger(startsAt) || startsAt < 0)) || (expiresAt !== undefined && (!Number.isInteger(expiresAt) || expiresAt < 0))) {
      toast.error("生效与到期时间必须是非负毫秒时间戳");
      return;
    }
    if (startsAt !== undefined && expiresAt !== undefined && expiresAt <= startsAt) {
      toast.error("到期时间必须晚于生效时间");
      return;
    }
    if (await act("rights", "create", {
      subjectType: rightSubjectType,
      subjectId: rightSubjectId.trim(),
      holder: rightHolder.trim(),
      license: rightLicense.trim(),
      territory: rightTerritory.trim() || "global",
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      evidence: rightEvidence.trim(),
    }, "已登记版权记录")) {
      setRightSubjectId("");
      setRightHolder("");
      setRightLicense("");
      setRightTerritory("global");
      setRightStartsAt("");
      setRightExpiresAt("");
      setRightEvidence("");
    }
  }

  async function revokeRight(id: string) {
    const right = rows.find((row) => textOf(row.id, "") === id);
    if (!right || textOf(right.status) !== "valid") {
      toast.error("只有有效版权授权可以撤销");
      return;
    }
    await act("rights", "revoke", { rightId: id }, "已撤销版权记录", id);
  }

  async function publishRelease() {
    if (!selectedId) return;
    const release = rows.find((row) => textOf(row.id, "") === selectedId);
    const releaseStatus = textOf(release?.status);
    if (!release || (releaseStatus !== "draft" && releaseStatus !== "review")) {
      toast.error("只有草稿或待审核发布包可以上线");
      resetDialog();
      return;
    }
    await act("releases", "release", { releaseId: selectedId }, "发布包已上线", selectedId);
  }

  async function recallRelease() {
    if (!selectedId) return;
    const release = rows.find((row) => textOf(row.id, "") === selectedId);
    if (!release || textOf(release.status) !== "released") {
      toast.error("只有已上线发布包可以召回");
      resetDialog();
      return;
    }
    await act("releases", "recall", { releaseId: selectedId }, "发布包已召回", selectedId);
  }

  async function importData(action: "validate" | "import") {
    if (action === "import") {
      if (!importBatchId.trim()) {
        toast.error("请先校验 JSON 并取得导入批次 ID");
        return;
      }
      await act("imports", "import", { batchId: importBatchId.trim() }, "导入批次已提交");
      return;
    }
    if (!importSourceName.trim()) {
      toast.error("请填写导入来源名称");
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(importText);
    } catch {
      toast.error("导入 JSON 无法解析");
      return;
    }
    const result = await act("imports", "validate", { importKind, sourceName: importSourceName.trim(), data }, "导入内容校验完成");
    const batch = result?.batch;
    if (batch && typeof batch === "object") setImportBatchId(textOf((batch as CatalogRow).id, ""));
  }

  async function exportRelease(releaseId: string, action: "preview" | "export") {
    setBusy(`releases:${action}`);
    try {
      const result = await requestJson<CatalogRow>("/api/admin/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "releases", action, payload: { releaseId } }),
      });
      setTransferResult(result);
      const json = JSON.stringify(result, null, 2);
      if (action === "export") {
        const href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = `catalog-release-${releaseId}.json`;
        anchor.click();
        URL.revokeObjectURL(href);
        toast.success("发布包 JSON 已下载");
      } else {
        await navigator.clipboard.writeText(json);
        toast.success("发布包清单已复制");
      }
    } catch (error) {
      toast.error(action === "export" ? "导出发布包失败" : "复制清单失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setBusy("");
    }
  }

  const publicationOptions = rows
    .filter((row) => resource === "publications")
    .map((row) => ({ value: textOf(row.id, ""), label: `${textOf(row.title, textOf(row.name, "未命名"))} · ${textOf(row.slug, "无 slug")}` }))
    .filter((item) => item.value);

  return (
    <Grid gap="base">
      <Banner variant="default" title="出版治理工作台" description="自动项只能预筛和留痕；提交、发布、召回均由有权限的人工角色触发。" />
      <Tabs variant="underline" value={view} onValueChange={(value) => { closeDetail(); resetDialog(); setView(value as View); setPage(1); }} tabs={[...VIEW_TABS]} />

      {view === "catalog" && (
        <ConsoleSection title="书籍、专辑、集合" status={canCreate ? <Button size="sm" onClick={() => setDialog("create")}>创建出版物</Button> : <Badge variant="neutral">只读</Badge>}>
          <Grid gap="sm">
            <Grid variant="2up" gap="sm">
              <GridItem><Select label="出版类型" value={kind} items={[...KIND_ITEMS]} onValueChange={(value) => { setKind(value ?? "all"); setPage(1); }} /></GridItem>
              <GridItem><Select label="状态" value={status} items={[...STATUS_ITEMS]} onValueChange={(value) => { setStatus(value ?? "all"); setPage(1); }} /></GridItem>
            </Grid>
            <Input label="搜索标题或 slug" value={search} onValueChange={(value) => { setSearch(value); setPage(1); }} />
            <Table>
              <thead><tr><th>出版物</th><th>类型</th><th>修订</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                {rows.map((row) => <tr key={textOf(row.id, textOf(row.slug))}>
                  <td><Text bold>{textOf(row.title, textOf(row.name, "未命名"))}</Text><Text variant="secondary">{textOf(row.slug)}</Text></td>
                  <td>{textOf(row.kind)}</td><td>v{textOf(row.currentRevision, textOf(row.revision, "1"))}</td>
                  <td><Badge variant={textOf(row.status) === "published" ? "success" : "neutral"}>{textOf(row.status)}</Badge></td>
                  <td>{dateOf(row.updatedAt ?? row.createdAt)}</td>
                  <td><Grid variant="2up" gap="sm"><GridItem><Button size="sm" variant="secondary" onClick={() => openDetail(row)}>详情</Button></GridItem>{canCreate && textOf(row.status) === "draft" && <GridItem><Button size="sm" variant="ghost" onClick={() => { setSelectedId(textOf(row.id, "")); setDialog("curate"); }}>编排草稿</Button></GridItem>}{canPublish && textOf(row.status) === "published" && <GridItem><Button size="sm" variant="ghost" onClick={() => createRelease(textOf(row.id, ""))}>创建发布包</Button></GridItem>}</Grid></td>
                </tr>)}
                {!loading && !rows.length && <tr><td colSpan={6}><Text variant="secondary">还没有出版物。创建书籍、专辑或集合后，再从详情中提交、发布并建立发布包。</Text></td></tr>}
              </tbody>
            </Table>
          </Grid>
        </ConsoleSection>
      )}

      {view === "rights" && (
        <ConsoleSection title="标签与版权" status={<Badge variant="info">权利记录可审计</Badge>}>
          <Grid gap="sm">
            <Tabs variant="underline" value={rightsMode} onValueChange={(value) => { setRightsMode(value as "tags" | "rights"); setPage(1); }} tabs={[{ value: "tags", label: "标签" }, { value: "rights", label: "版权" }]} />
            <Input label="搜索标签、主体或许可证" value={search} onValueChange={(value) => { setSearch(value); setPage(1); }} />
            {rightsMode === "tags" && canManageRights && <Grid variant="2up" gap="sm"><GridItem><Input label="标签 slug" value={tagSlug} onValueChange={setTagSlug} /></GridItem><GridItem><Input label="标签名称" value={tagName} onValueChange={setTagName} /></GridItem><GridItem><Select label="标签分类" value={tagCategory} items={[...TAG_CATEGORY_ITEMS]} onValueChange={(value) => value && setTagCategory(value)} /></GridItem><GridItem><Button disabled={busy === "tags:create"} onClick={createTag}>创建标签</Button></GridItem><GridItem><Input label="出版物 ID" value={bindPublicationId} onValueChange={setBindPublicationId} /></GridItem><GridItem><Input label="标签 ID" value={bindTagId} onValueChange={setBindTagId} /></GridItem><GridItem><Button variant="secondary" disabled={busy === "tags:bind"} onClick={bindTag}>绑定出版物</Button></GridItem></Grid>}
            {rightsMode === "rights" && canManageRights && <Grid variant="2up" gap="sm"><GridItem><Select label="主体类型" value={rightSubjectType} items={[...RIGHT_SUBJECT_ITEMS]} onValueChange={(value) => value && setRightSubjectType(value)} /></GridItem><GridItem><Input label="主体 ID" value={rightSubjectId} onValueChange={setRightSubjectId} /></GridItem><GridItem><Input label="权利人" value={rightHolder} onValueChange={setRightHolder} /></GridItem><GridItem><Input label="许可证" value={rightLicense} onValueChange={setRightLicense} /></GridItem><GridItem><Input label="适用地域" value={rightTerritory} onValueChange={setRightTerritory} /></GridItem><GridItem><Input label="生效时间戳（毫秒，可选）" value={rightStartsAt} onValueChange={setRightStartsAt} /></GridItem><GridItem><Input label="到期时间戳（毫秒，可选）" value={rightExpiresAt} onValueChange={setRightExpiresAt} /></GridItem><GridItem><InputArea label="权利证据" description="填写合同、授权函或来源说明；服务端仅保存内容哈希。" value={rightEvidence} onValueChange={setRightEvidence} minRows={3} maxRows={8} /></GridItem><GridItem><Button disabled={busy === "rights:create" || !rightSubjectId.trim() || !rightHolder.trim() || !rightLicense.trim() || !rightEvidence.trim()} onClick={createRight}>登记版权</Button></GridItem></Grid>}
            <Table>
              <thead><tr><th>{rightsMode === "tags" ? "标签" : "版权主体"}</th><th>{rightsMode === "tags" ? "Slug" : "许可证"}</th><th>状态</th><th>{rightsMode === "tags" ? "创建时间" : "到期"}</th><th>操作</th></tr></thead>
              <tbody>
                {rows.map((row) => <tr key={textOf(row.id, textOf(row.slug))}><td><Text bold>{textOf(row.name, textOf(row.subjectId, textOf(row.slug, "未命名")))}</Text><Text variant="secondary">{textOf(row.subjectType, textOf(row.kind))}</Text></td><td>{rightsMode === "tags" ? textOf(row.slug) : textOf(row.license)}</td><td>{textOf(row.status)}</td><td>{rightsMode === "tags" ? dateOf(row.createdAt) : dateOf(row.expiresAt)}</td><td><Grid variant="2up" gap="sm"><GridItem><Button size="sm" variant="secondary" onClick={() => openDetail(row)}>详情</Button></GridItem>{rightsMode === "rights" && canPublish && textOf(row.status) === "valid" && <GridItem><Button size="sm" variant="ghost" disabled={busy === "rights:revoke"} onClick={() => revokeRight(textOf(row.id, ""))}>撤销有效授权</Button></GridItem>}</Grid></td></tr>)}
                {!loading && !rows.length && <tr><td colSpan={5}><Text variant="secondary">{rightsMode === "tags" ? "暂无标签。先创建标签，再绑定到出版物。" : "暂无版权记录。登记许可证与到期时间后，可在出版详情追溯。"}</Text></td></tr>}
              </tbody>
            </Table>
          </Grid>
        </ConsoleSection>
      )}

      {view === "releases" && (
        <ConsoleSection title="发布包" status={canPublish ? <Badge variant="success">管理员可发布与召回</Badge> : <Badge variant="neutral">可查看清单</Badge>}>
          <Grid gap="sm">
            <Input label="搜索发布包或出版物" value={search} onValueChange={(value) => { setSearch(value); setPage(1); }} />
            <Table>
              <thead><tr><th>发布包</th><th>出版物</th><th>状态</th><th>生成时间</th><th>操作</th></tr></thead>
              <tbody>
                {rows.map((row) => <tr key={textOf(row.id, textOf(row.releaseId))}><td><Text bold>{textOf(row.id, textOf(row.releaseId, "未命名"))}</Text></td><td>{textOf(row.publicationTitle, textOf(row.publicationId))}</td><td><Badge variant={textOf(row.status) === "released" ? "success" : "neutral"}>{textOf(row.status)}</Badge></td><td>{dateOf(row.createdAt)}</td><td><Grid variant="2up" gap="sm"><GridItem><Button size="sm" variant="secondary" onClick={() => openDetail(row)}>详情</Button></GridItem><GridItem><Button size="sm" variant="ghost" disabled={busy === "releases:preview"} onClick={() => exportRelease(textOf(row.id, ""), "preview")}>复制清单</Button></GridItem><GridItem><Button size="sm" variant="ghost" disabled={busy === "releases:export"} onClick={() => exportRelease(textOf(row.id, ""), "export")}>导出</Button></GridItem>{canPublish && (textOf(row.status) === "draft" || textOf(row.status) === "review") && <GridItem><Button size="sm" onClick={() => { setSelectedId(textOf(row.id, "")); setDialog("publish"); }}>上线发布包</Button></GridItem>}{canPublish && textOf(row.status) === "released" && <GridItem><Button size="sm" variant="secondary" onClick={() => { setSelectedId(textOf(row.id, "")); setDialog("recall"); }}>召回发布包</Button></GridItem>}</Grid></td></tr>)}
                {!loading && !rows.length && <tr><td colSpan={5}><Text variant="secondary">暂无发布包。管理员可从出版物列表创建发布包，再在此处检查 manifest、导出或上线。</Text></td></tr>}
              </tbody>
            </Table>
          </Grid>
        </ConsoleSection>
      )}

      {view === "transfer" && (
        <ConsoleSection title="导入与导出" status={<Badge variant="info">先校验，再导入</Badge>}>
          <Grid gap="sm">
            <Grid variant="2up" gap="sm"><GridItem><Select label="导入类型" value={importKind} items={[...IMPORT_KIND_ITEMS]} onValueChange={(value) => { if (value) { setImportKind(value); setImportBatchId(""); } }} /></GridItem><GridItem><Input label="导入来源名称" value={importSourceName} onValueChange={(value) => { setImportSourceName(value); setImportBatchId(""); }} /></GridItem></Grid>
            <InputArea label="待校验 JSON" description="先按类型和来源校验 JSON；校验成功后会自动填入批次 ID。只有出版物批次可继续导入。" value={importText} onValueChange={(value) => { setImportText(value); setImportBatchId(""); }} minRows={12} maxRows={24} />
            <Input label="已校验批次 ID" value={importBatchId} onValueChange={setImportBatchId} />
            <Grid variant="2up" gap="sm"><GridItem><Button variant="secondary" disabled={Boolean(busy) || !importSourceName.trim()} onClick={() => importData("validate")}>校验并创建批次</Button></GridItem>{canCreate && <GridItem><Button disabled={Boolean(busy) || !importBatchId.trim() || importKind !== "publication"} onClick={() => importData("import")}>{importKind === "publication" ? "导入已校验批次为草稿" : "当前类型仅支持校验"}</Button></GridItem>}</Grid>
            {transferResult && <Text variant="mono-secondary">最近结果：{JSON.stringify(transferResult)}</Text>}
          </Grid>
        </ConsoleSection>
      )}

      {loading && <Banner variant="default" title="正在读取出版数据…" />}
      {loadError && <Banner variant="alert" title="读取出版数据失败" description={loadError} />}
      <ConsolePagination page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />

      <ConsoleDrawer open={Boolean(detail)} onOpenChange={(open) => { if (!open) closeDetail(); }} title={textOf(detail?.title, textOf(detail?.name, "出版详情"))} description={detail ? `${textOf(detail.kind)} · ${textOf(detail.status)}` : undefined}>
        {detail && <Grid gap="base">
          <Tabs variant="underline" value={detailTab} onValueChange={setDetailTab} tabs={[{ value: "revision", label: "修订" }, { value: "items", label: "内容项" }, { value: "rights", label: "标签与版权" }, { value: "manifest", label: "发布清单" }]} />
          {detailTab === "revision" && <ConsoleSection title="Revision"><Table><tbody><tr><th>标识</th><td>{textOf(detail.id)}</td></tr><tr><th>版本</th><td>v{textOf(detail.currentRevision, textOf(detail.revision, "1"))}</td></tr><tr><th>说明</th><td>{textOf(detail.description)}</td></tr><tr><th>更新时间</th><td>{dateOf(detail.updatedAt ?? detail.createdAt)}</td></tr></tbody></Table></ConsoleSection>}
          {detailTab === "items" && <ConsoleSection title="Items"><Text variant="mono-secondary">{JSON.stringify(detail.items ?? detail.itemIds ?? [], null, 2)}</Text></ConsoleSection>}
          {detailTab === "rights" && <ConsoleSection title="Tags & rights"><Text variant="mono-secondary">{JSON.stringify({ tags: detail.tags ?? [], rights: detail.rights ?? [] }, null, 2)}</Text></ConsoleSection>}
          {detailTab === "manifest" && <ConsoleSection title="Manifest"><Text variant="mono-secondary">{JSON.stringify(detail.manifest ?? detail, null, 2)}</Text></ConsoleSection>}
          {resource === "publications" && canCreate && textOf(detail.status) === "draft" && <Grid variant="2up" gap="sm"><GridItem><Button variant="secondary" onClick={() => { setSelectedId(textOf(detail.id, "")); setDialog("curate"); }}>编排草稿内容</Button></GridItem><GridItem><Button variant="secondary" onClick={() => { setSelectedId(textOf(detail.id, "")); setDialog("reorder"); }}>重排草稿内容</Button></GridItem></Grid>}
          {resource === "publications" && canCreate && textOf(detail.status) === "draft" && <Button onClick={() => { setSelectedId(textOf(detail.id, "")); setDialog("submit"); }}>提交出版审核</Button>}
          {resource === "publications" && canPublish && textOf(detail.status) === "review" && <Button onClick={() => { setSelectedId(textOf(detail.id, "")); setDialog("publish"); }}>发布已审核出版物</Button>}{resource === "publications" && canPublish && textOf(detail.status) === "published" && <Button variant="secondary" onClick={() => createRelease(textOf(detail.id, ""))}>为已发布版本创建发布包</Button>}
        </Grid>}
      </ConsoleDrawer>

      <ConsoleDrawer open={dialog === "create"} onOpenChange={(open) => { if (!open) resetDialog(); }} title="创建出版物" description="创建书籍、专辑或集合草稿；发布前仍需人工提交与审核。">
        <Grid gap="sm"><Select label="类型" value={publicationKind} items={KIND_ITEMS.slice(1)} onValueChange={(value) => setPublicationKind(value === "album" || value === "collection" ? value : "book")} /><Input label="标题" value={title} onValueChange={setTitle} /><Input label="slug" value={slug} onValueChange={setSlug} /><InputArea label="说明（可选）" value={description} onValueChange={setDescription} minRows={3} /><Button disabled={busy === "publications:create"} onClick={createPublication}>创建草稿</Button></Grid>
      </ConsoleDrawer>

      <ConsoleDrawer open={dialog === "curate"} onOpenChange={(open) => { if (!open) resetDialog(); }} title="编排内容" description="向出版物加入一个已存在的内容项；系统只保存编排关系和留痕。">
        <Grid gap="sm"><Select label="出版物" value={selectedId} items={publicationOptions} onValueChange={(value) => setSelectedId(value ?? "")} /><Input label="内容项类型" value={itemType} onValueChange={setItemType} /><Input label="内容项 ID" value={itemId} onValueChange={setItemId} /><Input label="显示名称（可选）" value={itemLabel} onValueChange={setItemLabel} /><Button disabled={busy === "publications:add-item"} onClick={curatePublication}>加入编排</Button></Grid>
      </ConsoleDrawer>

      <ConsoleDrawer open={dialog === "reorder"} onOpenChange={(open) => { if (!open) resetDialog(); }} title="重排内容" description="按换行或逗号输入排序后的完整内容项 ID 列表。">
        <Grid gap="sm"><Select label="出版物" value={selectedId} items={publicationOptions} onValueChange={(value) => setSelectedId(value ?? "")} /><InputArea label="内容项 ID 顺序" value={orderedIds} onValueChange={setOrderedIds} minRows={6} /><Button disabled={busy === "publications:reorder"} onClick={reorderPublication}>保存排序</Button></Grid>
      </ConsoleDrawer>

      <ConsoleDrawer open={dialog === "submit"} onOpenChange={(open) => { if (!open) resetDialog(); }} title="提交出版审核" description="提交会产生可审计的人工流程记录，自动预筛不能直接发布。"><Grid gap="sm"><Text>确认将此出版物提交给审核人？</Text><Button disabled={busy === "publications:submit"} onClick={submitPublication}>确认提交</Button></Grid></ConsoleDrawer>
      <ConsoleDrawer open={dialog === "publish"} onOpenChange={(open) => { if (!open) resetDialog(); }} title="发布" description="仅管理员可执行。发布后会以当前修订与权利状态为准。"><Grid gap="sm"><Text>确认执行发布？</Text><Button disabled={Boolean(busy)} onClick={() => resource === "releases" ? publishRelease() : publishPublication()}>确认发布</Button></Grid></ConsoleDrawer>
      <ConsoleDrawer open={dialog === "recall"} onOpenChange={(open) => { if (!open) resetDialog(); }} title="召回发布包" description="召回会停止该发布包的对外可用状态，但保留可审计的 manifest。"><Grid gap="sm"><Text>确认召回此发布包？</Text><Button disabled={busy === "releases:recall"} onClick={recallRelease}>确认召回</Button></Grid></ConsoleDrawer>
    </Grid>
  );
}
