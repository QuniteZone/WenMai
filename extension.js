'use strict'

const vscode = require('vscode')

const log = require('./src/logger')
const { readConfig } = require('./src/config')
const { LruCache } = require('./src/cache')
const { createProvider } = require('./src/provider')
const { createLocalFixPreview } = require('./src/localFixPreview')
const { createAutoTrigger } = require('./src/autoTrigger')
const { buildContext, buildPrompt } = require('./src/context')
const { resolveGenre, buildGuidelineLine, GENRES } = require('./src/guidelines')
const { finalize, ensureCompleteEnding } = require('./src/postprocess')
const { callChat, completionUrl } = require('./src/client')

const SECRET_KEY = 'wenmai.apiKey'
const LEGACY_SECRET_KEY = 'deepseekFim.apiKey'
const ENV_KEYS = ['WENMAI_API_KEY', 'DEEPSEEK_API_KEY']
const KEY_CACHE_MS = 60000

let extensionContext = null
let statusItem = null

const stats = {
  requested: 0,
  shown: 0,
  rejected: 0,
  failed: 0,
  cancelled: 0,
  cacheHits: 0,
  skipped: 0,
  throttled: 0,
  fixed: 0
}

const runtime = {
  stats,
  cache: new LruCache(40),
  lastRequestAt: 0,
  generating: false,
  latency: null,
  keyCache: null,
  keyCacheAt: 0,
  noKeyWarned: false,
  lastErrorKind: '',
  lastErrorAt: 0,
  activeRequests: 0,
  getApiKey: null,
  onMissingKey: null,
  onRequestError: null,
  setGenerating: null,
  recordLatency: null,
  preview: null
}

let startupTimer = null
let deactivated = false

/* ------------------------------------------------------------------ */
/*  API Key                                                           */
/* ------------------------------------------------------------------ */

function readEnvKey() {
  for (const name of ENV_KEYS) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return null
}

async function readStoredKey() {
  if (!extensionContext) return readEnvKey()

  // secrets 读失败（例如加密存储暂时不可用）不应该让每次补全都抛异常，
  // 记录一次日志后继续用环境变量兜底。
  let current = null
  try {
    current = await extensionContext.secrets.get(SECRET_KEY)
  } catch (error) {
    log.warn(`读取已保存的 API Key 失败：${(error && error.message) || error}`)
  }
  if (current && current.trim()) return current.trim()

  // 兼容旧扩展的密钥，首次读取时自动迁移。
  let legacy = null
  try {
    legacy = await extensionContext.secrets.get(LEGACY_SECRET_KEY)
  } catch (_) {}
  if (legacy && legacy.trim()) {
    const key = legacy.trim()
    try {
      await extensionContext.secrets.store(SECRET_KEY, key)
      log.info('已从旧扩展迁移 API Key')
    } catch (_) {}
    return key
  }

  return readEnvKey()
}

async function getApiKey(interactive) {
  const now = Date.now()
  if (runtime.keyCache && now - runtime.keyCacheAt < KEY_CACHE_MS) return runtime.keyCache

  let key = await readStoredKey()

  if (!key && interactive) {
    const input = await vscode.window.showInputBox({
      title: '文脉：DeepSeek API Key',
      prompt: '粘贴 sk- 开头的密钥。密钥保存在 VS Code 加密存储中，不会写入任何文件。',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    })
    if (input && input.trim()) {
      key = input.trim()
      try {
        await extensionContext.secrets.store(SECRET_KEY, key)
        vscode.window.showInformationMessage('文脉：API Key 已保存。')
        log.info(`API Key 已保存（${maskKey(key)}）`)
      } catch (error) {
        // 存储失败时本次会话仍可使用内存里的 Key，但必须告诉用户下次还要重输。
        log.error(`保存 API Key 失败：${(error && error.message) || error}`)
        vscode.window.showWarningMessage(
          '文脉：API Key 保存到加密存储失败，本次会话仍可使用，但重启后需要重新设置。'
        )
      }
    }
  }

  if (key) {
    runtime.keyCache = key
    runtime.keyCacheAt = now
  }
  return key
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 10) return '***'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

