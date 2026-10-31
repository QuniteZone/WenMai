'use strict'

/*
 * 真实 API 联调（会消耗额度，不要放进 npm test）。
 *
 *   $env:WENMAI_API_KEY = 'sk-...'
 *   node test-live.js
 *
 * 覆盖：
 *   1. 模型列表
 *   2. FIM 流式 + 提前结束
 *   3. 完整 provider 链路（mock vscode，真实网络）
 *   4. 长续写 Chat 链路
 */

const https = require('https')
const Module = require('module')

const API_KEY = (process.env.WENMAI_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim()
if (!API_KEY) {
  console.error('缺少 WENMAI_API_KEY / DEEPSEEK_API_KEY')
  process.exit(1)
}

const { callCompletion, callChat } = require('./src/client')
const { finalize, isLowQuality, ensureCompleteEnding } = require('./src/postprocess')
const { buildGuidelineLine } = require('./src/guidelines')

function line(title) {
  console.log(`\n===== ${title} =====`)
}

function getJson(urlString, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, { headers }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        resolve({ status: res.statusCode, body: raw })
      })
    })
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function listModels() {
  line('模型列表')
  const res = await getJson('https://api.deepseek.com/models', {
    Authorization: `Bearer ${API_KEY}`
  })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const ids = (JSON.parse(res.body).data || []).map((m) => m.id)
  console.log(ids.join(', '))
  return ids
}

async function probeFim(model, prompt) {
  const started = Date.now()
  const guideline = buildGuidelineLine({
    genre: '通用',
    maxSentences: 2,
    maxChars: 220,
    custom: ''
  })
  const result = await callCompletion({
    baseUrl: 'https://api.deepseek.com/beta',
    model,
    prompt: `${guideline}\n${prompt}`,
    maxTokens: 96,
    temperature: 0.3,
    timeoutMs: 30000,
    stream: true,
    shouldStop: (text) => /[。！？；\n]\s*[”’」』）)]*\s*$/.test(text) && text.length > 12,
    apiKey: API_KEY
  })
  const out = finalize(
    result.text,
    { pre: prompt, suffix: '', prevChar: prompt.slice(-1) },
    { maxSentences: 2, maxChars: 220 }
  )
  return {
    model,
    raw: result.text,
    out,
    lowQuality: isLowQuality(out, { pre: prompt, suffix: '' }),
    firstTokenMs: result.firstTokenMs,
    totalMs: result.totalMs || Date.now() - started,
    earlyStop: Boolean(result.earlyStop)
  }
}

/* ------------------------------------------------------------------ */
/*  provider 全链路（mock vscode + 真实网络）                           */
/* ------------------------------------------------------------------ */

let provider = null
const commands = {}
const config = {
  'wenmai.enabled': true,
  'wenmai.genre': '自动',
  'wenmai.writingRules': '',
  'wenmai.useGuidelines': true,
  'wenmai.debounceMs': 0,
  'wenmai.minIntervalMs': 0,
  'wenmai.timeoutMs': 20000,
  'wenmai.logLevel': 'warn',
  'editor.inlineSuggest.enabled': true
}

const mock = {
  version: '1.144.0',
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  MarkdownString: class MarkdownString {
    constructor(value) {
      this.value = value
    }
  },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id
    }
  },
  Range: class Range {
    constructor(start, end) {
      this.start = start
      this.end = end
    }
  },
  Selection: class Selection {
    constructor(anchor, active) {
      this.anchor = anchor
      this.active = active
      this.start = anchor
      this.end = active
      this.isEmpty =
        anchor.line === active.line && anchor.character === active.character
    }
  },
  CodeAction: class CodeAction {
    constructor(title, kind) {
      this.title = title
      this.kind = kind
      this.edit = null
      this.isPreferred = false
    }
  },
  CodeActionKind: {
    QuickFix: 'quickfix'
  },
  WorkspaceEdit: class WorkspaceEdit {
    constructor() {
      this.edits = []
    }
    replace(uri, range, text) {
      this.edits.push({ uri, range, text })
    }
  },
  InlineCompletionItem: class InlineCompletionItem {
    constructor(insertText, range) {
      this.insertText = insertText
      this.range = range
    }
  },
  window: {
    createOutputChannel: () => ({
      info() {},
      warn() {},
      error() {},
      debug() {},
      show() {},
      dispose() {}
    }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    setStatusBarMessage: () => {},
    createTextEditorDecorationType: (options) => ({
      options,
      dispose() {}
    }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    withProgress: async (options, task) =>
      task(
        { report() {} },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
      )
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = `${section}.${key}`
        return Object.prototype.hasOwnProperty.call(config, full) ? config[full] : fallback
      },
      update: async () => {}
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({
      uri: { scheme: 'untitled' },
      getText: () => ''
    }),
    applyEdit: async () => true
  },
  commands: {
    registerCommand: (id, handler) => {
      commands[id] = handler
      return { dispose() {} }
    },
    executeCommand: async () => undefined
  },
  languages: {
    registerInlineCompletionItemProvider: (selector, instance) => {
      provider = instance
      return { dispose() {} }
    },
    registerCodeActionsProvider: () => ({ dispose() {} })
  },
  extensions: { getExtension: () => undefined }
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return mock
  return originalLoad.call(this, request, parent, isMain)
}

function makeToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
  }
}

let activated = false

async function providerProbe(text, offset) {
  const extension = require('./extension.js')
  const context = {
    subscriptions: [],
    secrets: {
      get: async (key) => (key === 'wenmai.apiKey' ? API_KEY : undefined),
      store: async () => {},
      delete: async () => {}
    },
    globalState: { get: () => true, update: async () => {} }
  }
  if (!activated) {
    extension.activate(context)
    activated = true
  }
  if (!provider) throw new Error('provider 未注册')

  const at = typeof offset === 'number' ? offset : text.length
  const started = Date.now()
  const document = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => text,
    offsetAt: (position) => position.offset
  }
  const items = await provider.provideInlineCompletionItems(
    document,
    { line: 0, character: at, offset: at },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )
  return { items, elapsed: Date.now() - started }
}

