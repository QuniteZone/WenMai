'use strict'

/*
 * 补全结果后处理。
 *
 * 模型返回的原始文本通常有四类问题：
 * 1. 复述提示词（把光标前的文字又写一遍）
 * 2. 复述写作准则（把括号里的设定当成正文）
 * 3. 太长（一口气写完整段）
 * 4. 与光标后的原文重复（启用 suffix 时）
 *
 * 这里的每一步都只做"减法"，不替作者改写。
 */

const STRONG_END = new Set(['。', '！', '？', '；', '!', '?', ';'])
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', ']', '】', '"', "'"])

// 只把汉字当作"中文词"：中文标点后面接英文时不该补空格
// （"，Apple 很好"而不是"， Apple 很好"）。
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const LATIN_WORD_RE = /[A-Za-z0-9]/

/**
 * 去掉模型复述的光标前文字。
 * 只从后往前找最长重叠，至少 2 个字符，避免把正常的单字衔接误删。
 */
function stripEchoedPrefix(text, pre) {
  if (!text || !pre) return text

  const lastBreak = pre.lastIndexOf('\n')
  const lastLine = pre.slice(lastBreak + 1)
  const trimmedLine = lastLine.trimStart()

  if (trimmedLine.length >= 2) {
    const trimmedText = text.trimStart()
    if (trimmedText.startsWith(trimmedLine)) {
      const rest = trimmedText.slice(trimmedLine.length)
      // 整段只有复述、后面什么都没写：必须返回空，不能退回去按“两字重叠”
      // 再切一刀，否则会把复述的结尾一两个字当成续写显示出来。
      return rest.trim() ? rest : ''
    }
  }

  const tail = pre.trimEnd()
  if (tail.length >= 2 && text.startsWith(tail)) {
    const rest = text.slice(tail.length)
    return rest.trim() ? rest : ''
  }

  const max = Math.min(tail.length - 1, text.length, 400)
  for (let k = max; k >= 2; k--) {
    if (text.startsWith(tail.slice(tail.length - k))) {
      const rest = text.slice(k)
      if (rest.trim()) return rest
    }
  }

  return text
}

/** 去掉模型把"写作设定/文档位置"当成正文写出来的部分。 */
function stripInstructionEcho(text) {
  let t = text.replace(/^[ \t]+/, '')

  t = t.replace(/^（\s*写作设定[\s\S]{0,400}?）[ \t]*/u, '')
  t = t.replace(/^（\s*文档位置[\s\S]{0,200}?）[ \t]*/u, '')
  t = t.replace(/^【[^】]{0,12}(?:续写|补全|写作)[^】]{0,12}】[ \t]*\n?/u, '')

  // Chat 模型常见的开场白
  t = t.replace(/^(?:好的|当然可以|没问题)[，,。]\s*(?:以下|下面)?(?:是|为)?[^\n]{0,20}(?:续写|补充|内容)[^\n]{0,10}[:：]\s*\n?/u, '')
  t = t.replace(/^(?:以下是|下面是|这是)[^\n]{0,20}(?:续写|补充|内容)[^\n]{0,10}[:：]\s*\n?/u, '')
  t = t.replace(/^(?:续写如下|补充如下)[:：]\s*\n?/u, '')

  t = t.replace(/^(?:续写内容|续写|补全结果|补全|输出|结果)[:：][ \t]*/u, '')
  t = t.replace(/^```[A-Za-z0-9_+-]*[ \t]*\n?/, '')
  t = t.replace(/\n?[ \t]*```[ \t]*$/, '')

  return t
}

/**
 * 启用 suffix 时，避免与光标后的原文重复。
 * 宁可丢弃，也不要把同一句话接两遍。
 */