function onMissingKey() {
  if (runtime.noKeyWarned) return
  runtime.noKeyWarned = true
  vscode.window
    .showWarningMessage('文脉：还没有设置 API Key，自动续写暂时不可用。', '设置 API Key')
    .then(
      (pick) => {
        if (pick === '设置 API Key') {
          Promise.resolve(vscode.commands.executeCommand('wenmai.setApiKey')).then(
            undefined,
            () => {}
          )
        }
      },
      () => {}
    )
}

const ERROR_NOTICE_INTERVAL_MS = 5 * 60 * 1000

/**
 * 只有“用户能采取行动”的 HTTP 错误才弹窗，并且同类错误 5 分钟内只提示一次。
 * 每次请求都弹会淹没写作，完全不提示又会让人以为扩展坏了。
 */
function reportRequestError(error) {
  const message = String((error && error.message) || '')
  let kind = ''
  if (/HTTP (?:401|403)\b/.test(message)) kind = 'auth'
  else if (/HTTP 402\b/.test(message)) kind = 'balance'
  else if (/HTTP 429\b/.test(message)) kind = 'rate'
  if (!kind) return

  const now = Date.now()
  if (runtime.lastErrorKind === kind && now - runtime.lastErrorAt < ERROR_NOTICE_INTERVAL_MS) {
    return
  }
  runtime.lastErrorKind = kind
  runtime.lastErrorAt = now

  if (kind === 'auth') {
    vscode.window
      .showWarningMessage(
        '文脉：API Key 无效或已过期，自动续写暂时不可用。',
        '设置 API Key'
      )
      .then(
        (pick) => {
          if (pick === '设置 API Key') {
            Promise.resolve(vscode.commands.executeCommand('wenmai.setApiKey')).then(
              undefined,
              () => {}
            )
          }
        },
        () => {}
      )
  } else if (kind === 'balance') {
    vscode.window
      .showWarningMessage('文脉：账户余额不足，自动续写暂时不可用。')
      .then(undefined, () => {})
  } else {
    vscode.window
      .showWarningMessage('文脉：请求过于频繁（HTTP 429），请稍后再试。')
      .then(undefined, () => {})
  }
}

/* ------------------------------------------------------------------ */
/*  状态栏                                                            */
/* ------------------------------------------------------------------ */

function renderTooltip(cfg) {
  const latency = runtime.latency
  const latencyLine = latency
    ? `上次：首字 ${latency.firstTokenMs || '?'}ms · 总 ${latency.totalMs}ms · ${latency.chars} 字${latency.earlyStop ? ' · 提前结束' : ''}`
    : '尚未生成建议'

  return new vscode.MarkdownString(
    [
      '**文脉 Wenmai** · 智能写作续写',
      `模型 \`${cfg.model}\` · 文体 ${cfg.genre} · 每次最多 ${cfg.maxSentences} 句`,
      latencyLine,
      `本次会话：建议 ${stats.shown} · 本地修正 ${stats.fixed} · 缓存 ${stats.cacheHits} · 丢弃 ${stats.rejected} · 失败 ${stats.failed}`,
      '本地修正：只在差异字符上标删除线并就地预览；Tab 或 Ctrl+Alt+. 应用',
      '点击打开设置菜单'
    ].join('\n\n')
  )
}

function refreshStatus() {
  if (!statusItem) return
  const cfg = readConfig()

  if (!cfg.showStatusBar) {
    statusItem.hide()
    return
  }

  statusItem.show()

  if (!cfg.enabled) {
    statusItem.text = '$(circle-slash) 文脉'
    statusItem.tooltip = renderTooltip(cfg)
    return
  }

  statusItem.text = runtime.generating ? '$(sync~spin) 文脉' : '$(sparkle) 文脉'
  statusItem.tooltip = renderTooltip(cfg)
}

/* ------------------------------------------------------------------ */
/*  命令                                                              */
/* ------------------------------------------------------------------ */

