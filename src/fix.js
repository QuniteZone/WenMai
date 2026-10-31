'use strict'

/*
 * L1 本地修正：不联网、不消耗 token，只处理"确定是错"的格式问题。
 *
 * 设计原则：
 * 1. 宁可不改，也不要改错。拿不准的（例如单个 # 后面跟中文、* 开头的行）
 *    一律不动，留给人工或 L2 的 AI 修正。
 * 2. 只动光标所在行；预览与应用都只针对与修正结果有差异的字符片段。
 * 3. Markdown 里保护行内代码、URL、HTML 标签、数学公式；LaTeX 里保护注释、
 *    \verb、\text 等内容，避免把代码/标签/公式当成正文改掉。
 */

const {
  fenceState,
  inFrontmatter,
  inHtmlRawBlock,
  mathOrCodeState
} = require('./context')

const MARKDOWN_LANGUAGES = new Set(['markdown', 'mdx', 'quarto', 'rmd'])
const LATEX_LANGUAGES = new Set(['latex', 'tex'])

const CJK_RANGE = '\\u3400-\\u9FFF\\uF900-\\uFAFF'
const CJK_RE = new RegExp(`[${CJK_RANGE}]`)
const CJK_G = new RegExp(`[${CJK_RANGE}]`, 'g')
const LATIN_G = /[A-Za-z]/g

const BLOCKQUOTE_RE = /^( {0,3}(?:> ?)+)/
const HEADING_RE = /^( {0,3})(#{1,6})([^\s#].*)$/
const TASK_RE = /^( {0,3})([-+*])([ \t]+)(\[[ xX]\])([^\s].*)$/
const UNORDERED_RE = /^( {0,3})([-+])([^\s\-+].*)$/
const ORDERED_RE = /^( {0,3})(\d{1,9})([.)])([^\s].*)$/

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

// 参数是正文的命令：保留参数内容，允许做中文标点/中英文空格修正。
const TEXT_COMMANDS = new Set([
  'text',
  'mbox',
  'hbox',
  'textrm',
  'textnormal',
  'textup',
  'textit',
  'textbf',
  'textsf',
  'texttt',
  'textsc',
  'emph',
  'underline',
  'footnote',
  'footnotetext',
  'thanks',
  'marginpar',
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
  'intertext',
  'shortintertext',
  'caption',
  'subcaption',
  'title',
  'author',
  'date',
  'textcolor',
  'texorpdfstring'
])

// 参数是标签、路径、URL 或代码的命令：整段保护，不做公式/正文标点转换。
const PROTECT_COMMANDS = new Set([
  'url',
  'href',
  'label',
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'autopageref',
  'nameref',
  'vref',
  'cref',
  'Cref',
  'crefrange',
  'Crefrange',
  'cpageref',
  'Cpageref',
  'cite',
  'citep',
  'citet',
  'citealp',
  'citeauthor',
  'citeyear',
  'input',
  'include',
  'includegraphics',
  'graphicspath',
  'DeclareGraphicsExtensions',
  'usepackage',
  'documentclass',
  'bibliography',
  'bibliographystyle',
  'newcommand',
  'renewcommand',
  'providecommand',
  'newenvironment',
  'renewenvironment',
  'newlength',
  'newsavebox',
  'savebox',
  'sbox',
  'usebox',
  'setlength',
  'setcounter',
  'addtolength',
  'newtheorem',
  'DeclareMathOperator',
  'sisetup',
  'hypersetup',
  'geometry',
  'captionsetup',
  'tikzset',
  'pgfplotsset',
  'definecolor',
  'color',
  'pagecolor'
])

const MASK_COMMANDS = new Set([...TEXT_COMMANDS, ...PROTECT_COMMANDS])

// 这些命令后面的内容是宏定义/赋值，整行保护。
const REST_OF_LINE_COMMANDS = new Set([
  'def',
  'edef',
  'gdef',
  'xdef',
  'let',
  'futurelet',
  'newif',
  'catcode',
  'lccode',
  'uccode',
  'mathcode',
  'delcode',
  'count',
  'dimen',
  'skip',
  'muskip',
  'toks'
])