function reconcileSuffix(text, suffix) {
  if (!text || !suffix) return text
  const s = suffix.replace(/^[ \t]+/, '')
  if (!s) return text

  // 模型从光标后的第一个词开始复述 → 直接丢弃。
  // 至少要连续命中 6 个字才算复述：3 个字太容易误伤，
  // 比如后文是“，而最后……”，补全从“，而系统……”开始，其实是新内容。
  if (s.length >= 6 && text.trimStart().startsWith(s.slice(0, 6))) return ''

  // 补全结尾与 suffix 开头重叠 → 去掉重叠部分。
  const max = Math.min(text.length, s.length, 40)
  for (let k = max; k >= 2; k--) {
    if (text.endsWith(s.slice(0, k))) {
      return text.slice(0, -k)
    }
  }

  return text
}

/** 模型偶尔会把整段话包在引号里。 */
function unwrapQuotes(text) {
  const t = text.trim()
  if (t.length < 4) return text
  const pairs = [
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"]
  ]
  for (const [open, close] of pairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length > open.length + close.length) {
      const inner = t.slice(open.length, t.length - close.length)
      if (inner.trim() && !inner.includes(open) && !inner.includes(close)) return inner
    }
  }
  return text
}

/**
 * 找到第 maxSentences 个句末的位置（返回切点，找不到返回 -1）。
 * 中文按 。！？； 切；英文按 . 后跟空白切；空行也算一次结束。
 */
