/**
 * 引导录音脚本数据。
 *
 * 内容整理自飞书文档《用自己的声音训练 AI 音色：录音脚本 + 朗读指南》：
 * - 说话部分对应 §3.1-3.7（音素/声调/句式全覆盖）；
 * - 唱歌部分对应 §4.1-4.3（音阶、长元音、清唱片段，覆盖音域）。
 *
 * 目标是「先把音色采干净、采全」，因此说话与唱歌片段都设为必录。
 */

export type ClipGroup = "speech" | "singing";

export interface RecordingClip {
  /** 稳定 id，用于关联录音结果，切勿随意改动。 */
  id: string;
  group: ClipGroup;
  /** 分节标题，如「3.1 声母全覆盖」。 */
  section: string;
  /** 该片段的朗读/演唱标题。 */
  title: string;
  /** 照读/照唱的具体内容，逐条换行。 */
  lines: string[];
  /** 录音提示，帮助用户读/唱得更规范。 */
  tip: string;
  /** 建议最短录音时长（秒），本地合格检查会据此判定。 */
  minSec: number;
}

/** 说话脚本：覆盖普通话全部音素、声调、句式与特殊场景。 */
const SPEECH_CLIPS: RecordingClip[] = [
  {
    id: "speech-3.1-shengmu",
    group: "speech",
    section: "3.1 声母全覆盖",
    title: "21 个声母逐组念",
    lines: [
      "白布、跑步、面包、方法",
      "大道、天梯、牛奶、来了",
      "高铁、开口、黑河",
      "家具、请求、西湖",
      "中场、超市、上升、柔软",
      "自从、参赛、思索",
    ],
    tip: "每组一口气读完，正常语速、放松自然，别用播音腔。",
    minSec: 8,
  },
  {
    id: "speech-3.2-yunmu",
    group: "speech",
    section: "3.2 韵母全覆盖",
    title: "单/复/鼻韵母",
    lines: [
      "他、我、饿、一、五、鱼",
      "海、飞、好、走",
      "家、谢、花、多、雪",
      "叫、有、快、对",
      "安、恩、心、云、军",
      "忙、灯、明、红",
    ],
    tip: "把前后鼻音（an/ang、in/ing）念清楚，别含糊带过。",
    minSec: 8,
  },
  {
    id: "speech-3.3-sisheng",
    group: "speech",
    section: "3.3 四声 + 轻声",
    title: "声调对比",
    lines: [
      "mā má mǎ mà（妈、麻、马、骂）",
      "yī yí yǐ yì（一、姨、椅、意）",
      "阴平「高」、阳平「来」、上声「好」、去声「去」",
      "轻声：桌子、我们、看看、休息、明白",
    ],
    tip: "同字四声要念出高低起伏差异，轻声要轻而短。",
    minSec: 8,
  },
  {
    id: "speech-3.4-yihunyin",
    group: "speech",
    section: "3.4 易混音专项",
    title: "把区别念清楚",
    lines: [
      "私自—知识、粗糙—出错、思索—师叔",
      "四是四，十是十，十四是十四，四十是四十",
      "牛奶—流利、南方—蓝色、恼怒—老路",
      "发货—飞花、方向—荒凉",
      "山—伤、办—棒、单—当；心—星、林—灵、拼—平",
      "日、肉、然、如果、认真；绿、女、需要、决定、军人",
      "花儿、玩儿、一点儿、小孩儿、有味儿",
    ],
    tip: "重点分清 z/c/s 与 zh/ch/sh、n 与 l、儿化音。",
    minSec: 12,
  },
  {
    id: "speech-3.5-pingheng",
    group: "speech",
    section: "3.5 音素平衡句",
    title: "长短句 + 三种句式",
    lines: [
      "今天天气很好。我在家里听音乐。",
      "周末我打算和几个朋友一起去郊外爬山，顺便拍一些照片留作纪念。",
      "你到底想说什么呢？这件事真的能办成吗？",
      "太不可思议了！这也太棒了吧！",
      "请把这份材料在下午三点之前发到我的邮箱。",
    ],
    tip: "陈述、疑问、感叹语气各自到位，长句一句一停不要糊。",
    minSec: 12,
  },
  {
    id: "speech-3.6-teshu",
    group: "speech",
    section: "3.6 数字、字母、多音字",
    title: "特殊场景",
    lines: [
      "一三五七九、二四六八十、一百",
      "二零二五年十二月三十一日",
      "OK、Wi-Fi、iPhone、App、CEO",
      "银行（háng）/行（xíng）走",
      "重（zhòng）量/重（chóng）复",
      "长（cháng）度/长（zhǎng）大；还（hái）有/还（huán）钱",
    ],
    tip: "多音字按标注的读音念，数字串保持均匀节奏。",
    minSec: 10,
  },
  {
    id: "speech-3.7-qingxu",
    group: "speech",
    section: "3.7 情绪与语气",
    title: "同字不同情绪",
    lines: [
      "开心：哈哈，我今天真的太开心啦！",
      "平静：慢慢来，一切都会好起来的。",
      "认真：这一点非常重要，请一定记住。",
      "疑惑：咦？这到底是怎么回事？",
    ],
    tip: "有自然起伏即可，别夸张到破音。",
    minSec: 8,
  },
];

/** 唱歌脚本：覆盖音域，是让 AI 用你的声音唱歌的关键。 */
const SINGING_CLIPS: RecordingClip[] = [
  {
    id: "singing-4.1-yinjie",
    group: "singing",
    section: "4.1 音阶练习",
    title: "do re mi 上下行",
    lines: [
      "用「do re mi fa sol la si do」从低唱到高，再从高唱回低。",
      "慢速、每个音唱稳；在舒服音区、偏低、偏高各来一遍。",
    ],
    tip: "无伴奏清唱，把能唱到的上下限都摸一摸，别硬憋到破音。",
    minSec: 15,
  },
  {
    id: "singing-4.2-changyuanyin",
    group: "singing",
    section: "4.2 长元音持续",
    title: "低/中/高音区各拉长",
    lines: [
      "「啊——」「哦——」「呜——」「咦——」各拉长 4-8 秒。",
      "分别在低音、中音、高音各录一遍，音高保持稳定。",
    ],
    tip: "保持音高稳定、音量均匀，让模型学到各音区音色。",
    minSec: 16,
  },
  {
    id: "singing-4.3-qingchang",
    group: "singing",
    section: "4.3 清唱歌曲片段（最重要）",
    title: "2-3 首覆盖高中低",
    lines: [
      "选 2-3 首你会唱的歌，分别偏低、偏中、偏高音区。",
      "清唱（无伴奏）录主歌 + 副歌，音准稳、音色统一。",
      "同一句可「轻轻唱」和「放开唱」各来一遍，覆盖强弱。",
    ],
    tip: "全程无伴奏、无混响、单人；别一会儿真声一会儿气声乱切。",
    minSec: 20,
  },
];

export const RECORDING_CLIPS: RecordingClip[] = [...SPEECH_CLIPS, ...SINGING_CLIPS];

export const GROUP_LABEL: Record<ClipGroup, string> = {
  speech: "说话（音素/咬字全覆盖）",
  singing: "唱歌（音域全覆盖）",
};
