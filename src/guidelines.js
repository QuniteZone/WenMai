'use strict'

/*
 * 内置写作准则。
 *
 * 设计原则：
 * 1. 准则必须短——它会占用每次请求的 prompt，直接影响首字延迟。
 * 2. 准则必须具体——"写得好一点"没有用，"不重复已写文字、一次最多两句"才有用。
 * 3. 准则只约束续写，不改变作者已经写下的内容。
 */

const GENRES = ['自动', '通用', '公文', '学术', '小说', '新媒体', '商务']

const COMMON =
  '紧接上文续写；不重复已写文字；只顺着已有内容往下写，不点评、不改写上文；' +
  '不编造事实、数据与引文；延续人称、时态、语气与术语；每句带来新信息，不重复同义表达；' +
  '优先写具体的动作、场景与细节，避免空话套话；不突然总结，不强行升华；' +
  '中文用全角标点，中英文之间加空格；只输出正文，不加解释。'

const PROFILES = {
  通用: '保持原文的节奏与句式，长短句错落。',
  公文: '用词规范庄重，多用动宾结构，层次清楚，不口语化、不夸张；无依据的数字与案例不写。',
  学术: '论点与论据紧密衔接，术语准确，表述客观克制，避免绝对化；数据与引文必须有依据。',
  小说: '用动作、对话与感官细节推进，可自然引入人物与场景，保持视角统一，少作概括性心理陈述。',
  新媒体: '以短句和具体场景推进，有节奏感，少说教，不用营销套话；不编造效果数据。',
  商务: '结论先行，信息密度高，动词明确，避免形容词堆砌；不虚构业绩与增长数字。'
}

const SIGNALS = {
  公文: ['通知', '请示', '报告', '方案', '会议', '部署', '落实', '推进', '领导', '单位', '各乡镇', '各部门', '工作'],
  学术: ['研究', '实验', '样本', '数据', '文献', '假设', '显著', '理论', '模型', '本文', '变量', '分析'],
  小说: ['他说', '她说', '忽然', '窗外', '屋里', '眼睛', '声音', '手指', '月光', '心里', '转身', '低声道'],
  新媒体: ['你', '我们', '干货', '分享', '爆款', '打工人', '评论区', '点赞', '其实', '真的', '有没有', '姐妹们'],
  商务: ['客户', '方案', '增长', '转化', '汇报', '项目', '团队', '目标', '复盘', '预算', '市场', '价值']
}

function countOccurrences(text, word) {
  let count = 0
  let index = 0
  while ((index = text.indexOf(word, index)) !== -1) {
    count++
    index += word.length
  }
  return count
}

/**
 * 根据最近上下文猜文体。只在用户选择"自动"时使用。
 * 阈值故意偏高：宁可回退到"通用"，也不要在普通文章里强行套公文腔。
 */
function detectGenre(text) {
  if (!text || !text.trim()) return '通用'
  const sample = text.slice(-3000)
  let best = '通用'
  let bestScore = 0

  for (const genre of Object.keys(SIGNALS)) {
    let score = 0
    for (const word of SIGNALS[genre]) {
      const n = countOccurrences(sample, word)
      if (n > 0) score += n * Math.min(4, word.length)
    }
    if (score > bestScore) {
      bestScore = score
      best = genre
    }
  }

  return bestScore >= 8 ? best : '通用'
}

function resolveGenre(configured, text) {
  if (configured && configured !== '自动' && PROFILES[configured]) return configured
  return detectGenre(text)
}

function buildGuidelineLine({ genre, maxSentences, maxChars, custom }) {
  const resolved = PROFILES[genre] ? genre : '通用'
  const profile = PROFILES[resolved]

  const lengthRule =
    maxChars <= 60 ? '本次只补一个短句。' : `本次最多续写 ${maxSentences} 句，话说完就停。`

  let line = `（写作设定：${resolved}。${COMMON}${profile}${lengthRule}）`

  if (custom) {
    const safe = String(custom)
      .replace(/[（）]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    if (safe) {
      // 自定义准则常以句号结尾，避免拼出"。。）"。
      const trimmed = safe.replace(/[。！？；，、.!?;,]+$/, '')
      if (trimmed) line = line.slice(0, -1) + ` 额外要求：${trimmed}。）`
    }
  }

  if (line.length > 340) line = line.slice(0, 338) + '）'
  return line
}

module.exports = {
  GENRES,
  COMMON,
  PROFILES,
  detectGenre,
  resolveGenre,
  buildGuidelineLine
}