const FULLWIDTH_MAP = {
  '，': ',',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '！': '!',
  '？': '?',
  '。': '.',
  '、': ','
}

const URL_RE =
  /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/gi
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const LINK_DEST_RE = /\]\(([^)\s]*)\)/g
const HTML_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g
const ENTITY_RE = /&(?:[A-Za-z][A-Za-z0-9]+|#\d+|#x[0-9A-Fa-f]+);/g
const ESCAPE_RE = /\\[\\`*_{}\[\]()#+\-.!|>~]/g

const CJK_LEFT_COMMA_RE = new RegExp(`([${CJK_RANGE}])[ \\t]*,`, 'g')
const CJK_LEFT_SEMI_RE = new RegExp(`([${CJK_RANGE}])[ \\t]*;`, 'g')
const CJK_LEFT_COLON_RE = new RegExp(`([${CJK_RANGE}])[ \\t]*:`, 'g')
const CJK_LEFT_QUESTION_RE = new RegExp(`([${CJK_RANGE}])[ \\t]*\\?`, 'g')
const CJK_LEFT_BANG_RE = new RegExp(`([${CJK_RANGE}])[ \\t]*!`, 'g')
const CJK_LEFT_DOT_RE = new RegExp(`([${CJK_RANGE}])[ \\t]*\\.(?![0-9])`, 'g')
const COMMA_BEFORE_CJK_RE = new RegExp(`,(?=\\s*[${CJK_RANGE}])`, 'g')
const SEMI_BEFORE_CJK_RE = new RegExp(`;(?=\\s*[${CJK_RANGE}])`, 'g')
const COLON_BEFORE_CJK_RE = new RegExp(`:(?=\\s*[${CJK_RANGE}])`, 'g')
const QUESTION_BEFORE_CJK_RE = new RegExp(`\\?(?=\\s*[${CJK_RANGE}])`, 'g')
const BANG_BEFORE_CJK_RE = new RegExp(`!(?=\\s*[${CJK_RANGE}])`, 'g')

const CJK_LATIN_RE = new RegExp(`([${CJK_RANGE}])([A-Za-z])`, 'g')
const LATIN_CJK_RE = new RegExp(`([A-Za-z])([${CJK_RANGE}])`, 'g')

const DUPLICATE_PAIRS = [
  ['，', ','],
  ['。', '.'],
  ['！', '!'],
  ['？', '?'],
  ['；', ';'],
  ['：', ':'],
  ['、', ',']
]

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MATH_ENV_PATTERN = [...MATH_ENVIRONMENTS].map(escapeRegExp).join('|')
const MATH_ENV_RE = new RegExp(
  `\\\\begin\\{(${MATH_ENV_PATTERN})\\}[\\s\\S]*?\\\\end\\{\\1\\}`,
  'g'
)

function lineAtOffset(text, offset) {
  const safe = Math.min(Math.max(0, Number(offset) || 0), text.length)
  const lineStart = text.lastIndexOf('\n', safe - 1) + 1
  let lineEnd = text.indexOf('\n', safe)
  if (lineEnd === -1) lineEnd = text.length

  let lineText = text.slice(lineStart, lineEnd)
  const hasCR = lineText.endsWith('\r')
  if (hasCR) lineText = lineText.slice(0, -1)

  return {
    lineStart,
    lineEnd: hasCR ? lineEnd - 1 : lineEnd,
    lineText
  }
}

function isEscaped(text, index) {
  let count = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) count++
  return count % 2 === 1
}

function markRange(flags, start, end) {
  const from = Math.max(0, start)
  const to = Math.min(flags.length, end)
  for (let i = from; i < to; i++) flags[i] = true
}

function markInlineCode(line, flags) {
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`' || isEscaped(line, i)) {
      i++
      continue
    }

    const start = i
    while (i < line.length && line[i] === '`') i++
    const len = i - start

    let j = i
    let close = -1
    while (j < line.length) {
      if (line[j] !== '`' || isEscaped(line, j)) {
        j++
        continue
      }
      const runStart = j
      while (j < line.length && line[j] === '`') j++
      if (j - runStart === len) {
        close = j
        break
      }
    }

    if (close === -1) {
      markRange(flags, start, line.length)
      return
    }
    markRange(flags, start, close)
    i = close
  }
}

