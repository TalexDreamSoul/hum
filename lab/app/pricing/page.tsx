import type { Metadata } from "next";
import { Banner, Table } from "@cloudflare/kumo";
import { DocPage, DocSection, Dt, Dd, ResearchNav } from "@/components/doc";

export const metadata: Metadata = { title: "竞品内容与变现模式 — hum" };

const Dim = ({ children }: { children: React.ReactNode }) => <span className="text-kumo-subtle">{children}</span>;

export default function Page() {
  return (
    <DocPage
      kicker="hum · 调研 · 2026-08-12"
      title="竞品内容与变现模式"
      lede="纯音频儿童内容的价格天花板是 5–8 美元一个月，国内年卡 178–298 元，而且免费竞品把地板砸穿了。这个价格带养不活人工采编的内容库。"
    >
      <DocSection title="只看产品怎么卖内容">
        <p className="m-0 text-sm" style={{ maxWidth: "40rem" }}>
          「赛道格局」看的是公司；这份只看三件事：卖什么内容、怎么收钱、收多少。硬件生意、护城河、公司战略一律不谈。
        </p>
      </DocSection>

      <DocSection title="海外 · 定价与内容量">
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>产品</th><th>价格</th><th>内容量</th><th>形态与变现</th></tr></thead>
            <tbody>
              <tr><td><strong>Yoto Club</strong></td><td><strong>从 $4.99/月</strong><br /><Dim>两周试用</Dim></td><td>应用内 150+ 小时，200+ 自制 Originals，850+ 卡片数字库</td><td>数字订阅 + 每月额度折价买实体卡</td></tr>
              <tr><td><strong>Pinna</strong></td><td><strong>$5.99/月</strong>（年付）<br />$7.99/月，7 天试用</td><td><strong>400+ 小时</strong></td><td>纯音频，3–12 岁，无屏幕、无广告、无内购</td></tr>
              <tr><td><strong>Mussila</strong></td><td><strong>$7.99/月</strong> · $47.99/年</td><td>音乐理论、听力、演唱</td><td>音乐学习，学校 + 消费者双轨</td></tr>
              <tr><td><strong>Lingokids</strong></td><td><strong>$13.49/月</strong><br /><Dim>原价 $14.99</Dim></td><td>1200+ 互动活动</td><td>综合学习，含歌曲</td></tr>
              <tr><td><strong>ABCmouse</strong></td><td><strong>$14.99/月</strong> · $45/年</td><td>完整课程体系</td><td>综合学习</td></tr>
              <tr><td><strong>Epic!</strong></td><td><Dim>确切价未拿到</Dim></td><td><strong>40,000+ 本</strong>书 / 视频 / 有声书</td><td>Epic School 对教师免费，用校内做获客</td></tr>
              <tr><td><strong>Super Simple Songs</strong></td><td>应用内订阅去广告</td><td>多档动画 + 原创音乐</td><td><strong>五路并行</strong>：订阅、广告、周边、授权、流媒体分发</td></tr>
              <tr><td><strong>Khan Academy Kids</strong></td><td><strong>完全免费，零广告</strong></td><td>2–8 岁完整体系</td><td>非营利，靠捐赠</td></tr>
            </tbody>
          </Table>
        </div>
        <div className="mt-3">
          <Banner
            variant="default"
            title="价格带的结构非常清楚：纯音频 $5–8/月，综合学习课程 $13–15/月，差一倍。"
            description="音频卖不上价是结构性的——没有可见进度、没有成绩单、没有可晒的成果。而 Khan Academy Kids 完全免费且质量不差，等于给整个品类的地板浇了水泥。"
          />
        </div>
      </DocSection>

      <DocSection title="国内 · 全部免费下载 + 会员内购">
        <p className="m-0 mb-2 text-xs text-kumo-subtle">App Store 中国区实测，评分数作为规模粗代理，2026-08-12 拉取。</p>
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>App</th><th>评分数</th><th>会员价</th></tr></thead>
            <tbody>
              <tr><td><strong>洪恩识字</strong></td><td className="tabular-nums"><strong>1,424,670</strong></td><td><Dim>未拿到</Dim></td></tr>
              <tr><td><strong>喜马拉雅儿童</strong></td><td className="tabular-nums">595,884</td><td><strong>年卡 178 元</strong>（联合会员低至约 148 元）</td></tr>
              <tr><td><strong>凯叔讲故事</strong></td><td className="tabular-nums">433,651</td><td><strong>年卡 248–298 元</strong>（智能会员 348，促销低至 198）</td></tr>
              <tr><td>叽里呱啦</td><td className="tabular-nums">403,035</td><td><Dim>未拿到</Dim></td></tr>
              <tr><td>宝宝巴士儿歌</td><td className="tabular-nums">352,804</td><td><Dim>未拿到</Dim></td></tr>
              <tr><td>小伴龙</td><td className="tabular-nums">281,554</td><td><Dim>未拿到</Dim></td></tr>
              <tr><td>贝乐虎儿歌</td><td className="tabular-nums">281,323</td><td>月卡，31 天畅听</td></tr>
              <tr><td>口袋故事</td><td className="tabular-nums">20,378</td><td><Dim>未拿到</Dim></td></tr>
            </tbody>
          </Table>
        </div>
        <p className="mt-2 text-sm" style={{ maxWidth: "40rem" }}>
          国内年卡 178–298 元，约合 <strong>25–42 美元一年</strong>，只有 ABCmouse 年费的一半到七成。
          <strong>没有一家靠下载收费，全部是免费获客加会员墙。</strong>
        </p>
      </DocSection>

      <DocSection title="最贵的一条教训 · Pinkfong">
        <p className="m-0 text-sm" style={{ maxWidth: "40rem" }}>
          Baby Shark 是 YouTube 史上播放量最高的视频，<strong>164 亿次</strong>。母公司 Pinkfong 已上市，估值约 3.75–4 亿美元。
        </p>
        <div className="mt-2">
          <Banner
            variant="alert"
            title="「流量」和「盈利」之间存在巨大鸿沟——拥有史上第一的儿歌，并没有让这家公司成为巨富。"
            description="儿歌的播放量和收入不是线性关系。如果商业假设里含有「内容火了就能赚钱」，Pinkfong 是最贵的反例。"
          />
        </div>
      </DocSection>

      <DocSection title="变现的四种样式">
        <dl className="m-0">
          <Dt>纯订阅 —— Pinna、ABCmouse、Lingokids</Dt><Dd>最干净，但要持续供给新内容维持续订。</Dd>
          <Dt>订阅 + 实体绑定 —— Yoto Club</Dt><Dd>$4.99/月订阅捆绑每月实体卡折价额度，把数字订阅变成实体复购的入口。</Dd>
          <Dt>多路并行 —— Super Simple Songs</Dt><Dd>订阅、广告、周边、授权、流媒体分发五条腿走路。反过来说明：单靠订阅撑不住。</Dd>
          <Dt>B 端 + C 端双轨 —— Mussila、Epic!</Dt><Dd>学校端免费或机构付费做分发和背书，家庭端收订阅费。校内免费是获客渠道，不是慈善。</Dd>
        </dl>
      </DocSection>

      <DocSection title="对 hum 的三条结论">
        <dl className="m-0">
          <Dt>定价锚点已经确定</Dt>
          <Dd>C 端纯音频档是 $5–8/月，国内年卡 178–298 元。别指望 ABCmouse 那档，除非产品形态从「听」变成「有成绩单的课程」。</Dd>
          <Dt>这个价格带养不活人工采编，而这正是机会</Dt>
          <Dd>Pinna 400 小时、Yoto 850+ 卡、Epic 40,000 本，全是十年策划录制堆出来的。自动化流水线在这里不是效率优化，是唯一能在低价格带持续供给新内容的方式；反之，内容生产还需要人，就没有活路。</Dd>
          <Dt>内容量的差距是数量级的</Dt>
          <Dd>hum 现在 2 首歌，竞品入门量级是几百小时。谈变现之前，先证明流水线能无人干预地批量产出可用成品。</Dd>
        </dl>
      </DocSection>

      <DocSection title="数据边界">
        <p className="m-0 text-xs text-kumo-subtle" style={{ maxWidth: "40rem" }}>
          洪恩、叽里呱啦、宝宝巴士、小伴龙、口袋故事、贝乐虎的具体会员价未拿到；Epic! 确切订阅价未拿到。
          评分数只是规模粗代理，不等于 DAU 或付费用户，且只覆盖 iOS 中国区。
          Pinkfong 营收拆解未公开。国内会员价来自二手来源，促销波动大，以应用内实际支付页为准。
        </p>
      </DocSection>

      <ResearchNav current="/pricing" />
    </DocPage>
  );
}
