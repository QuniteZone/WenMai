'use strict'

/*
 * 上下文构建：决定"模型到底能看到什么"。
 *
 * 经验：
 * - 光标前紧邻的 1~2 段最有价值，整篇文档的价值远小于它。
 * - 标题/大纲用一行元信息带上即可，不要为了它牺牲近处上下文。
 * - 中途截断时尽量落在行首，避免模型从一个字中间开始理解。
 */

const FENCE_LANGUAGES = new Set([
  'markdown',
  'mdx',
  'quarto',
  'asciidoc',
  'restructuredtext'
])

const FRONTMATTER_LANGUAGES = new Set(['markdown', 'mdx', 'quarto', 'rmd'])

// 这些语言里可能出现原始 HTML（Markdown 也允许内嵌 HTML）。
const HTML_LANGUAGES = new Set(['html', 'markdown', 'mdx', 'quarto', 'rmd'])

const MATH_ENVIRONMENTS = new Set([
  'math',
  'displaymath',
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'aligned',
  'alignedat',
  'flalign',
  'flalign*',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'split',
  'eqnarray',
  'eqnarray*',
  'cases',
  'cases*',
  'dcases',
  'dcases*',
  'rcases',
  'rcases*',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix'
])

const CODE_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
  'luacode',
  'luacode*'
])

function lineBefore(text, offset) {
  const nl = text.lastIndexOf('\n', offset - 1)
  return text.slice(nl + 1, offset)
}

/**
 * 判断是否仍在围栏代码块里。
 * 关闭围栏必须与开启围栏同字符、长度不短于开启围栏，且后面只能有空白，
 * 这样 ```` 包住 ``` 的写法也不会被误判成关闭。
 */
function fenceState(text, offset) {
  const before = text.slice(0, offset)
  const re = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/gm
  let open = null
  let match
  while ((match = re.exec(before)) !== null) {
    const fence = match[2]
    const ch = fence[0]
    if (!open) {
      open = { ch, len: fence.length }
    } else if (ch === open.ch && fence.length >= open.len && !match[3].trim()) {
      open = null
    }
  }
  return Boolean(open)
}

function inFrontmatter(text, offset) {
  // 开头的分隔线必须正好是 ---，`----` 是普通正文，不能当 frontmatter。
  if (!/^---[ \t]*\r?\n/.test(text)) return false

  const firstLineEnd = text.indexOf('\n')
  const close = /^(?:---|\.\.\.)[ \t]*\r?$/gm
  close.lastIndex = firstLineEnd + 1
  const match = close.exec(text)
  if (!match) return false

  return offset <= match.index + match[0].length
}

/**
 * 行内代码：按 CommonMark 的"同长度反引号串配对"规则判断。
 * 不能只数奇偶——``map`` 这种双反引号写法会被数成偶数而漏判。
 */
function inInlineCode(line) {
  const re = /`+/g
  let openLen = 0
  let match
  while ((match = re.exec(line)) !== null) {
    const len = match[0].length
    if (!openLen) openLen = len
    else if (len === openLen) openLen = 0
  }
  return openLen > 0
}

/**
 * LaTeX / Typst 的公式与代码环境。
 * 覆盖：$...$、$$...$$（含跨行）、\[...\]、equation/align 等环境、
 * verbatim/lstlisting/minted 等代码环境。
 */
function mathOrCodeState(text, offset, languageId) {
  const before = text.slice(0, offset)
  const envStack = []
  let inlineMath = false
  let parenMath = false
  let displayMath = false
  let bracketMath = false
  let escaped = false

  for (let i = 0; i < before.length; i++) {
    const ch = before[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\') {
      if (before.startsWith('\\[', i)) {
        bracketMath = true
        i++
        continue
      }
      if (before.startsWith('\\]', i)) {
        bracketMath = false
        i++
        continue
      }
      if (before.startsWith('\\(', i)) {
        parenMath = true
        i++
        continue
      }
      if (before.startsWith('\\)', i)) {
        parenMath = false
        i++
        continue
      }
      if (before.startsWith('\\begin{', i)) {
        const end = before.indexOf('}', i + 7)
        if (end !== -1) {
          const env = before.slice(i + 7, end)
          if (MATH_ENVIRONMENTS.has(env) || CODE_ENVIRONMENTS.has(env)) envStack.push(env)
          i = end
          continue
        }
      }
      if (before.startsWith('\\end{', i)) {
        const end = before.indexOf('}', i + 5)
        if (end !== -1) {
          const env = before.slice(i + 5, end)
          const index = envStack.lastIndexOf(env)
          if (index !== -1) envStack.splice(index, 1)
          i = end
          continue
        }
      }
      escaped = true
      continue
    }

    // LaTeX 注释：% 到行尾，注释里的 $ 不算公式。
    if (ch === '%' && (languageId === 'latex' || languageId === 'tex')) {
      const nl = before.indexOf('\n', i)
      if (nl === -1) break
      i = nl
      continue
    }

    if (ch === '$') {
      if (before[i + 1] === '$') {
        displayMath = !displayMath
        i++
      } else if (!displayMath) {
        inlineMath = !inlineMath
      }
    }
  }

  if (displayMath || bracketMath || inlineMath || parenMath) return '光标在公式中'
  if (envStack.length > 0) {
    return envStack.some((env) => CODE_ENVIRONMENTS.has(env))
      ? '光标在代码环境中'
      : '光标在公式环境中'
  }
  return null
}

/** 未闭合的 <script>、<style>、HTML 注释。 */
function inHtmlRawBlock(text, offset) {
  const before = text.slice(0, offset).toLowerCase()

  if (before.lastIndexOf('<script') > before.lastIndexOf('</script')) return true
  if (before.lastIndexOf('<style') > before.lastIndexOf('</style')) return true
  if (before.lastIndexOf('<!--') > before.lastIndexOf('-->')) return true
  return false
}

function inUrl(line) {
  if (/(?:https?:\/\/|www\.)[^\s)]*$/i.test(line)) return true
  if (/\[[^\]]*\]\([^)]*$/.test(line)) return true
  return false
}

function contextStart(text, offset, budget) {
  let start = Math.max(0, offset - budget)
  if (start <= 0) return 0

  // 不要从代理对中间切开（emoji 等）。
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start++

  // 如果附近就有行首，从行首开始，语义更完整。
  const nl = text.indexOf('\n', start)
  if (nl !== -1 && nl < offset && nl - start <= 160) start = nl + 1

  return start
}

function markdownMeta(text, offset) {
  const before = text.slice(0, offset)
  const headings = []
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm
  let match
  while ((match = re.exec(before)) !== null) {
    const title = match[2].replace(/[#*_`]/g, '').trim().slice(0, 40)
    if (title) headings.push({ level: match[1].length, title })
  }
  if (headings.length === 0) return ''

  const stack = []
  for (const heading of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack.push(heading)
  }

  const path = stack.map((item) => item.title).join(' > ')
  if (!path) return ''
  const clipped = path.length > 70 ? path.slice(0, 68) + '…' : path
  return `（文档位置：${clipped}）`
}

