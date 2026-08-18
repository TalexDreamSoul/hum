import type { Metadata } from "next";
import { Banner, Table } from "@cloudflare/kumo";
import { DocPage, DocSection, Dt, Dd, ResearchNav } from "@/components/doc";

export const metadata: Metadata = { title: "儿童学习赛道竞品盘点 — hum" };

const Dim = ({ children }: { children: React.ReactNode }) => <span className="text-kumo-subtle">{children}</span>;

export default function Page() {
  return (
    <DocPage
      kicker="hum · 调研 · 2026-08-12"
      title="儿童学习赛道竞品盘点"
      lede="无屏幕儿童音频已经被 tonies 验证成 6.3 亿欧元、62.8% 毛利的生意。但赢家全是「硬件 + 人工内容库」，没有一家做「按知识点自动生产 + 提取闭环」。"
    >
      <DocSection title="怎么分的层">
        <p className="m-0 text-sm" style={{ maxWidth: "40rem" }}>
          按<strong>离命题有多近</strong>排，不按学科或年龄排。命题是：不用特意打开，学习长在日常里。
          只有第一层是真竞品，它们和 hum 争同一个场景——孩子不看屏幕的时候，耳朵里放什么。
        </p>
      </DocSection>

      <DocSection title="第一层 · 无屏幕，被动听">
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th>产品</th><th>形态</th><th>规模</th></tr></thead>
            <tbody>
              <tr>
                <td><strong>tonies</strong><br /><Dim>德，已上市</Dim></td>
                <td>音频盒 + 收藏公仔，每个公仔约等于一份内容</td>
                <td><strong>2025 营收 €630.35M，+31.2%</strong><br />年销 260 万台，装机约 1220 万台<br />累计售出公仔超 1.65 亿个，毛利率 62.8%</td>
              </tr>
              <tr><td><strong>Yoto</strong><br /><Dim>英</Dim></td><td>播放器 + 实体卡（约 $10–15/张），3–10 岁</td><td><Dim>营收与融资未查到可靠数据</Dim></td></tr>
              <tr><td><strong>Storypod</strong><br /><Dim>美</Dim></td><td>无屏音箱 + 配件，3–8 岁</td><td><Dim>未查到</Dim></td></tr>
              <tr><td><strong>牛听听</strong><br /><Dim>国内，2015</Dim></td><td>「熏听启蒙」听读机，0–18 岁</td><td>收录 50 万+ 内容，三条产品线<br />基石资本数千万元 A+ 轮</td></tr>
              <tr><td><strong>火火兔 Alilo</strong><br /><Dim>国内</Dim></td><td>儿童音频硬件，0–12 岁，十五年</td><td><Dim>未查到</Dim></td></tr>
              <tr><td><strong>凯叔讲故事</strong><br /><Dim>国内，2014</Dim></td><td>原创故事内容 + 故事机 / AI 早教硬件</td><td>7000 万家庭，累计播放超 222 亿次<br />C+ 轮 6600 万美元</td></tr>
            </tbody>
          </Table>
        </div>
        <p className="mt-2 text-xs text-kumo-subtle">国内故事机市场规模：2023 年约 37.44 亿元人民币。</p>

        <h3 className="mt-4 mb-1">这一层给出的三条结论</h3>
        <dl className="m-0">
          <Dt>商业模式已被验证，而且形态是硬件</Dt>
          <Dd>tonies 的 6.3 亿欧元和 62.8% 毛利，靠的是「盒子 + 一个个卖的内容载体」，不是软件订阅。</Dd>
          <Dt>「被动听」不是新概念，已经有人占住了品类词</Dt>
          <Dd>牛听听主打「熏听」，做了十年。hum 如果只讲「磨耳朵」「随处可见」，在国内是在别人地盘上重复。</Dd>
          <Dt>所有玩家的内容都是人工采编的库存</Dt>
          <Dd>50 万条内容、1.65 亿个公仔，本质是出版业逻辑：策划、录制、上架。没有一家是「输入知识点、自动产出成品」的。</Dd>
        </dl>
      </DocSection>

      <DocSection title="第二层 · 体量相近，但要「打开」">
        <p className="m-0 text-sm" style={{ maxWidth: "40rem" }}>
          不是直接竞品——它们要求孩子坐下来、看屏幕、点进去，正是命题要绕开的东西。但它们证明了付费意愿和内容体系的样子。
        </p>
        <p className="mt-2 text-sm"><strong>国内</strong>：斑马 AI 学（年收入 10 亿元，月营收超 3 亿）、叽里呱啦、洪恩识字、叫叫、宝宝巴士、学而思启蒙、小猴启蒙、纳米盒、口袋故事、少年得到。</p>
        <p className="mt-1 text-sm"><strong>海外</strong>：Khan Academy Kids（完全免费无广告）、Lingokids（超 1000 万家庭）、ABCmouse、Homer、Epic!、Duolingo ABC。</p>
        <div className="mt-3">
          <Banner variant="default" title="36 氪的观察：国内头部内容公司年营收到 2–3 亿人民币时普遍增长放缓。" description="内容库模式的天花板大概在这个量级。" />
        </div>
      </DocSection>

      <DocSection title="第三层 · 同样用 AI 生成儿歌，但目的不同">
        <p className="m-0 text-sm" style={{ maxWidth: "40rem" }}>
          最容易被误认成竞品，实际不是。KidiTune、My Kid Song、SongTales、LittleTunesAI、KidSongs AI、Songr、Hitto——
          套路一致：把孩子的名字、年龄、兴趣塞进歌里，生成一首带封面的纪念品，首曲免费。
        </p>
        <dl className="m-0 mt-2">
          <Dt>载荷不同</Dt><Dd>它们唱的是孩子的名字，hum 唱的是知识点。</Dd>
          <Dt>没有提取闭环</Dt><Dd>生成完就结束，不存在挖空、接唱、间隔重复。</Dd>
          <Dt>没有生产体系</Dt><Dd>一次性生成，不是「输入知识点、自动出四级成品」的流水线。</Dd>
        </dl>
        <p className="mt-2 text-xs text-kumo-subtle">另有 8 个「笔记转歌」工具（StudySong、Memody、Rhymember 等）同理：面向学生自助，不面向家庭日常渗透。</p>
      </DocSection>

      <DocSection title="格局的真实形状">
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><th></th><th>分发通道</th><th>内容生产</th><th>提取闭环</th></tr></thead>
            <tbody>
              <tr><td>tonies / Yoto / 牛听听 / 凯叔</td><td><strong>自有硬件，装机千万级</strong></td><td>人工采编库存</td><td><Dim>纯被动听</Dim></td></tr>
              <tr><td>斑马 / Lingokids / ABCmouse</td><td>需要打开 App</td><td>人工课程体系</td><td>有练习，但要坐下来</td></tr>
              <tr><td>AI 儿歌礼物型（7 家）</td><td><Dim>无</Dim></td><td>AI 生成但一次性</td><td><Dim>无</Dim></td></tr>
              <tr><td>Flocabulary / Numberock</td><td><Dim>困在课堂</Dim></td><td><strong>人工精编，方法论扎实</strong></td><td>部分</td></tr>
              <tr className="bg-kumo-elevated"><td><strong>hum（当前）</strong></td><td><Dim>零</Dim></td><td><strong>全自动流水线</strong></td><td><strong>四级挖空 + 留白闪避</strong></td></tr>
            </tbody>
          </Table>
        </div>
        <div className="mt-3 grid gap-2">
          <Banner variant="default" title="hum 独占的格子是「自动生产 × 提取闭环」，确实没有第二家在里面。" />
          <Banner variant="alert" title="hum 完全空白的格子是分发通道，而这恰好是所有赢家共有的东西。" />
        </div>
      </DocSection>

      <DocSection title="由此产生的三个问题">
        <dl className="m-0">
          <Dt>要不要做硬件</Dt>
          <Dd>tonies 用 6.3 亿欧元证明「盒子 + 内容载体」能成，而纯软件在这个年龄段渗透一直很难——孩子没有手机。但硬件是完全不同的能力栈。</Dd>
          <Dt>能不能寄生在别人的硬件上</Dt>
          <Dd>Yoto 的自制卡、tonies 的 Creative-Tonies 理论上允许外部音频进入。可行性未核实。就算成立，风险是内容供应商没有护城河，机制会被平台方直接抄走。</Dd>
          <Dt>车载和智能音箱这条路还成立吗</Dt>
          <Dd>竞品里确实没人在认真做车载——可能是空位，也可能是别人试过发现不成立。目前零证据，需要单独验证。</Dd>
        </dl>
      </DocSection>

      <DocSection title="数据边界">
        <p className="m-0 text-xs text-kumo-subtle" style={{ maxWidth: "40rem" }}>
          Yoto 的营收、融资、装机数据没查到可靠来源，自制卡能否放任意用户音频未核实——「寄生」推论建立在这个未核实前提上。
          叽里呱啦、火火兔、Storypod 的规模数据缺失。儿童启蒙市场整体规模没拿到可信数字，只有故事机品类的 37.44 亿元（2023）。
          全部数据来自二手网络来源，未做交叉验证；tonies 的数字来自其投资者关系页面，可信度最高。
        </p>
      </DocSection>

      <ResearchNav current="/competitors" />
    </DocPage>
  );
}
