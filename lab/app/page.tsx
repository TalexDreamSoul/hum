import { Badge, Banner, Grid, GridItem, Table, Text } from "@cloudflare/kumo";
import { ConsoleSection } from "@/components/console/console-ui";
import { SiteDefinitions, SiteFooterNav, SitePage, SiteText } from "@/components/site-ui";

const REAL_TRACKS = [
  { src: "/audio/mm-guo-ma-lu-L0.mp3", name: "过马路", meta: "上学车程 · 带唱 · 73 秒" },
  { src: "/audio/mm-guo-ma-lu-L3.mp3", name: "过马路 · 纯伴奏", meta: "全程留给孩子唱 · 106 秒" },
  { src: "/audio/mm-qing-xu-L0.mp3", name: "说出我的心情", meta: "睡前 · 情绪命名 · 102 秒" },
];

const DEMO_TRACKS = [
  { src: "/audio/local-guo-ma-lu-L0.mp3", name: "L0 · 完整版", meta: "首次输入" },
  { src: "/audio/local-guo-ma-lu-L1.mp3", name: "L1 · 挖一空", meta: "只空掉最后一次副歌，冲击最小" },
  { src: "/audio/local-guo-ma-lu-L2.mp3", name: "L2 · 挖三空", meta: "加压" },
  { src: "/audio/local-guo-ma-lu-L3.mp3", name: "L3 · 纯伴奏", meta: "全程接唱" },
];

const PIPELINE = ["知识点", "编排", "生成", "挖空", "质检", "成品"];

const MECHANISM = [
  {
    term: "答案是独立字段，永远在句尾",
    description: "挖空不用切音频、不用猜时间戳——不合成那一段就行。提取练习是数据结构的属性，不是后期处理。",
  },
  {
    term: "每首歌的和声都不一样",
    description: "调性、和弦进行、音色、织体由知识点文件确定性推出，同一份输入永远得到同一首歌。",
  },
  {
    term: "场景是硬约束",
    description: "睡前强制无打击、76 拍、慢语速——写在代码里，不是文档里的建议。",
  },
];

const MARKET = [
  { fact: "tonies 已验证", detail: "无屏儿童音频 = 6.3 亿欧元营收、62.8% 毛利的生意" },
  { fact: "赢家的共性", detail: "硬件 + 人工内容库 + 纯被动听" },
  { fact: "没人做的", detail: "按知识点自动生产 + 提取闭环——hum 独占的格子" },
];

function TrackList({ tracks }: { tracks: Array<{ src: string; name: string; meta: string }> }) {
  return (
    <Grid gap="sm">
      {tracks.map((track) => (
        <Grid key={track.src} gap="sm">
          <Text bold>{track.name}</Text>
          <Text variant="secondary" size="xs">{track.meta}</Text>
          <audio controls preload="none" src={track.src} />
        </Grid>
      ))}
    </Grid>
  );
}

export default function Home() {
  return (
    <SitePage
      title="让学习长在日常里，不用特意打开任何东西"
      lede="把知识点自动做成歌，孩子在坐车、洗漱、睡前顺耳听见。到了句尾，答案被拿掉，等他自己接上。"
    >
      <ConsoleSection title="先听这个">
        <Grid gap="base">
          <SiteText secondary>
            流水线的真实产出，输入只是一份二十行的知识点文件。建议用手机在车里放，别用电脑外放判断。
          </SiteText>
          <TrackList tracks={REAL_TRACKS} />
          <Banner
            variant="default"
            title="只判断一件事：句尾那几个词——「停下来」「往前走」「等一等」「不乱跑」——唱清楚了没有。"
            description="这几个词是孩子要接的东西。糊掉的话，整套机制不成立。编曲好不好听先不管。"
          />
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="接唱是怎么回事">
        <Grid gap="base">
          <SiteText>
            被动听会制造「学会了」的错觉——熟悉不等于会，学习科学里真正管用的是主动提取。所以歌唱到句尾会停半拍，
            把答案空出来。同一首歌四个版本随熟练度推进，留白时长与原唱严格相等、伴奏在留白处降下来，
            间隔重复藏在播放列表里。
          </SiteText>
          <SiteText secondary>
            下面四条来自本地引擎，人声是语音合成、不是演唱，只用来听清楚机制。重点听最后一句「过马路，____」。
          </SiteText>
          <TrackList tracks={DEMO_TRACKS} />
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="怎么造出来的">
        <Grid gap="base">
          <Grid variant="6up" gap="sm">
            {PIPELINE.map((step) => (
              <GridItem key={step}>
                <Badge variant={step === "挖空" ? "info" : "neutral"}>{step}</Badge>
              </GridItem>
            ))}
          </Grid>
          <SiteDefinitions items={MECHANISM.map((item) => ({ term: item.term, description: item.description }))} />
        </Grid>
      </ConsoleSection>

      <ConsoleSection title="赛道在哪">
        <Grid gap="base">
          <Table>
            <thead><tr><th>判断</th><th>依据</th></tr></thead>
            <tbody>
              {MARKET.map((row) => (
                <tr key={row.fact}>
                  <td><Text bold>{row.fact}</Text></td>
                  <td><Text variant="secondary">{row.detail}</Text></td>
                </tr>
              ))}
            </tbody>
          </Table>
          <SiteFooterNav current="/" />
        </Grid>
      </ConsoleSection>
    </SitePage>
  );
}