/* ------------------------------------------------------------------ */

async function main() {
  // --provider-only：只跑 provider 全链路（约 2 次请求），日常改完代码联调用。
  const providerOnly = process.argv.includes('--provider-only')
  const models = providerOnly ? [] : await listModels()

  if (!providerOnly) {
  line('FIM 流式探测')
  const prompts = [
    '群众不看你说什么，只看',
    '深夜的巷子里只剩下雨声，',
    '数字化转型不是把纸质表格搬进电脑，而是'
  ]
  for (const model of models) {
    for (const prompt of prompts) {
      try {
        const r = await probeFim(model, prompt)
        console.log(
          `[${model}] 首字 ${r.firstTokenMs}ms · 总 ${r.totalMs}ms · 提前结束 ${r.earlyStop} · ` +
            `质量 ${r.lowQuality ? '差' : 'OK'}`
        )
        console.log(`  上文: ${prompt}`)
        console.log(`  原始: ${JSON.stringify(r.raw)}`)
        console.log(`  成品: ${JSON.stringify(r.out)}`)
      } catch (error) {
        console.log(`[${model}] 失败: ${error.message}`)
        if (/HTTP 4\d\d/.test(error.message)) break
      }
    }
  }

  }

  line('provider 全链路（光标在文末）')
  try {
    const r = await providerProbe('群众不看你说什么，只看')
    console.log(`耗时 ${r.elapsed}ms`)
    console.log(
      `insertText: ${JSON.stringify(
        Array.isArray(r.items) ? r.items.map((item) => item.insertText) : r.items
      )}`
    )
  } catch (error) {
    console.log(`失败: ${error.message}`)
  }

  line('provider 全链路（光标在段中，后面已有完整句子）')
  try {
    const pre = '他把所有的账本摊在桌上，说'
    const text = pre + '这就是全部。'
    const r = await providerProbe(text, pre.length)
    console.log(`耗时 ${r.elapsed}ms`)
    console.log(
      `insertText: ${JSON.stringify(
        Array.isArray(r.items) ? r.items.map((item) => item.insertText) : r.items
      )}`
    )
  } catch (error) {
    console.log(`失败: ${error.message}`)
  }

  if (providerOnly) return

  line('取消（模拟用户继续输入）')
  try {
    const signal = { cancelled: false }
    const started = Date.now()
    const pending = callCompletion({
      baseUrl: 'https://api.deepseek.com/beta',
      model: 'deepseek-flash',
      prompt: '夜深了，他推开那扇门，',
      maxTokens: 96,
      temperature: 0.3,
      timeoutMs: 30000,
      stream: true,
      shouldStop: () => false,
      signal,
      apiKey: API_KEY
    })
    setTimeout(() => {
      signal.cancelled = true
      if (signal.onAbort) signal.onAbort()
    }, 250)
    await pending
    console.log('未按预期取消（请求完成得比 250ms 快）')
  } catch (error) {
    console.log(`取消结果: ${error.cancelled ? '已中断' : error.message}`)
  }

  line('长续写命令全链路')
  try {
    const inserted = []
    const editorText = '数字化转型不是把纸质表格搬进电脑，而是重新设计流程、数据与责任边界。'
    const document = {
      languageId: 'plaintext',
      uri: { scheme: 'file' },
      version: 1,
      getText: () => editorText,
      offsetAt: (pos) => pos.offset
    }
    mock.window.activeTextEditor = {
      document,
      selection: {
        active: { line: 0, character: editorText.length, offset: editorText.length }
      },
      edit: async (callback) => {
        callback({ insert: (pos, value) => inserted.push({ pos, value }) })
        return true
      }
    }

    await commands['wenmai.continueLong']()
    console.log(
      inserted.length
        ? `插入 ${inserted[0].value.length} 字: ${JSON.stringify(inserted[0].value)}`
        : '未插入（失败或被取消）'
    )
  } catch (error) {
    console.log(`失败: ${error.message}`)
  }

  line('长续写 Chat')
  try {
    const pre = '数字化转型不是把纸质表格搬进电脑，而是重新设计流程、数据与责任边界。'
    const result = await callChat({
      chatUrl: 'https://api.deepseek.com/chat/completions',
      model: models.includes('deepseek-flash') ? 'deepseek-flash' : models[0],
      messages: [
        {
          role: 'system',
          content:
            buildGuidelineLine({ genre: '通用', maxSentences: 8, maxChars: 900, custom: '' }) +
            '\n只输出续写正文。'
        },
        { role: 'user', content: `【上文】\n${pre}\n\n请紧接下文继续写 2~4 句。` }
      ],
      maxTokens: 800,
      temperature: 0.4,
      timeoutMs: 40000,
      apiKey: API_KEY
    })
    const out = ensureCompleteEnding(
      finalize(
        result.text,
        { pre, suffix: '', prevChar: pre.slice(-1) },
        { maxSentences: 8, maxChars: 900 }
      )
    )
    console.log(`总 ${result.totalMs}ms · finish=${result.finishReason || '?'} · 原始 ${result.text.length} 字`)
    console.log(`原始: ${JSON.stringify(result.text)}`)
    console.log(`成品: ${JSON.stringify(out)}`)
  } catch (error) {
    console.log(`失败: ${error.message}`)
  }
}

main().catch((error) => {
  console.error('联调异常：', error.message)
  process.exitCode = 1
})