function markUrls(line, flags) {
  line.replace(URL_RE, (match, offset) => {
    let end = match.length
    while (end > 0 && /[.,;:!?，。；：！？、]/.test(match[end - 1])) end--
    if (end > 0) markRange(flags, offset, offset + end)
    return match
  })

  line.replace(EMAIL_RE, (match, offset) => {
    markRange(flags, offset, offset + match.length)
    return match
  })
}

function markMarkdownLinks(line, flags) {
  line.replace(LINK_DEST_RE, (match, dest, offset) => {
    if (dest) {
      const destStart = offset + match.indexOf(dest)
      markRange(flags, destStart, destStart + dest.length)
    }
    return match
  })
}

function markHtml(line, flags) {
  line.replace(HTML_RE, (match, offset) => {
    markRange(flags, offset, offset + match.length)
    return match
  })
}

function markEscapes(line, flags) {
  line.replace(ESCAPE_RE, (match, offset) => {
    markRange(flags, offset, offset + match.length)
    return match
  })
}

function markEntities(line, flags) {
  line.replace(ENTITY_RE, (match, offset) => {
    markRange(flags, offset, offset + match.length)
    return match
  })
}

function markDollarMath(line, flags) {
  let i = 0
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] !== '$' || isEscaped(line, i)) {
      i++
      continue
    }

    const double = line[i + 1] === '$'
    const openLen = double ? 2 : 1
    let j = i + openLen
    let close = -1

    while (j < line.length) {
      if (line[j] === '\\') {
        j += 2
        continue
      }
      if (double && line[j] === '$' && line[j + 1] === '$') {
        close = j
        break
      }
      if (!double && line[j] === '$') {
        close = j
        break
      }
      j++
    }

    if (close === -1) {
      markRange(flags, i, line.length)
      return
    }

    markRange(flags, i, close + openLen)
    i = close + openLen
  }
}

function markMath(line, flags) {
  MATH_ENV_RE.lastIndex = 0
  line.replace(MATH_ENV_RE, (match, offset) => {
    markRange(flags, offset, offset + match.length)
    return match
  })

  markDollarMath(line, flags)

  for (const re of [/\\\([\s\S]*?\\\)/g, /\\\[[\s\S]*?\\\]/g]) {
    line.replace(re, (match, offset) => {
      markRange(flags, offset, offset + match.length)
      return match
    })
  }
}

function markMarkdownProtected(line, flags) {
  markEscapes(line, flags)
  markInlineCode(line, flags)
  markUrls(line, flags)
  markMarkdownLinks(line, flags)
  markHtml(line, flags)
  markEntities(line, flags)
  markMath(line, flags)
}

function fixCjkLatinSpacing(text) {
  if (!text || !CJK_RE.test(text)) return text
  return text.replace(CJK_LATIN_RE, '$1 $2').replace(LATIN_CJK_RE, '$1 $2')
}

/**
 * 输入法拼音（如 yinci）和正在敲的英文单词，都会在光标旁出现连续的字母。
 * 这时“中英文之间补空格”的规则会把未输完的字母当成正文，预览和 AI 抑制
 * 都会打断写作。用两个条件识别“正在输入”：
 * - 光标紧贴字母（字母在光标前或光标后）；
 * - 整行差异仅是中英文之间的空格，没有标点等其他修正。
 */
function isTypingNextToLatin(lineText, column) {
  const before = lineText[column - 1] || ''
  const after = lineText[column] || ''
  return /[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)
}

function isCjkLatinSpacingOnly(oldText, newText) {
  const squeezed = String(newText)
    .replace(new RegExp(`([${CJK_RANGE}]) +(?=[A-Za-z])`, 'g'), '$1')
    .replace(new RegExp(`([A-Za-z]) +(?=[${CJK_RANGE}])`, 'g'), '$1')
  return squeezed === oldText
}

