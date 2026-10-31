'use strict'

const vscode = require('vscode')
const { URL: NodeURL } = require('url')

const SECTION = 'wenmai'
const LEGACY_SECTION = 'deepseekFim'

const DEFAULT_BASE_URL = 'https://api.deepseek.com/beta'
const DEFAULT_CHAT_URL = 'https://api.deepseek.com/chat/completions'

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'off'])

const LEGACY_KEYS = new Set([
  'baseUrl',
  'model',
  'maxTokens',
  'temperature',
  'prefixChars',
  'suffixChars',
  'useSuffix'
])

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * settings.json 里手写的值偶尔是字符串（"false"、"1"），
 * 直接 Boolean("false") 会得到 true，导致开关失效。
 */
function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return fallback
}

/**
 * 端点配置必须是合法的 http(s) URL。
 * 留空、写错协议或拼写错误时回退到官方地址，避免每个请求都以
 * “无效的 URL” 失败，而用户只看到幽灵文本不出现。
 */
function normalizeUrl(value, fallback) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return fallback
  try {
    const parsed = new NodeURL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback
    return raw
  } catch (_) {
    return fallback
  }
}

/**
 * 只取用户显式设置的值（全局/工作区/工作区文件夹），忽略扩展清单里的默认值。
 *
 * useSuffix 必须这样读：VS Code 的扩展清单在窗口重启后仍可能沿用扫描时的
 * 旧默认值（开发期间改了 package.json 的 default 也能复现）。这一项一旦被
 * 读成 true，Chat 兜底和长续写就会带上光标后的文字，模型容易直接复述后文。
 * 最终以用户是否真的在设置里写了这一项为准，没写就一律按关闭处理。
 */
function readExplicit(config, key) {
  if (!config || typeof config.inspect !== 'function') return undefined
  let info
  try {
    info = config.inspect(key)
  } catch (_) {
    return undefined
  }
  if (!info) return undefined
  if (info.workspaceFolderValue !== undefined) return info.workspaceFolderValue
  if (info.workspaceValue !== undefined) return info.workspaceValue
  if (info.globalValue !== undefined) return info.globalValue
  return undefined
}

function readConfig() {
  const current = vscode.workspace.getConfiguration(SECTION)
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION)

  const get = (key, fallback) => {
    if (key === 'useSuffix') {
      const explicit = readExplicit(current, key)
      if (explicit !== undefined) return explicit
      const legacyExplicit = readExplicit(legacy, key)
      if (legacyExplicit !== undefined) return legacyExplicit
      return fallback
    }

    const value = current.get(key)
    if (value !== undefined) return value
    if (LEGACY_KEYS.has(key)) {
      const old = legacy.get(key)
      if (old !== undefined) return old
    }
    return fallback
  }

  const languages = get('languages', [])
  const normalizedLanguages = Array.isArray(languages)
    ? languages.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : typeof languages === 'string' && languages.trim()
      ? [languages.trim().toLowerCase()]
      : []

  const genre = String(get('genre', '自动'))
  const allowedGenres = ['自动', '通用', '公文', '学术', '小说', '新媒体', '商务']
  const model = String(get('model', 'deepseek-flash')).trim() || 'deepseek-flash'
  const logLevel = String(get('logLevel', 'info')).trim().toLowerCase()

  return {
    enabled: toBool(get('enabled', true), true),
    triggerOnCursorMove: toBool(get('triggerOnCursorMove', true), true),
    genre: allowedGenres.includes(genre) ? genre : '自动',
    writingRules: String(get('writingRules', '')).trim().slice(0, 300),
    useGuidelines: toBool(get('useGuidelines', true), true),

    model,
    chatModel: String(get('chatModel', '')).trim() || model,
    baseUrl: normalizeUrl(get('baseUrl', DEFAULT_BASE_URL), DEFAULT_BASE_URL),
    chatUrl: normalizeUrl(get('chatUrl', DEFAULT_CHAT_URL), DEFAULT_CHAT_URL),

    maxSentences: Math.round(clampNumber(get('maxSentences', 2), 2, 1, 6)),
    maxChars: Math.round(clampNumber(get('maxChars', 220), 220, 40, 2000)),
    // deepseek-flash 等模型会先产生隐藏推理 token；预算太小会把正文挤掉，
    // 表现为“流式响应为空/不触发”。384 足够普通续写，空响应时还会自动放大重试。
    maxTokens: Math.round(clampNumber(get('maxTokens', 384), 384, 16, 1024)),
    temperature: clampNumber(get('temperature', 0.3), 0.3, 0, 1.5),

    prefixChars: Math.round(clampNumber(get('prefixChars', 1500), 1500, 200, 20000)),
    longPrefixChars: Math.round(clampNumber(get('longPrefixChars', 6000), 6000, 500, 30000)),
    // FIM 的 suffix 是“填空”语义：光标后的文字已能自然衔接时，模型会返回
    // 0 token 的空结果（实测 DeepSeek /beta/completions 稳定复现）。
    // 行内续写是往光标前插入，默认只发送上文；需要与后文衔接再手动开启。
    useSuffix: toBool(get('useSuffix', false), false),
    suffixChars: Math.round(clampNumber(get('suffixChars', 500), 500, 0, 4000)),

    debounceMs: Math.round(clampNumber(get('debounceMs', 220), 220, 0, 2000)),
    minIntervalMs: Math.round(clampNumber(get('minIntervalMs', 120), 120, 0, 5000)),
    minPromptChars: Math.round(clampNumber(get('minPromptChars', 6), 6, 1, 200)),
    timeoutMs: Math.round(clampNumber(get('timeoutMs', 12000), 12000, 2000, 60000)),

    stream: toBool(get('stream', true), true),
    proseOnly: toBool(get('proseOnly', true), true),
    autoFix: toBool(get('autoFix', true), true),
    fixCjkLatinSpacing: toBool(get('fixCjkLatinSpacing', true), true),
    languages: normalizedLanguages,
    cacheSize: Math.round(clampNumber(get('cacheSize', 40), 40, 0, 500)),
    showStatusBar: toBool(get('showStatusBar', true), true),
    logLevel: LOG_LEVELS.has(logLevel) ? logLevel : 'info'
  }
}

function isLanguageAllowed(languageId, languages) {
  if (!languages || languages.length === 0) return true
  if (languages.includes('*')) return true
  return languages.includes(String(languageId || '').toLowerCase())
}

module.exports = { readConfig, isLanguageAllowed }
