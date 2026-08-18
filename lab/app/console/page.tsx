import { Badge, Banner, Grid, GridItem, Link, Table, Text } from "@cloudflare/kumo";
import { ConsolePage, ConsoleSection, MetricCard } from "@/components/console/console-ui";
import { requirePageUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/database";
import { getMaskedProviderSettings } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

export default async function ConsolePageRoute() {
  const user = await requirePageUser();
  const db = getDb();
  const counts = await db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'uploaded' THEN 1 ELSE 0 END) AS uploaded,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
    FROM songs
  `).get() as { total: number; uploaded: number | null; approved: number | null };
  const settings = await getMaskedProviderSettings();

  return (
    <ConsolePage
      title="内容后台"
      description="从七牛直传入库开始；文件不经过应用服务器。第三方登录只允许在个人资料中主动绑定。"
    >
      <Grid variant="3up" gap="sm">
        <GridItem><MetricCard label="歌曲" value={counts.total} /></GridItem>
        <GridItem><MetricCard label="待处理" value={counts.uploaded ?? 0} /></GridItem>
        <GridItem><MetricCard label="已通过" value={counts.approved ?? 0} /></GridItem>
      </Grid>
      {user.role === "admin" && (!settings.qiniu.ready || !settings.feishu.ready) && (
        <Banner
          variant="alert"
          title="外部服务尚未全部就绪"
          description="七牛用于直传与私有播放；飞书用于已绑定用户快捷登录。两者都从后台配置，密钥加密落库。"
        />
      )}
      <ConsoleSection title="外部服务">
        <Table>
          <tbody>
            <tr>
              <td><Text bold>七牛</Text></td>
              <td>{settings.qiniu.ready ? <Badge variant="success">已就绪</Badge> : <Badge variant="warning">待配置</Badge>}</td>
              <td>{user.role === "admin" && <Link href="/console/settings">配置</Link>}</td>
            </tr>
            <tr>
              <td><Text bold>飞书</Text></td>
              <td>{settings.feishu.ready ? <Badge variant="success">已就绪</Badge> : <Badge variant="neutral">未启用</Badge>}</td>
              <td><Link href="/console/profile">身份关联</Link></td>
            </tr>
          </tbody>
        </Table>
      </ConsoleSection>
    </ConsolePage>
  );
}
