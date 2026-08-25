import { ConsolePage } from "@/components/console/console-ui";
import { CatalogWorkspace } from "@/components/console/catalog-workspace";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const user = await requirePageUser();
  return (
    <ConsolePage
      title="出版与发布治理"
      description="集中管理书籍、专辑与集合的修订、编排、标签版权、发布包，以及可校验的 JSON 导入导出。"
    >
      <CatalogWorkspace role={user.role} />
    </ConsolePage>
  );
}