function collapseDuplicatePunctuation(text) {
  let out = text
  out = out.replace(/([，。！？；：、])\1+/g, '$1')

  for (const [full, half] of DUPLICATE_PAIRS) {
    const f = escapeRegExp(full)
    const h = escapeRegExp(half)
    out = out.replace(new RegExp(`${h}+${f}`, 'g'), full)
    out = out.replace(new RegExp(`${f}${h}+`, 'g'), full)
  }

  out = out.replace(/([，。！？；：、])\1+/g, '$1')
  out = out.replace(/……\.+/g, '……').replace(/\.+……/g, '……')
  return out
}

function fixPunctuation(text) {
  if (!text) return text

  const cjkCount = (text.match(CJK_G) || []).length
  if (cjkCount === 0) return text

  const latinCount = (text.match(LATIN_G) || []).length
  // 以中文为主才动标点，避免把英文句子里的逗号、句号改掉。
  if (cjkCount < 2 || latinCount > cjkCount * 2) return text

  let out = text.replace(/\.\.\./g, '……')
  out = out.replace(CJK_LEFT_COMMA_RE, '$1，')
  out = out.replace(CJK_LEFT_SEMI_RE, '$1；')
  out = out.replace(CJK_LEFT_COLON_RE, '$1：')
  out = out.replace(CJK_LEFT_QUESTION_RE, '$1？')
  out = out.replace(CJK_LEFT_BANG_RE, '$1！')
  out = out.replace(CJK_LEFT_DOT_RE, '$1。')

  out = out.replace(COMMA_BEFORE_CJK_RE, '，')
  out = out.replace(SEMI_BEFORE_CJK_RE, '；')
  out = out.replace(COLON_BEFORE_CJK_RE, '：')
  out = out.replace(QUESTION_BEFORE_CJK_RE, '？')
  out = out.replace(BANG_BEFORE_CJK_RE, '！')

  return collapseDuplicatePunctuation(out)
}

function fixMarkdownProse(line, options) {
  const flags = new Array(line.length).fill(false)
  markMarkdownProtected(line, flags)

  let out = ''
  let i = 0
  while (i < line.length) {
    if (flags[i]) {
      let j = i
      while (j < line.length && flags[j]) j++
      out += line.slice(i, j)
      i = j
      continue
    }

    let j = i
    while (j < line.length && !flags[j]) j++
    let segment = line.slice(i, j)
    segment = fixPunctuation(segment)
    if (!options || options.fixCjkLatinSpacing !== false) {
      segment = fixCjkLatinSpacing(segment)
    }
    out += segment
    i = j
  }

  return out
}

function fixHeading(line) {
  const match = HEADING_RE.exec(line)
  if (!match) return null

  const [, indent, hashes, content] = match
  if (hashes.length === 1 && !/^[0-9一二三四五六七八九十百千万]/.test(content)) {
    // #tag 在 Obsidian 等工具里是标签，不能贸然改成 "# tag"。
    return null
  }
  return `${indent}${hashes} ${content}`
}

function fixList(line) {
  const task = TASK_RE.exec(line)
  if (task) {
    return `${task[1]}${task[2]}${task[3]}${task[4]} ${task[5]}`
  }

  const unordered = UNORDERED_RE.exec(line)
  if (unordered) {
    // “-1.5 倍”“+3%”开头的是数字，不是漏了空格的列表项。宁可不改。
    if (/^\d/.test(unordered[3])) return null
    return `${unordered[1]}${unordered[2]} ${unordered[3]}`
  }

  const ordered = ORDERED_RE.exec(line)
  if (ordered) {
    // 1.5 不是列表，是小数；1)2 也可能是引用，先不动。
    if (/^\d/.test(ordered[4])) return null
    return `${ordered[1]}${ordered[2]}${ordered[3]} ${ordered[4]}`
  }

  return null
}