async function updateSetting(key, value) {
  const config = vscode.workspace.getConfiguration('wenmai')

  // 工作区/文件夹里已经写过这一项时，写全局值不会生效（低优先级被覆盖），
  // 用户会看到“已关闭”但行为没变。这里写到当前生效的那一层。
  let target = vscode.ConfigurationTarget.Global
  try {
    const info = config.inspect(key)
    if (info && info.workspaceFolderValue !== undefined) {
      target = vscode.ConfigurationTarget.WorkspaceFolder
    } else if (info && info.workspaceValue !== undefined) {
      target = vscode.ConfigurationTarget.Workspace
    }
  } catch (_) {}

  await config.update(key, value, target)
}

async function toggleEnabled() {
  const cfg = readConfig()
  const next = !cfg.enabled
  await updateSetting('enabled', next)
  refreshStatus()
  vscode.window.setStatusBarMessage(next ? '文脉：自动续写已开启' : '文脉：自动续写已关闭', 2500)
  log.info(`自动续写 ${next ? '开启' : '关闭'}`)
}

async function setGenre() {
  const cfg = readConfig()
  const items = GENRES.map((genre) => ({
    label: genre === cfg.genre ? `$(check) ${genre}` : `     ${genre}`,
    description:
      genre === '自动'
        ? '根据最近上下文自动判断'
        : genre === '通用'
          ? '中性、通用的书面表达'
          : genre === '公文'
            ? '通知、报告、请示、方案'
            : genre === '学术'
              ? '论文、研究报告、文献综述'
              : genre === '小说'
                ? '小说、散文、故事'
                : genre === '新媒体'
                  ? '公众号、短视频、社交媒体'
                  : '邮件、汇报、商业方案',
    value: genre
  }))

  const pick = await vscode.window.showQuickPick(items, {
    title: '文脉：选择文体',
    placeHolder: '不同文体使用不同的续写准则'
  })
  if (!pick) return

  await updateSetting('genre', pick.value)
  runtime.cache.clear()
  refreshStatus()
  vscode.window.setStatusBarMessage(`文脉：文体已切换为「${pick.value}」`, 2500)
  log.info(`文体切换为 ${pick.value}`)
}

async function setRules() {
  const cfg = readConfig()
  const input = await vscode.window.showInputBox({
    title: '文脉：自定义写作准则',
    prompt: '会追加在内置准则之后，例如：不要使用第一人称；每段不超过三句；避免感叹号。留空表示不追加。',
    value: cfg.writingRules,
    placeHolder: '留空表示使用内置准则',
    ignoreFocusOut: true,
    validateInput: (value) => (value.length > 300 ? '最多 300 字' : null)
  })
  if (input === undefined) return

  await updateSetting('writingRules', input.trim())
  runtime.cache.clear()
  vscode.window.setStatusBarMessage(
    input.trim() ? '文脉：自定义写作准则已保存' : '文脉：已清空自定义写作准则',
    2500
  )
  log.info(`自定义准则：${input.trim() || '（空）'}`)
}

async function setApiKey() {
  if (!extensionContext) return

  // 先弹输入框，用户取消或留空时保留已有 Key。
  // 旧实现先删除再询问，按 Esc 就会把能用的 Key 清掉。
  const input = await vscode.window.showInputBox({
    title: '文脉：DeepSeek API Key',
    prompt: '粘贴 sk- 开头的密钥。留空并确定会保留现有密钥。密钥保存在 VS Code 加密存储中，不会写入任何文件。',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-...'
  })
  if (input === undefined) return

  const key = input.trim()
  if (!key) {
    vscode.window.showInformationMessage('文脉：未输入新密钥，原有 API Key 保持不变。')
    return
  }

  try {
    await extensionContext.secrets.store(SECRET_KEY, key)
    try {
      await extensionContext.secrets.delete(LEGACY_SECRET_KEY)
    } catch (_) {}
  } catch (error) {
    log.error(`保存 API Key 失败：${(error && error.message) || error}`)
    vscode.window.showErrorMessage('文脉：保存 API Key 失败，请稍后重试。')
    return
  }

  runtime.keyCache = key
  runtime.keyCacheAt = Date.now()
  runtime.noKeyWarned = false
  runtime.lastErrorKind = ''
  runtime.lastErrorAt = 0
  vscode.window.showInformationMessage('文脉：API Key 已更新。')
  log.info(`API Key 更新完成（${maskKey(key)}）`)
}