function findSentenceEnd(text, maxSentences) {
  let start = 0
  while (start < text.length && /\s/.test(text[start])) start++

  let count = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    let isEnd = STRONG_END.has(ch)

    if (!isEnd && ch === '.') {
      const next = i + 1 < text.length ? text[i + 1] : ''
      const prev = i > 0 ? text[i - 1] : ''
      if ((!next || /[\s"'”’)\]]/.test(next)) && !/[0-9]/.test(prev)) isEnd = true
    }

    if (!isEnd && ch === '\n' && text[i + 1] === '\n') isEnd = true
    if (!isEnd) continue

    count++
    if (count >= maxSentences) {
      // 空行本身就是一个段落结束，保留两个换行。
      if (ch === '\n' && text[i + 1] === '\n') return i + 2
      let j = i + 1
      while (j < text.length && CLOSERS.has(text[j])) j++
      return j
    }
  }

  return -1
}

function lastSentenceEnd(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (STRONG_END.has(ch)) {
      let j = i + 1
      while (j < text.length && CLOSERS.has(text[j])) j++
      return j
    }
    if (ch === '.' && !/\d/.test(text[i - 1] || '')) {
      const next = text[i + 1] || ''
      if (!next || /[\s"'”’)\]]/.test(next)) return i + 1
    }
  }
  return -1
}

/**
 * 长续写要插入整段文字，因此必须停在完整句上。
 * 如果模型被 max_tokens 截断在半句话，退回上一个句末。
 */
function ensureCompleteEnding(text) {
  if (!text) return text
  const t = text.replace(/[ \t]+$/gm, '').trimEnd()
  if (!t) return ''

  // 句末标点后面允许跟引号/括号。
  const tail = t.replace(/[”’」』）)\]】"']+$/, '')
  if (/[。！？；…!?;]$/.test(tail)) return t

  const end = lastSentenceEnd(t)
  if (end > 0) return t.slice(0, end).trimEnd()
  return t
}

function cutToChars(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)

  const end = lastSentenceEnd(head)
  if (end > maxChars * 0.55) return head.slice(0, end)

  // 英文尽量断在空格，避免半个单词。
  if (/[A-Za-z]/.test(head.slice(-40))) {
    const space = head.lastIndexOf(' ')
    if (space > maxChars * 0.65) return head.slice(0, space)
  }

  return head
}

function limitSentences(text, maxSentences, maxChars) {
  let out = text
  const cut = findSentenceEnd(out, maxSentences)
  if (cut > 0) out = out.slice(0, cut)
  if (out.length > maxChars) out = cutToChars(out, maxChars)
  return out
}

/**
 * 中英文混排的边界修正：
 * - 中文后接中文：不要空格
 * - 中文后接英文/数字：补一个空格
 * - 英文后接英文/数字：补一个空格
 */
/**
 * 中文语境的标点修正：模型经常在中文里混用半角标点。
 * 只在补全内容以中文为主时启用，避免改动英文。
 */
function normalizePunctuation(text) {
  if (!text) return text

  const cjk = (text.match(/[㐀-鿿]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  if (cjk < 2 || latin > cjk) return text

  return text
    .replace(/\.\.\./g, '……')
    .replace(/([㐀-鿿])[ \t]*,/g, '$1，')
    .replace(/([㐀-鿿])[ \t]*;/g, '$1；')
    .replace(/([㐀-鿿])[ \t]*:/g, '$1：')
    .replace(/([㐀-鿿])[ \t]*\?/g, '$1？')
    .replace(/([㐀-鿿])[ \t]*!/g, '$1！')
    .replace(/([㐀-鿿])\.(?![0-9])/g, '$1。')
}

function ensureSpacing(text, prevChar) {
  if (!text) return text

  const first = text[0]
  if (!first || first === '\n' || first === '\r') return text
  if (!prevChar) return text

  const prevCJK = CJK_RE.test(prevChar)
  const firstCJK = CJK_RE.test(first)
  const prevWord = LATIN_WORD_RE.test(prevChar)
  const firstWord = LATIN_WORD_RE.test(first)

  if (prevCJK && firstCJK) return text.replace(/^[ \t]+/, '')
  if (prevCJK && firstWord) return ' ' + text.replace(/^[ \t]+/, '')
  if (prevWord && firstWord) return ' ' + text
  if (prevChar === ' ' || prevChar === '\t') return text.replace(/^[ \t]+/, '')

  return text
}

function finalize(raw, ctx, opts) {
  if (typeof raw !== 'string' || !raw) return ''

  const maxSentences = opts && opts.maxSentences ? opts.maxSentences : 2
  const maxChars = opts && opts.maxChars ? opts.maxChars : 220

  let text = raw.replace(/\r\n?/g, '\n')
  text = stripInstructionEcho(text)
  text = stripEchoedPrefix(text, ctx && ctx.pre ? ctx.pre : '')
  if (ctx && ctx.suffix) text = reconcileSuffix(text, ctx.suffix)
  text = unwrapQuotes(text)
  text = normalizePunctuation(text)
  text = limitSentences(text, maxSentences, maxChars)
  text = text.replace(/\n{3,}/g, '\n\n')
  text = ensureSpacing(text, ctx && ctx.prevChar ? ctx.prevChar : '')
  text = text.replace(/[ \t]+$/gm, '')

  return text.trimEnd()
}

/** 质量闸门：宁可不显示，也不要显示垃圾。 */
function isLowQuality(text, ctx) {
  if (!text) return true
  const t = text.trim()
  if (!t) return true
  if (t.length === 1 && !/[㐀-鿿]/.test(t)) return true
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true
  if (/^\s*（?\s*(?:写作设定|文档位置|续写要求)/.test(t)) return true
  if (/^\s*(?:额外要求|只输出正文)[:：]?/.test(t)) return true
  if (t.includes('```')) return true
  if (t.includes('\u0000')) return true

  const pre = ctx && ctx.pre ? ctx.pre.trimEnd() : ''
  if (pre.length >= 8 && t.startsWith(pre.slice(-8))) return true
  if (pre.length >= 20 && pre.endsWith(t)) return true

  const suffix = ctx && ctx.suffix ? ctx.suffix.trimStart() : ''
  if (suffix.length >= 8 && t.startsWith(suffix.slice(0, 8))) return true

  return false
}

/** 流式请求的提前结束条件。 */
function shouldStop(text, maxSentences, maxChars) {
  if (!text) return false
  if (text.length >= maxChars) return true
  return findSentenceEnd(text, maxSentences) > 0
}

module.exports = {
  stripEchoedPrefix,
  stripInstructionEcho,
  reconcileSuffix,
  unwrapQuotes,
  findSentenceEnd,
  limitSentences,
  normalizePunctuation,
  ensureSpacing,
  ensureCompleteEnding,
  finalize,
  isLowQuality,
  shouldStop
}