function fixMarkdownLine(line, options) {
  let out = line
  const changes = []

  // 引用块里的标题/列表：> ##3.内容、> -内容 也要能修。
  const quote = BLOCKQUOTE_RE.exec(out)
  const quotePrefix = quote ? quote[0] : ''
  let body = quote ? out.slice(quotePrefix.length) : out

  const heading = fixHeading(body)
  if (heading) {
    body = heading
    changes.push('标题空格')
  }

  const list = fixList(body)
  if (list) {
    body = list
    changes.push('列表空格')
  }

  out = quotePrefix + body

  const prose = fixMarkdownProse(out, options)
  if (prose !== out) {
    out = prose
    changes.push('中文标点/空格')
  }

  if (out === line) return null
  return { oldText: line, newText: out, changes }
}

function findCommentIndex(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && !isEscaped(line, i)) return i
  }
  return -1
}

function findMatchingBrace(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findMatchingBracket(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '[') depth++
    else if (text[i] === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * LaTeX 正文保护的标记：
 * - 数学范围整体保护；
 * - \verb / \lstinline / \mintinline 已经替换成 token，不会命中；
 * - 非正文命令（\frac、\label、\ref 等）连参数一起保护；
 * - 正文命令（\section、\textbf、\text 等）只保护命令名，参数继续按正文处理。
 */
function markLatexProtected(code, flags, inMath, mathKind) {
  const mathRanges = getMathRanges(code, Boolean(inMath), mathKind)
  for (const [start, end] of mathRanges) markRange(flags, start, end)
  markUrls(code, flags)

  let i = 0
  while (i < code.length) {
    if (code[i] !== '\\') {
      i++
      continue
    }

    if (code[i + 1] === '\\') {
      markRange(flags, i, i + 2)
      i += 2
      continue
    }

    const match = /^\\([A-Za-z]+)\*?/.exec(code.slice(i))
    if (!match) {
      markRange(flags, i, Math.min(code.length, i + 2))
      i += 2
      continue
    }

    const name = match[1]
    const nameEnd = i + match[0].length

    if (REST_OF_LINE_COMMANDS.has(name)) {
      markRange(flags, i, code.length)
      return
    }

    if (TEXT_COMMANDS.has(name)) {
      // 命令名本身是 Latin，不能参与"中文为主"的判断；参数保留。
      markRange(flags, i, nameEnd)
      i = nameEnd
      continue
    }

    markRange(flags, i, nameEnd)
    i = nameEnd

    while (i < code.length && code[i] === '[') {
      const end = findMatchingBracket(code, i)
      if (end === -1) {
        markRange(flags, i, code.length)
        return
      }
      markRange(flags, i, end + 1)
      i = end + 1
    }

    while (i < code.length && code[i] === '{') {
      const end = findMatchingBrace(code, i)
      if (end === -1) {
        markRange(flags, i, code.length)
        return
      }
      markRange(flags, i, end + 1)
      i = end + 1
    }
  }
}

function normalizeLatexProse(code, options) {
  const flags = new Array(code.length).fill(false)
  markLatexProtected(
    code,
    flags,
    Boolean(options && options.inMath),
    options && options.mathKind
  )

  let out = ''
  let i = 0
  while (i < code.length) {
    if (flags[i]) {
      let j = i
      while (j < code.length && flags[j]) j++
      out += code.slice(i, j)
      i = j
      continue
    }

    let j = i
    while (j < code.length && !flags[j]) j++
    let segment = code.slice(i, j)
    segment = fixPunctuation(segment)
    if (!options || options.fixCjkLatinSpacing !== false) {
      segment = fixCjkLatinSpacing(segment)
    }
    out += segment
    i = j
  }

  return out
}

function maskVerbs(line) {
  const saved = []
  const makeToken = (value) => {
    const token = `\u0001${saved.length}\u0001`
    saved.push(value)
    return token
  }

  // \verb|...|、\lstinline[opts]|...|、\mintinline{lang}|...| 都是行内代码。
  let masked = line.replace(
    /\\(?:verb|lstinline|mintinline)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?([^A-Za-z\s])([\s\S]*?)\1/g,
    (match) => makeToken(match)
  )
  masked = masked.replace(
    /\\(?:verb|lstinline|mintinline)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?([^A-Za-z\s])([\s\S]*)$/,
    (match) => makeToken(match)
  )

  return { masked, saved }
}

function maskLatexCommands(code) {
  const saved = []
  let out = ''
  let i = 0

  while (i < code.length) {
    if (code[i] !== '\\') {
      out += code[i]
      i++
      continue
    }

    const nameMatch = /^\\([A-Za-z]+)\*?/.exec(code.slice(i))
    if (
      nameMatch &&
      REST_OF_LINE_COMMANDS.has(nameMatch[1])
    ) {
      const token = `\u0002${saved.length}\u0002`
      saved.push(code.slice(i))
      out += token
      i = code.length
      continue
    }

    const match = /^\\([A-Za-z]+)\*?\s*\{/.exec(code.slice(i))
    if (!match || !MASK_COMMANDS.has(match[1])) {
      out += code[i]
      i++
      continue
    }

    let braceStart = i + match[0].length - 1
    let braceEnd = findMatchingBrace(code, braceStart)
    if (braceEnd === -1) {
      out += code[i]
      i++
      continue
    }

    let end = braceEnd
    let next = end + 1
    while (code[next] === '{') {
      const nextEnd = findMatchingBrace(code, next)
      if (nextEnd === -1) break
      end = nextEnd
      next = end + 1
    }

    const token = `\u0002${saved.length}\u0002`
    saved.push(code.slice(i, end + 1))
    out += token
    i = end + 1
  }

  return { masked: out, saved }
}

function fixMismatchedEnvironment(code) {
  const begins = [...code.matchAll(/\\begin\{([^}]*)\}/g)]
  const ends = [...code.matchAll(/\\end\{([^}]*)\}/g)]

  if (begins.length !== 1 || ends.length !== 1) return code
  if (begins[0].index > ends[0].index) return code

  const beginName = begins[0][1]
  const endName = ends[0][1]
  if (beginName === endName) return code

  const start = ends[0].index
  return (
    code.slice(0, start) +
    `\\end{${beginName}}` +
    code.slice(start + ends[0][0].length)
  )
}

function collectDollarRanges(code, ranges) {
  let i = 0
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2
      continue
    }
    if (code[i] !== '$' || isEscaped(code, i)) {
      i++
      continue
    }

    const double = code[i + 1] === '$'
    const openLen = double ? 2 : 1
    let j = i + openLen
    let close = -1

    while (j < code.length) {
      if (code[j] === '\\') {
        j += 2
        continue
      }
      if (double && code[j] === '$' && code[j + 1] === '$') {
        close = j
        break
      }
      if (!double && code[j] === '$') {
        close = j
        break
      }
      j++
    }

    if (close === -1) {
      ranges.push([i + openLen, code.length])
      return
    }

    ranges.push([i + openLen, close])
    i = close + openLen
  }
}