function showLog() {
  log.show()
}

function showStats() {
  const lines = [
    `请求 ${stats.requested} · 建议 ${stats.shown} · 本地修正 ${stats.fixed} · 缓存 ${stats.cacheHits}`,
    `丢弃 ${stats.rejected} · 失败 ${stats.failed} · 取消 ${stats.cancelled} · 跳过 ${stats.skipped} · 限流 ${stats.throttled}`
  ]
  vscode.window.showInformationMessage(`文脉统计：${lines.join('；')}`)
  log.show()
  log.info(`统计：${lines.join(' | ')}`)
}

function clearCache() {
  runtime.cache.clear()
  vscode.window.setStatusBarMessage('文脉：补全缓存已清空', 2500)
}

async function trigger() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage('文脉：没有打开的编辑器')
    return
  }
  try {
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
  } catch (_) {
    vscode.window.showWarningMessage('文脉：当前环境不支持手动触发，直接输入即可，停顿时会自动推荐。')
  }
}

function buildLongMessages(info, cfg, genre) {
  const guideline = cfg.useGuidelines
    ? buildGuidelineLine({
        genre,
        maxSentences: 8,
        maxChars: 900,
        custom: cfg.writingRules
      })
    : ''
  const system = guideline
    ? `${guideline}\n你是续写引擎。只输出接续正文，不解释、不加标题、不使用代码块，也不要重复上文。`
    : '你是续写引擎。只输出接续正文，不解释、不加标题、不使用代码块，也不要重复上文。'
  const user =
    `【上文】\n${info.pre}\n\n` +
    `【续写位置】\n` +
    (cfg.useSuffix && info.suffix ? `【后文】\n${info.suffix}\n\n` : '') +
    '请紧接“续写位置”继续写 2~4 句，只输出正文。'
  return { system, user }
}

async function continueLong() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage('文脉：没有打开的编辑器')
    return
  }

  const cfg = readConfig()
  const apiKey = await getApiKey(true)
  if (!apiKey) return

  // 记住发起时的文档、版本和光标：长续写要几秒，期间用户可能继续编辑。
  const document = editor.document
  const position = editor.selection.active
  const version = document.version

  const text = document.getText()
  const offset = document.offsetAt(position)
  const info = buildContext({
    text,
    offset,
    languageId: document.languageId,
    cfg,
    long: true
  })

  if (info.skip) {
    vscode.window.showWarningMessage(`文脉：${info.skip}`)
    return
  }

  const genre = resolveGenre(cfg.genre, info.pre)
  const { system, user } = buildLongMessages(info, cfg, genre)

  const controller = { cancelled: false }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '文脉：正在续写…',
      cancellable: true
    },
    async (progress, token) => {
      token.onCancellationRequested(() => {
        controller.cancelled = true
        if (controller.onAbort) controller.onAbort()
      })

      const started = Date.now()
      try {
        const result = await callChat({
          chatUrl: cfg.chatUrl,
          model: cfg.chatModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          // deepseek-flash 会先产生隐藏的推理 token，预算留足才能写完整段。
          maxTokens: Math.max(cfg.maxTokens * 8, 800),
          temperature: Math.max(cfg.temperature, 0.4),
          timeoutMs: Math.max(cfg.timeoutMs, 30000),
          signal: controller,
          apiKey
        })

        if (result.finishReason === 'length') {
          log.warn('长续写达到 token 上限，已回退到最后一个完整句')
        }

        const out = ensureCompleteEnding(
          finalize(
            result.text,
            { pre: info.pre, suffix: info.suffix, prevChar: info.prevChar },
            { maxSentences: 8, maxChars: 900 }
          )
        )

        if (controller.cancelled || token.isCancellationRequested) return

        if (!out) {
          vscode.window.showWarningMessage('文脉：没有生成有效内容，请再试一次。')
          return
        }

        // 文档被改动或焦点已切走时，原光标位置已不可信，宁可不插入。
        if (vscode.window.activeTextEditor !== editor || document.version !== version) {
          vscode.window.showWarningMessage('文脉：编辑位置已变化，已取消插入，请重新触发。')
          log.warn('长续写期间文档或焦点变化，取消插入')
          return
        }

        const inserted = await editor.edit((builder) => builder.insert(position, out))
        if (inserted) {
          vscode.window.setStatusBarMessage(
            `文脉：已插入 ${out.length} 字（Ctrl+Z 撤销） · ${Date.now() - started}ms`,
            5000
          )
          log.info(`长续写插入 ${out.length} 字，用时 ${Date.now() - started}ms`)
        }
      } catch (error) {
        if (!error.cancelled) {
          log.error(`长续写失败：${error.message}`)
          vscode.window.showErrorMessage(`文脉长续写失败：${error.message}`)
        }
      }
    }
  )
}