function takeSuffix(text, offset, maxChars) {
  if (!maxChars || maxChars <= 0) return ''
  // 光标后也纳入预算：让模型知道接下来要接什么，避免写出与后文冲突的内容。
  // 不在这里按空行截断——光标正好停在段末时，后文才是判断走向的关键。
  let out = text.slice(offset, offset + maxChars)
  const last = out.charCodeAt(out.length - 1)
  // 不要从代理对中间截断（emoji 等）。
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

function findSkipReason({ text, offset, languageId, pre, cfg, long }) {
  // 空文档放在前面判断：否则空文档会报“光标在文档开头”，提示不准确。
  if (!text.trim()) return '文档为空'
  if (offset <= 0) return '光标在文档开头'
  if (pre.trim().length < (long ? Math.min(cfg.minPromptChars, 2) : cfg.minPromptChars)) {
    return '光标前内容太短'
  }

  const line = lineBefore(text, offset)

  if (cfg.proseOnly) {
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) return '正在输入代码围栏'
    if (inInlineCode(line)) return '光标在行内代码中'
    if (inUrl(line)) return '光标在链接/URL 中'
    if (HTML_LANGUAGES.has(languageId) && /<\/?[A-Za-z][^>]*$/.test(line)) {
      return '光标在 HTML 标签中'
    }
    if (HTML_LANGUAGES.has(languageId) && inHtmlRawBlock(text, offset)) {
      return '光标在 HTML 脚本/样式/注释中'
    }
    if (FENCE_LANGUAGES.has(languageId) && fenceState(text, offset)) return '光标在代码块中'
    if (FRONTMATTER_LANGUAGES.has(languageId) && inFrontmatter(text, offset)) {
      return '光标在 frontmatter 中'
    }
    if (languageId === 'latex' || languageId === 'typst') {
      const state = mathOrCodeState(text, offset, languageId)
      if (state) return state
    }
  }

  return null
}

/**
 * @param {object} input
 * @param {string} input.text 整篇文档
 * @param {number} input.offset 光标在文档中的字符偏移
 * @param {string} input.languageId VS Code languageId
 * @param {object} input.cfg readConfig() 的结果
 * @param {boolean} [input.long] 是否为长续写（更大的上下文预算）
 */
function buildContext({ text, offset, languageId, cfg, long = false }) {
  const safeOffset = Math.min(Math.max(0, Number(offset) || 0), text.length)
  const preBudget = long ? cfg.longPrefixChars : cfg.prefixChars
  const start = contextStart(text, safeOffset, preBudget)
  const pre = text.slice(start, safeOffset)

  const skip = findSkipReason({
    text,
    offset: safeOffset,
    languageId: String(languageId || '').toLowerCase(),
    pre,
    cfg,
    long
  })

  if (skip) {
    return { skip, pre: '', suffix: '', metaLine: '', prevChar: '', offset: safeOffset }
  }

  const lang = String(languageId || '').toLowerCase()
  const suffixBudget = long ? Math.max(cfg.suffixChars, 400) : cfg.suffixChars
  const suffix = takeSuffix(text, safeOffset, suffixBudget)
  const metaLine = FRONTMATTER_LANGUAGES.has(lang) ? markdownMeta(text, safeOffset) : ''
  const prevChar = safeOffset > 0 ? text[safeOffset - 1] : ''

  return {
    skip: null,
    pre,
    suffix,
    metaLine,
    prevChar,
    offset: safeOffset,
    languageId: lang
  }
}

function buildPrompt(guideline, metaLine, pre) {
  return [guideline, metaLine, pre].filter(Boolean).join('\n')
}

module.exports = {
  buildContext,
  buildPrompt,
  lineBefore,
  fenceState,
  inFrontmatter,
  inInlineCode,
  inHtmlRawBlock,
  mathOrCodeState,
  inUrl,
  markdownMeta,
  takeSuffix
}