function collectParenMathRanges(code, ranges) {
  for (const re of [/\\\([\s\S]*?\\\)/g, /\\\[[\s\S]*?\\\]/g]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(code)) !== null) {
      const start = match.index + 2
      const end = match.index + match[0].length - 2
      if (end >= start) ranges.push([start, end])
    }
  }
}

function collectUnclosedEnvRanges(code, ranges) {
  const re = new RegExp(
    `\\\\(begin|end)\\{(${MATH_ENV_PATTERN})\\}`,
    'g'
  )
  const stack = []
  let match
  while ((match = re.exec(code)) !== null) {
    if (match[1] === 'begin') {
      stack.push({ name: match[2], contentStart: match.index + match[0].length })
    } else {
      const index = stack.map((item) => item.name).lastIndexOf(match[2])
      if (index !== -1) stack.splice(index, 1)
    }
  }
  for (const open of stack) {
    ranges.push([open.contentStart, code.length])
  }
}

function collectUnclosedBracketRanges(code, ranges) {
  for (const [open, close] of [
    ['\\(', '\\)'],
    ['\\[', '\\]']
  ]) {
    let index = 0
    while (index < code.length) {
      const start = code.indexOf(open, index)
      if (start === -1) break
      const end = code.indexOf(close, start + 2)
      if (end === -1) {
        ranges.push([start + 2, code.length])
        break
      }
      index = end + 2
    }
  }
}