async function showPrompt() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage('文脉：没有打开的编辑器')
    return
  }

  const cfg = readConfig()
  const document = editor.document
  const position = editor.selection.active
  const text = document.getText()
  const offset = document.offsetAt(position)
  const info = buildContext({
    text,
    offset,
    languageId: document.languageId,
    cfg
  })

  if (info.skip) {
    vscode.window.showWarningMessage(`文脉：当前光标位置不会触发续写（${info.skip}）。`)
    return
  }

  const genre = resolveGenre(cfg.genre, info.pre)
  const guideline = cfg.useGuidelines
    ? buildGuidelineLine({
        genre,
        maxSentences: cfg.maxSentences,
        maxChars: cfg.maxChars,
        custom: cfg.writingRules
      })
    : ''
  const prompt = buildPrompt(guideline, info.metaLine, info.pre)
  const suffix = cfg.useSuffix ? info.suffix : ''
  const endpoint = completionUrl(cfg.baseUrl)

  const longInfo = buildContext({
    text,
    offset,
    languageId: document.languageId,
    cfg,
    long: true
  })
  const long = buildLongMessages(longInfo, cfg, genre)

  const requestLines = [
    `POST ${endpoint}`,
    `model: ${cfg.model}`,
    `max_tokens: ${cfg.maxTokens}`,
    `temperature: ${cfg.temperature}`,
    `stream: ${cfg.stream ? 'true' : 'false'}`,
    'suffix: 不发送（行内续写只依据光标前的文本）',
    `Chat 后文参考（兜底/长续写）: ${suffix ? `开（最近 ${suffix.length} 字）` : '关'}`
  ]

  const content = [
    '文脉 · 当前提示词预览',
    `生成时间：${new Date().toLocaleString()}`,
    `语言：${document.languageId} · 光标：第 ${position.line + 1} 行，第 ${position.character + 1} 列`,
    `文体：${cfg.genre} → ${genre} · 模型：${cfg.model} · 准则：${cfg.useGuidelines ? '开' : '关'}`,
    '',
    '========== 1. 自动续写（FIM）实际 prompt ==========',
    '',
    prompt,
    '',
    '========== 2. 请求参数 ==========',
    '',
    requestLines.join('\n'),
    '',
    '========== 3. 长续写（Chat）messages ==========',
    '',
    'system:',
    long.system,
    '',
    'user:',
    long.user,
    '',
    '========== 说明 ==========',
    '',
    'prompt =（写作设定）+（文档位置）+ 光标前的文本。',
    '行内续写（FIM）只发送光标前的文本；光标后的文本只在 Chat（兜底或长续写）里参考，',
    '并且要显式开启 wenmai.useSuffix 才会带上。',
    '整篇文档、文件路径、文件名不会发送；API Key 只放在 Authorization 头里，不进入 prompt。'
  ].join('\n')

  const preview = await vscode.workspace.openTextDocument({ content, language: 'plaintext' })
  await vscode.window.showTextDocument(preview, { preview: true })
  log.info(`已生成提示词预览（${prompt.length} 字）`)
}

