import type { Metadata } from "next";
import { Badge, Banner, Table } from "@cloudflare/kumo";
import { DocPage, DocSection, ResearchNav } from "@/components/doc";

export const metadata: Metadata = { title: "数据分析平台选型 — hum" };

const Dim = ({ children }: { children: React.ReactNode }) => <span className="text-kumo-subtle">{children}</span>;
const Yes = () => <Badge variant="success">能</Badge>;
const No = () => <Badge variant="neutral">不能</Badge>;

export default function Page() {
  return (
    <DocPage
      kicker="hum · 调研 · 2026-08-12"
      title="数据分析平台选型"
      lede="能直接回答「是不是买量」的只有两类工具：广告投放监测，和活跃留存数据。榜单和下载量都不能证伪。"
    >
      <DocSection title="先说方法">
        <p className="m-0 text-sm" style={{ maxWidth: "40rem" }}>
          调研里的规模数字全是厂商口径或粗代理——凯叔「7000 万家庭」、Cocomelon「2200 亿播放」、App Store 评分数。
          这些都不能区分「真有人在用」和「花钱买来的」。
        </p>
        <div className="mt-2 overflow-x-auto">
          <Table>
            <thead><tr><th>指标</th><th>能否分辨买量</th><th>说明</th></tr></thead>
            <tbody>
              <tr><td>榜单排名</td><td><No /></td><td>买量最直接的产出就是排名，用它证明真实是循环论证</td></tr>
              <tr><td>累计下载量</td><td><No /></td><td>同上</td></tr>
              <tr><td>评分数 / 评论数</td><td><Badge variant="warning">部分</Badge></td><td>数量不行，但评论的<strong>时间分布和模板化程度</strong>能看出刷评</td></tr>
              <tr><td><strong>下载量 ÷ DAU</strong></td><td><Yes /></td><td>买量的应用下载高、活跃低，差距明显</td></tr>
              <tr><td><strong>DAU / MAU 粘性比</strong></td><td><Yes /></td><td>越接近 1 越健康，买量用户拉不高这个比</td></tr>
              <tr><td><strong>次日 / 7 日 / 30 日留存</strong></td><td><Yes /></td><td>买量用户初期快速流失，曲线陡降</td></tr>
              <tr><td><strong>广告素材投放量</strong></td><td><Yes /></td><td>最直接——看它在哪些渠道投了多少素材</td></tr>
              <tr><td>榜单排名突变</td><td><Yes /></td><td>短期冲高后快速回落，是买量的典型形状</td></tr>
              <tr><td>自然搜索 vs 付费流量占比</td><td><Yes /></td><td>网站侧用 SimilarWeb 看</td></tr>
            </tbody>
          </Table>
        </div>
        <div className="mt-3">
          <Banner variant="default" title="只有「投放监测」和「活跃留存」两类数据能给出结论，其余都只是佐证。" />
        </div>
      </DocSection>

      <DocSection title="国内平台">
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>平台</th><th>能查什么</th><th>价格</th></tr></thead>
            <tbody>
              <tr><td><strong>App Growing</strong><br /><Dim>appgrowing.cn</Dim></td><td><strong>广告买量分析</strong>——实时追踪 80+ 国内流量媒体，收录 11 亿+ 广告素材，可看竞品投放渠道占比和素材策略</td><td><Dim>未拿到</Dim></td></tr>
              <tr><td><strong>点点数据</strong><br /><Dim>diandian.com</Dim></td><td>App Store、Google Play、TapTap 和国内九大安卓市场；<strong>含市场份额、下载/收入、用户活跃</strong></td><td>有免费试用<br /><Dim>价格未公开</Dim></td></tr>
              <tr><td><strong>七麦数据</strong><br /><Dim>qimai.cn</Dim></td><td>实时排名、ASO 关键词、下载量预估、<strong>评论分析</strong>、竞品追踪</td><td>有免费试用<br /><Dim>VIP 价格未公开</Dim></td></tr>
              <tr><td><strong>蝉大师</strong><br /><Dim>chandashi.com</Dim></td><td>180 万 iOS + 400 万安卓应用，机器实时抓商店页</td><td><Dim>未拿到</Dim></td></tr>
              <tr><td><strong>QuestMobile / 易观千帆</strong></td><td>行业级 MAU/DAU、用户重合度、行业报告</td><td><Dim>企业级，贵</Dim></td></tr>
            </tbody>
          </Table>
        </div>
        <div className="mt-3">
          <Banner variant="default" title="组合建议：App Growing 看有没有在猛投 + 点点数据看活跃和留存，两者交叉就能定性。" description="七麦用来看评论时间分布，识别刷评。" />
        </div>
      </DocSection>

      <DocSection title="海外平台">
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>平台</th><th>能查什么</th><th>价格</th></tr></thead>
            <tbody>
              <tr><td><strong>Sensor Tower</strong></td><td>下载、收入估算、使用时长、<strong>广告情报</strong>；已并购 data.ai，事实垄断</td><td><strong>无免费层，报价制</strong><br />$30,000–150,000+/年，中位买家 $74K/年</td></tr>
              <tr><td><strong>Appfigures</strong></td><td>下载、收入、排名、关键词</td><td><strong>有免费版</strong>，付费 $9.99 起/月</td></tr>
              <tr><td><strong>AppMagic / Apptopia</strong></td><td>中端替代品，同类数据</td><td><Dim>报价制，比 Sensor Tower 便宜</Dim></td></tr>
              <tr><td><strong>GetAppNiche</strong></td><td>免费层可用，Pro 含收入估算</td><td>免费层 + <strong>Pro $39/月</strong></td></tr>
              <tr><td><strong>SimilarWeb</strong></td><td>网站流量、<strong>自然搜索 vs 付费占比</strong>、渠道构成</td><td>有免费层</td></tr>
            </tbody>
          </Table>
        </div>
        <p className="mt-2 text-sm" style={{ maxWidth: "40rem" }}>
          预算有限就用 <strong>Appfigures 免费版 + GetAppNiche Pro（$39/月）</strong>。Sensor Tower 只在需要广告情报且预算充足时才值得。
        </p>
      </DocSection>

      <DocSection title="YouTube 与音乐流媒体">
        <p className="m-0 mb-2 text-sm">Cocomelon、Pinkfong、Super Simple Songs 的主战场在 YouTube 和流媒体，App 工具查不到。</p>
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>平台</th><th>能查什么</th><th>价格</th></tr></thead>
            <tbody>
              <tr><td><strong>Social Blade</strong></td><td>YouTube 频道订阅/播放历史曲线，<strong>看增长是否平滑</strong>——突刺通常是买量或推荐爆发</td><td><strong>免费</strong></td></tr>
              <tr><td><strong>Playboard</strong></td><td>YouTube 频道数据、收益估算</td><td>有免费层</td></tr>
              <tr><td><strong>vidIQ</strong></td><td>频道与视频级数据、关键词</td><td>有免费层</td></tr>
              <tr><td><strong>Chartmetric</strong></td><td>流媒体播放、歌单收录、社交增长</td><td>约 $40/月起</td></tr>
              <tr><td><strong>Soundcharts</strong></td><td>歌单追踪、趋势告警</td><td><strong>$10/月起，有免费层</strong></td></tr>
            </tbody>
          </Table>
        </div>
        <p className="mt-2 text-xs text-kumo-subtle">这几家都没有公开宣称能检测「刷播放」。判断要靠形状——增长曲线是否平滑、播放来源是歌单推送还是自然搜索。</p>
      </DocSection>

      <DocSection title="具体到我们的竞品，该查什么">
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>要验证的数字</th><th>用什么</th><th>看什么</th></tr></thead>
            <tbody>
              <tr><td>凯叔「7000 万家庭」</td><td>点点数据 / QuestMobile</td><td>DAU、DAU/MAU、留存曲线；和 7000 万差多少个数量级</td></tr>
              <tr><td>洪恩识字 142 万评分数</td><td>七麦</td><td>评论时间分布是否集中、文本是否模板化</td></tr>
              <tr><td>斑马 AI 学「年收入 10 亿」</td><td>点点数据 + App Growing</td><td>收入估算对照；同时看投放强度，判断获客成本</td></tr>
              <tr><td>Cocomelon / Pinkfong 播放量</td><td>Social Blade</td><td>订阅与播放增长曲线是否平滑</td></tr>
              <tr><td>Pinna / Yoto / Mussila 规模</td><td>Appfigures 免费版</td><td>下载趋势、排名历史</td></tr>
              <tr className="bg-kumo-elevated"><td><strong>tonies</strong></td><td><strong>不需要工具</strong></td><td>已上市，投资者关系页的财报是最硬的数据</td></tr>
            </tbody>
          </Table>
        </div>
      </DocSection>

      <DocSection title="边界">
        <p className="m-0 text-xs text-kumo-subtle" style={{ maxWidth: "40rem" }}>
          七麦、点点数据、蝉大师、App Growing 的具体价格官网未公开，需注册或询价。
          所有第三方平台的下载量和收入都是<strong>估算</strong>——不同平台对同一 App 可差数倍（实测七麦与点点对同一天差 2.2 倍）。
          Sensor Tower 价格区间来自第三方分析文章。没有任何平台公开宣称能可靠检测刷量——「买量与否」是多指标交叉推断的定性判断。
        </p>
      </DocSection>

      <ResearchNav current="/analytics" />
    </DocPage>
  );
}