function mergeRanges(ranges) {
  if (ranges.length < 2) return ranges
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  const merged = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const current = sorted[i]
    if (current[0] <= last[1]) last[1] = Math.max(last[1], current[1])
    else merged.push(current)
  }

  return merged
}

function inlineMathEnd(code) {
  // 行首已经在行内/行间公式里：找到本行的闭合符号，后面的正文不能再按公式改。
  let end = code.length
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\\') {
      if (code[i + 1] === ']' || code[i + 1] === ')') {
        end = Math.min(end, i)
        break
      }
      i++
      continue
    }
    if (code[i] === '$' && !isEscaped(code, i)) {
      end = Math.min(end, i)
      break
    }
  }
  return end
}

function getMathRanges(code, inMath, mathKind) {
  if (inMath) {
    if (mathKind === '光标在公式中') {
      return [[0, inlineMathEnd(code)]]
    }
    // 行首已经在公式环境里；如果这一行关闭了环境，后面的正文不能再按公式改。
    const endMatch = /\\end\{[^}]*\}/.exec(code)
    return [[0, endMatch ? endMatch.index : code.length]]
  }

  const ranges = []
  MATH_ENV_RE.lastIndex = 0
  let match
  while ((match = MATH_ENV_RE.exec(code)) !== null) {
    const full = match[0]
    const contentStart = match.index + full.indexOf('}') + 1
    const endStart = full.lastIndexOf('\\end{')
    if (endStart > contentStart - match.index) {
      ranges.push([contentStart, match.index + endStart])
    }
  }

  collectDollarRanges(code, ranges)
  collectParenMathRanges(code, ranges)
  collectUnclosedEnvRanges(code, ranges)
  collectUnclosedBracketRanges(code, ranges)
  return mergeRanges(ranges)
}

function convertMathPunctuation(code, inMath, mathKind) {
  const ranges = getMathRanges(code, inMath, mathKind)
  if (ranges.length === 0) return code

  let out = code
  // 全角转半角都是 1:1，长度不变，可以从后往前替换。
  for (let r = ranges.length - 1; r >= 0; r--) {
    const [start, end] = ranges[r]
    let middle = ''
    for (let i = start; i < end; i++) {
      middle += FULLWIDTH_MAP[out[i]] || out[i]
    }
    out = out.slice(0, start) + middle + out.slice(end)
  }
  return out
}

function restoreTokens(text, verbs, commands) {
  return text
    .replace(/\u0001(\d+)\u0001/g, (match, index) => verbs[Number(index)] || '')
    .replace(/\u0002(\d+)\u0002/g, (match, index) => commands[Number(index)] || '')
}