async function showMenu() {
  const cfg = readConfig()
  const items = [
    {
      label: cfg.enabled ? '$(circle-slash) 关闭自动续写' : '$(play) 开启自动续写',
      description: cfg.enabled ? '当前：开启' : '当前：关闭',
      command: 'wenmai.toggle'
    },
    {
      label: `$(book) 文体：${cfg.genre}`,
      description: '切换通用 / 公文 / 学术 / 小说 / 新媒体 / 商务',
      command: 'wenmai.setGenre'
    },
    {
      label: '$(edit) 设置写作准则',
      description: cfg.writingRules ? cfg.writingRules.slice(0, 60) : '未设置自定义准则',
      command: 'wenmai.setRules'
    },
    {
      label: '$(eye) 查看当前提示词',
      description: '预览实际发送给模型的 prompt 与长续写消息',
      command: 'wenmai.showPrompt'
    },
    {
      label: '$(check) 应用本地格式修正',
      description: '应用光标所在行的差异修正（Tab）',
      command: 'wenmai.acceptLocalFix'
    },
    {
      label: '$(key) 设置 API Key',
      description: '保存在 VS Code 加密存储中',
      command: 'wenmai.setApiKey'
    },
    {
      label: '$(zap) 长续写（插入 2~4 句）',
      description: '用 Chat 模型生成更完整的一段',
      command: 'wenmai.continueLong'
    },
    { label: '$(output) 打开日志', command: 'wenmai.showLog' },
    { label: '$(graph) 查看统计', command: 'wenmai.stats' },
    { label: '$(trash) 清空补全缓存', command: 'wenmai.clearCache' }
  ]

  const pick = await vscode.window.showQuickPick(items, {
    title: '文脉 · 智能写作续写',
    placeHolder: '选择操作'
  })
  if (pick) await vscode.commands.executeCommand(pick.command)
}

/* ------------------------------------------------------------------ */
/*  激活                                                              */
/* ------------------------------------------------------------------ */

