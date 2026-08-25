import type { Metadata } from "next";
import { SCENES } from "@/lib/analysis/score";

export const metadata: Metadata = { title: "评分原理 — hum·lab" };

const th = { borderBottom: "2px solid var(--chart-line)" } as const;
const td = { borderBottom: "1px solid var(--chart-line)" } as const;

export default function Methodology() {
  return (
    <main className="wrap prose" style={{ paddingTop: "2.6rem" }}>
      <h1 style={{ fontSize: "1.7rem", letterSpacing: "-0.01em", margin: 0 }}>评分原理</h1>
      <p className="text-kumo-subtle" style={{ marginTop: "0.7rem" }}>
        每个维度都回答三件事：<strong>测什么、怎么算、为什么这么定</strong>。
        阈值全部写在代码里（<code>lib/analysis/score.ts</code>），页面与代码一一对应；
        标准有出处，代理指标如实标注局限。
      </p>

      <h2>总公式</h2>
      <p>
        9 个维度各得 0–100 分，按权重加权平均（权重合计 100）。
        检不出人声的音频（纯伴奏 / 接唱版）会剔除音域、清晰度、留白三个维度，剩余权重重新归一。
        时长适配占 8 分：生产候选对比不可变 SongSpec 目标，其他音频使用场景目标；它衡量结构适配，不冒充儿童普适注意力结论。
        等级：A ≥ 85，B ≥ 70，C ≥ 55，其余 D。
      </p>
      <table>
        <thead><tr className="text-kumo-subtle"><th style={th}>维度</th><th style={th}>权重</th><th style={th}>核心问题</th></tr></thead>
        <tbody>
          <tr><td style={td}>响度与安全</td><td style={td}>14</td><td style={td}>家长设一次音量能不能一直用；有没有削波</td></tr>
          <tr><td style={td}>动态起伏</td><td style={td}>7</td><td style={td}>会不会一堵墙，或安静段在车里消失</td></tr>
          <tr><td style={td}>节奏适配</td><td style={td}>13</td><td style={td}>孩子跟不跟得上拍；契不契合场景</td></tr>
          <tr><td style={td}>适唱音域</td><td style={td}>14</td><td style={td}>孩子的嗓子够不够得着这条旋律</td></tr>
          <tr><td style={td}>人声清晰度</td><td style={td}>13</td><td style={td}>词能不能被听清（辅音带有没有被伴奏盖住）</td></tr>
          <tr><td style={td}>重复与结构</td><td style={td}>13</td><td style={td}>有没有能"洗脑"的钩子，又不至于单调</td></tr>
          <tr><td style={td}>留白接唱</td><td style={td}>11</td><td style={td}>有没有孩子能接的空位</td></tr>
          <tr><td style={td}>频谱舒适度</td><td style={td}>7</td><td style={td}>高频毛刺与低频轰隆</td></tr>
          <tr><td style={td}>时长适配</td><td style={td}>8</td><td style={td}>实际长度是否匹配年龄规格或使用场景</td></tr>
        </tbody>
      </table>

      <h2>为什么在浏览器本地分析</h2>
      <p>
        音频解码用浏览器自带的 Web Audio，全部 DSP 用 TypeScript 手写、在你的设备上执行。
        文件不上传：没有存储成本、没有隐私问题，断网也能用。代价是重度依赖近似算法
        （见各节"局限"），这是有意的取舍——这个工具回答"值不值得进一步用"，不出具审计级数据。
      </p>

      <h2>1 · 响度与安全（14 分）</h2>
      <h3>测什么</h3>
      <p>整体响度（LUFS）、响度范围（LRA）、真峰值（dBTP）。</p>
      <h3>怎么算</h3>
      <p>
        按 ITU-R BS.1770 做 K 计权（高架 +4 dB@1.68 kHz + 高通@38 Hz 两级双二阶），
        400 ms 块、绝对门限 −70 / 相对门限 −10 的门限积分；短期响度用 3 s 窗。
        真峰值用 4 倍过采样（Catmull-Rom 插值）近似，误差约 ±0.3 dB。
      </p>
      <h3>为什么</h3>
      <p>
        流媒体和移动端的普遍归一目标在 −14 至 −16 LUFS，广播（EBU R128）是 −23。
        儿童音频取 <strong>−16（睡前/用餐 −18）±2.5</strong>：孩子的收听环境是"家长设一次音量、连续放一列表"，
        列表内响度不一致会迫使家长反复调音量，调大的那次就是超量暴露的来源——
        WHO/ITU H.870 对儿童的安全暴露参考是 <strong>75 dB(A)、每周 40 小时</strong>。
        真峰值高于 −1 dBTP 时，转码到蓝牙/AAC 常产生削波，所以直接扣分。
      </p>
      <h3>局限</h3>
      <p>LUFS 是信号侧指标，实际暴露还取决于播放设备与音量设置；真峰值为近似值。</p>

      <h2>2 · 动态起伏（7 分）</h2>
      <p>
        LRA 按 EBU Tech 3342（短期响度分布的 P95−P10，双门限）。目标带默认 3–9 LU：
        低于 3 是"从头到尾一堵墙"，高密度压缩听感疲劳；高于 9 的安静段在
        约 65–70 dB 的车内噪声里直接消失——而通勤正是 hum 的主场景。睡前带整体下移（2–7）。
      </p>

      <h2>3 · 节奏适配（13 分）</h2>
      <h3>怎么算</h3>
      <p>
        谱通量起始包络 → 自相关（50–200 BPM），对数正态轻先验消除倍频歧义，抛物线插值细化；
        显著度不足时（峰值 &lt; 1.2σ）报告"节奏不明确"并把该维度封顶 70。
        评分时也测 2×/0.5× 倍速，取最优（轻扣 5 分），因为孩子可能按半拍或双拍跟。
      </p>
      <h3>为什么</h3>
      <p>
        学龄前儿童的自发运动节奏（SMT）约 <strong>150 BPM</strong>（npj Science of Learning, 2026），
        与孩子自身节奏接近的音乐更容易跟拍、跟唱。但"适合跟拍"不等于"适合此刻"——
        睡前放 150 BPM 是灾难。所以评分基准不是单一最优值，而是 hum 的场景锚点：
      </p>
      <table>
        <thead><tr className="text-kumo-subtle"><th style={th}>场景</th><th style={th}>锚点 BPM</th><th style={th}>软带</th><th style={th}>响度目标</th><th style={th}>目标 / 硬上限</th></tr></thead>
        <tbody>
          {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((k) => {
            const s = SCENES[k];
            return (
              <tr key={k}>
                <td style={td}>{s.label}</td>
                <td style={td}>{s.bpmAnchor ?? "—"}</td>
                <td style={td}>{s.bpmBand[1]}–{s.bpmBand[2]}</td>
                <td style={td}>{s.lufsTarget} LUFS</td>
                <td style={td}>{s.durTargetSec}s / {s.durMaxSec}s</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>4 · 适唱音域（14 分）</h2>
      <h3>怎么算</h3>
      <p>
        对 mid 声道做 180–700 Hz 带通后逐帧归一化自相关提取 F0（清晰度门限 0.62），
        统计落在 <strong>D4–B4（293.7–493.9 Hz）</strong>舒适唱区的时间占比与 P5–P95 音域跨度。
        占比 ≥60% 得满分，35% 以下为 0；跨度超过一个八度按半音递减扣分。
      </p>
      <h3>为什么</h3>
      <p>
        这是整个评分里最"hum"的一条：<strong>孩子够不着的旋律，接唱机制直接失效</strong>。
        儿童能发声的范围不小（VRP 研究显示未经训练的儿童可达约两个八度），
        但"能发出"与"舒适地唱准"是两回事——音乐教育研究（Welch 等）长期把幼儿的舒适唱区
        放在 C4–C5 之间的中段，D4–B4 是常用的设计带。
      </p>
      <h3>局限</h3>
      <p>
        对成品混音提 F0 会受同音区乐器干扰，结果是"主旋律区能量的音高倾向"而非人声轨真值；
        文献中的舒适区随年龄移动，这里用的是 3–6 岁的保守带。检不出人声时本维度不计分。
      </p>

      <h2>5 · 人声清晰度（13 分，代理指标）</h2>
      <h3>怎么算</h3>
      <p>三个子项加权：
        1–4 kHz 能量占比（0.4）；人声活跃帧内 1–4 kHz 的 mid/side 能量比（0.3，≥8 dB 满分）；
        清晰度带通量峰率作为音节率代理（0.3，目标 1.5–4.2 峰/秒）。
      </p>
      <h3>为什么</h3>
      <p>
        语音清晰度指数（SII，前身 Articulation Index）把可懂度按频带加权，
        <strong>辅音信息集中在 1–4 kHz</strong>——这一带被伴奏盖住，"停下来"就会听成含混的元音串。
        主流混音里人声居中（mid），伴奏摊开（side），所以 mid/side 比是"人声压得住伴奏"的低成本代理。
        音节率则对应低龄儿童的跟读能力：语速太快，词进不了耳朵。
      </p>
      <h3>局限</h3>
      <p>
        这是声学代理，不是语音识别验证——真正的可懂度测试需要 ASR 或听测。
        单声道文件测不了 mid/side，该子项按中性 85 分计。
      </p>

      <h2>6 · 重复与结构（13 分）</h2>
      <h3>怎么算</h3>
      <p>
        0.5 s 帧级 chroma（12 音级）自相似：每帧找距它 ≥4 s 的最相似帧，
        相似度 &gt; 0.90 记为重复帧。重复帧占比 32–72% 为满分带。
      </p>
      <h3>为什么</h3>
      <p>
        重复是旋律进入记忆的第一机制（Margulis《On Repeat》；耳虫研究显示 90% 以上的人每周
        都经历"歌在脑子里自动播放"）。对承载知识点的儿歌，副歌重复率直接决定钩子强度。
        但满分带设了上限：接近 100% 的重复等于单曲循环式单调，
        每分钟能装进去的新知识点趋近于零——重复是手段，不是目的。
      </p>
      <h3>局限</h3>
      <p>chroma 对移调重复、大幅变奏不敏感，测到的是保守下界。</p>

      <h2>7 · 留白接唱（11 分）</h2>
      <h3>怎么算</h3>
      <p>
        mid 声道 300–4000 Hz 带通包络低于其活跃中位数 −9 dB、同时全带包络仍在
        （伴奏没停）、持续 ≥300 ms → 记一个留白。评留白频次（目标 2.5–9 次/分）
        与平均时长（目标 400–1600 ms）。
      </p>
      <h3>为什么</h3>
      <p>
        这是 hum 的核心机制在评分里的投影：被动听会制造"学会了"的错觉，
        真正产生长期记忆的是<strong>主动提取</strong>（retrieval practice）。
        挖空接唱需要歌里天然存在孩子能接的空位——从头唱到尾、没有呼吸口的歌，
        无法改造成接唱版本。留白太长也不行：超过 2 秒孩子会失去节奏参照。
      </p>
      <h3>局限</h3>
      <p>没有做人声分离，乐器独奏段会被计入留白；结果应读作"可挖空窗口的上界"。</p>

      <h2>8 · 频谱舒适度（7 分）</h2>
      <p>
        &gt;8 kHz 能量占比 ≤7% 为满分带（超过意味着齿音、毛刺偏多——儿童对高频更敏感，久听易疲劳）；
        &lt;60 Hz 占比 ≤12%（小音箱放不出超低频，还挤占动态余量与车载功放的 headroom）。
      </p>

      <h2>9 · 时长适配（8 分）</h2>
      <p>
        生产候选以不可变 SongSpec 的年龄目标为中心：3–4 岁 45 秒、5–6 岁 60 秒、7–8 岁 75 秒、9–12 岁 90 秒；
        其他上传音频使用场景目标。目标的 80%–120% 为满分带，50% 以下或约 160% 以上降到 0，并受场景硬上限约束。
      </p>
      <p>
        这不是“儿童普遍只能听这么久”的学术结论，而是 hum 当前用于控制单知识点密度、复听成本和接唱轮次的生产假设。
        真正的偏好必须用完播率、主动重播、厌烦度和 24 小时记忆结果校准。当前 MiniMax 云端 <code>/v1/music_generation</code>
        没有 <code>duration</code> 参数，官方也未公布输出硬上限；系统只能通过歌词长度、曲式和提示词间接控制，生成后再按真实时长评分。
        开源 Music 3 的 <code>max_duration</code> 支持约 300 秒，但它不是当前云端 API 的同一控制面。
      </p>

      <h2>总体边界</h2>
      <p>
        这套分数衡量的是<strong>"作为儿童音频的形式质量"</strong>：响度是否安全、孩子能不能跟、
        词能不能听清、有没有记忆钩子和接唱空位。它<strong>不衡量教学有效性</strong>——
        歌词内容对不对、知识点结构好不好、孩子最终会不会，只能靠内容审查和真实孩子验证。
        另外：所有指标在 3 分钟内的典型儿歌上校准；对器乐曲、白噪音、故事朗读类音频，
        分数没有解释力。
      </p>

      <h2>依据清单</h2>
      <ul style={{ paddingLeft: "1.2rem" }}>
        <li>ITU-R BS.1770-4 —— K 计权与门限响度测量（LUFS 的定义）</li>
        <li>EBU R128 / Tech 3342 —— 响度归一（广播 −23 LUFS）与 LRA 算法</li>
        <li>WHO / ITU-T H.870 —— 儿童安全聆听参考：75 dB(A)、40 小时/周</li>
        <li>npj Science of Learning (2026) —— 学龄前儿童自发运动节奏约 150 BPM</li>
        <li>Welch (1979) 及后续音乐教育研究 —— 儿童舒适唱区；VRP 数据（voicescience.org）</li>
        <li>Speech Intelligibility Index（SII / ANSI S3.5）—— 1–4 kHz 辅音带权重</li>
        <li>Margulis《On Repeat》(2013)；INMI/耳虫研究 —— 重复与音乐记忆</li>
        <li>Retrieval practice 文献（如 Frontiers in Education 2018 儿童音乐助记 RCT）—— 留白接唱维度的依据</li>
        <li>场景锚点（BPM/时长/响度目标）—— hum 项目自身的场景设计（以当前部署为准）</li>
      </ul>
    </main>
  );
}