function fixLatexLine(line, options) {
  const opts = options || {}
  const verbMask = maskVerbs(line)
  const commentIndex = findCommentIndex(verbMask.masked)

  let code =
    commentIndex === -1
      ? verbMask.masked
      : verbMask.masked.slice(0, commentIndex)
  const comment =
    commentIndex === -1 ? '' : verbMask.masked.slice(commentIndex)

  // 4. 正文中文标点/中英文空格（在公式和命令参数保护之外）
  const proseBefore = code
  code = normalizeLatexProse(code, opts)
  const proseChanged = code !== proseBefore

  const commandMask = maskLatexCommands(code)
  code = commandMask.masked
  const syntaxBefore = code

  // 1. 行首漏写反斜杠：begin{equation} / end{equation}
  code = code.replace(
    /^([ \t]*)(begin|end)\s*\{\s*([A-Za-z@*]+)\s*\}/,
    '$1\\$2{$3}'
  )

  // 2. 环境名里有多余空格：\begin{ equation } → \begin{equation}
  code = code.replace(/\\(begin|end)\{([^}]*)\}/g, (match, command, name) => {
    const trimmed = name.trim()
    if (!/^[A-Za-z@*]+$/.test(trimmed)) return match
    return trimmed === name ? match : `\\${command}{${trimmed}}`
  })

  // 3. 同一行 \begin{A} ... \end{B} 明显不匹配
  code = fixMismatchedEnvironment(code)
  const syntaxChanged = code !== syntaxBefore

  // 4. 公式里的全角标点：$a，b$ → $a,b$
  const mathBefore = code
  code = convertMathPunctuation(code, Boolean(opts.inMath), opts.mathKind)
  const mathChanged = code !== mathBefore

  const restoredCode = restoreTokens(code, verbMask.saved, commandMask.saved)
  const restoredComment = restoreTokens(
    comment,
    verbMask.saved,
    commandMask.saved
  )
  const out = restoredCode + restoredComment

  if (out === line) return null

  const changes = []
  if (proseChanged) changes.push('中文标点/空格')
  if (syntaxChanged) changes.push('LaTeX 环境')
  if (mathChanged) changes.push('公式标点')
  if (changes.length === 0) changes.push('LaTeX 格式')

  return { oldText: line, newText: out, changes }
}

function detectLocalFix({ text, offset, languageId, cfg, manual }) {
  if (!cfg || cfg.autoFix === false) return null

  const lang = String(languageId || '').toLowerCase()
  const isMarkdown = MARKDOWN_LANGUAGES.has(lang)
  const isLatex = LATEX_LANGUAGES.has(lang)
  if (!isMarkdown && !isLatex) return null

  const { lineStart, lineEnd, lineText } = lineAtOffset(text, offset)
  if (!lineText.trim()) return null

  // 光标贴着字母时，很可能正在输入拼音或英文单词。自动预览和 AI 抑制
  // 需要跳过，避免把“yinci”这种未完成输入当成需要补空格的正文；
  // 用户主动调用快速修复（manual）时仍然允许。
  const suppressWhileTyping = () =>
    !manual && isTypingNextToLatin(lineText, Math.max(0, offset - lineStart))

  const gate = (result) => {
    if (!result) return result
    if (result.changes.length === 1 && result.changes[0] === '中文标点/空格') {
      // 只有空格差异时才认为可能是在输入；有标点修正说明是真正的格式问题。
      if (
        suppressWhileTyping() &&
        isCjkLatinSpacingOnly(result.oldText, result.newText)
      ) {
        return null
      }
    }
    return result
  }

  if (isMarkdown) {
    if (fenceState(text, lineStart)) return null
    if (inFrontmatter(text, lineStart)) return null
    if (inHtmlRawBlock(text, lineStart) || inHtmlRawBlock(text, lineEnd)) {
      return null
    }
    if (/<(?:script|style)\b|<!--/i.test(lineText)) return null

    const startState = mathOrCodeState(text, lineStart, lang)
    const endState = mathOrCodeState(text, lineEnd, lang)
    if (startState || endState) return null

    return gate(
      fixMarkdownLine(lineText, {
        fixCjkLatinSpacing: cfg.fixCjkLatinSpacing !== false
      })
    )
  }

  const startState = mathOrCodeState(text, lineStart, lang)
  const endState = mathOrCodeState(text, lineEnd, lang)
  if (
    startState === '光标在代码环境中' ||
    endState === '光标在代码环境中'
  ) {
    return null
  }

  const inMath =
    startState === '光标在公式中' || startState === '光标在公式环境中'

  return gate(
    fixLatexLine(lineText, {
      inMath,
      mathKind: startState,
      fixCjkLatinSpacing: cfg.fixCjkLatinSpacing !== false
    })
  )
}

module.exports = {
  lineAtOffset,
  fixMarkdownLine,
  fixLatexLine,
  fixPunctuation,
  fixCjkLatinSpacing,
  detectLocalFix,
  findCommentIndex,
  maskVerbs
}