function activate(context) {
  extensionContext = context
  deactivated = false
  runtime.activeRequests = 0
  runtime.generating = false

  log.init(context)
  const cfg = readConfig()
  log.setLevel(cfg.logLevel)
  runtime.cache.setLimit(cfg.cacheSize)

  runtime.getApiKey = () => getApiKey(false)
  runtime.onMissingKey = onMissingKey
  runtime.onRequestError = reportRequestError
  runtime.notify = refreshStatus
  // 并发请求时用计数而不是布尔值，否则先结束的请求会把后一个的转圈图标关掉。
  runtime.setGenerating = (value) => {
    runtime.activeRequests = Math.max(0, runtime.activeRequests + (value ? 1 : -1))
    runtime.generating = runtime.activeRequests > 0
    refreshStatus()
  }
  runtime.recordLatency = (latency) => {
    runtime.latency = latency
    refreshStatus()
  }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusItem.command = 'wenmai.menu'
  statusItem.name = '文脉'
  context.subscriptions.push(statusItem)
  refreshStatus()

  const provider = createProvider(runtime)
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: '*' }, provider)
  )

  const fixPreview = createLocalFixPreview(runtime)
  runtime.preview = fixPreview
  context.subscriptions.push(fixPreview)

  // 仅移动光标（不输入）时也主动请求一次续写。
  context.subscriptions.push(createAutoTrigger(runtime))

  context.subscriptions.push(
    vscode.commands.registerCommand('wenmai.menu', showMenu),
    vscode.commands.registerCommand('wenmai.toggle', toggleEnabled),
    vscode.commands.registerCommand('wenmai.trigger', trigger),
    vscode.commands.registerCommand('wenmai.continueLong', continueLong),
    vscode.commands.registerCommand('wenmai.setApiKey', setApiKey),
    vscode.commands.registerCommand('wenmai.setGenre', setGenre),
    vscode.commands.registerCommand('wenmai.setRules', setRules),
    vscode.commands.registerCommand('wenmai.showPrompt', showPrompt),
    vscode.commands.registerCommand('wenmai.acceptLocalFix', () => fixPreview.accept()),
    vscode.commands.registerCommand('wenmai.dismissLocalFix', () => fixPreview.dismiss()),
    vscode.commands.registerCommand('wenmai.showLog', showLog),
    vscode.commands.registerCommand('wenmai.stats', showStats),
    vscode.commands.registerCommand('wenmai.clearCache', clearCache)
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('wenmai') && !event.affectsConfiguration('deepseekFim')) {
        return
      }
      const next = readConfig()
      log.setLevel(next.logLevel)
      runtime.cache.setLimit(next.cacheSize)

      if (
        event.affectsConfiguration('wenmai.model') ||
        event.affectsConfiguration('wenmai.chatModel') ||
        event.affectsConfiguration('wenmai.baseUrl') ||
        event.affectsConfiguration('wenmai.chatUrl') ||
        event.affectsConfiguration('wenmai.genre') ||
        event.affectsConfiguration('wenmai.writingRules') ||
        event.affectsConfiguration('wenmai.useGuidelines')
      ) {
        runtime.cache.clear()
      }

      if (event.affectsConfiguration('wenmai.enabled')) {
        log.info(`自动续写 ${next.enabled ? '开启' : '关闭'}`)
      }
      refreshStatus()
    })
  )

  log.info('======== 文脉 Wenmai v1.0.0 启动 ========')
  log.info(`VS Code ${vscode.version} · 模型 ${cfg.model} · 文体 ${cfg.genre}`)
  log.info(
    `自动续写 ${cfg.enabled ? '开' : '关'} · 防抖 ${cfg.debounceMs}ms · 最多 ${cfg.maxSentences} 句 · ` +
      `上下文 ${cfg.prefixChars} 字 · 流式 ${cfg.stream ? '开' : '关'} · ` +
      `suffix ${cfg.useSuffix ? '开' : '关'} · maxTokens ${cfg.maxTokens}`
  )

  const oldExtension = vscode.extensions.getExtension('qgz.deepseek-fim-helper')
  if (oldExtension && oldExtension.isActive) {
    log.warn('检测到旧扩展 qgz.deepseek-fim-helper 仍在运行，可能与文脉重复请求，建议卸载旧扩展。')
  }

  startupTimer = setTimeout(async () => {
    startupTimer = null
    if (deactivated) return
    const inlineEnabled = vscode.workspace
      .getConfiguration('editor')
      .get('inlineSuggest.enabled', true)
    if (!inlineEnabled) {
      log.warn('VS Code 的 editor.inlineSuggest.enabled 为 false，幽灵文本不会显示。')
      if (!context.globalState.get('wenmai.inlineWarned')) {
        await context.globalState.update('wenmai.inlineWarned', true)
        const pick = await vscode.window.showWarningMessage(
          '文脉需要开启 VS Code 的行内建议（inline suggestion）才能显示幽灵文本。',
          '去开启'
        )
        if (pick === '去开启') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'editor.inlineSuggest.enabled'
          )
        }
      }
    }

    const key = await getApiKey(false)
    if (key) {
      log.info(`API Key 已就绪（${maskKey(key)}）`)
      return
    }
    if (context.globalState.get('wenmai.keyPrompted')) return
    await context.globalState.update('wenmai.keyPrompted', true)
    const pick = await vscode.window.showInformationMessage(
      '文脉已启用：设置 DeepSeek API Key 后即可在写作时自动出现幽灵文本。',
      '设置 API Key',
      '稍后'
    )
    if (pick === '设置 API Key') vscode.commands.executeCommand('wenmai.setApiKey')
  }, 1200)
}

function deactivate() {
  deactivated = true
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  log.info('文脉：扩展已卸载')
}

module.exports = {
  activate,
  deactivate,
  _runtime: runtime
}
