'use strict'

/*
 * 端到端冒烟测试：mock 掉 vscode API，用本地 SSE 服务器跑通
 * provider → 上下文 → 请求 → 流式解析 → 后处理 → InlineCompletionItem 全链路。
 *
 *   node test-provider.js
 */

const http = require('http')
const Module = require('module')

let provider = null
let codeActionProvider = null
let port = 0
const commands = {}
let previewContent = ''
let lastCompletionBody = null
const completionBodies = []
let completionRequests = 0
const selectionHandlers = []
const executedCommands = []
let chatRequests = 0
let lastChatBody = null
const decorationTypes = []

const config = {
  'wenmai.enabled': true,
  'wenmai.genre': '自动',
  'wenmai.writingRules': '',
  'wenmai.useGuidelines': true,
  'wenmai.model': 'test-model',
  'wenmai.chatModel': 'test-model',
  'wenmai.baseUrl': '',
  'wenmai.chatUrl': '',
  'wenmai.maxSentences': 1,
  'wenmai.maxChars': 220,
  'wenmai.maxTokens': 64,
  'wenmai.temperature': 0.3,
  'wenmai.prefixChars': 1500,
  'wenmai.longPrefixChars': 6000,
  'wenmai.useSuffix': true,
  'wenmai.suffixChars': 500,
  'wenmai.debounceMs': 0,
  'wenmai.minIntervalMs': 0,
  'wenmai.minPromptChars': 4,
  'wenmai.timeoutMs': 5000,
  'wenmai.stream': true,
  'wenmai.proseOnly': true,
  'wenmai.autoFix': true,
  'wenmai.fixCjkLatinSpacing': true,
  'wenmai.languages': ['plaintext', 'markdown'],
  'wenmai.cacheSize': 10,
  'wenmai.showStatusBar': true,
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
      this.isTrusted = false
    }
  },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id
    }
  },
  Position: class Position {
    constructor(line, character) {
      this.line = line
      this.character = character
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
  Range: class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'number') {
        this.start = { line: a, character: b }
        this.end = { line: c, character: d }
      } else {
        this.start = a
        this.end = b
      }
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
    createStatusBarItem: () => ({
      show() {},
      hide() {},
      dispose() {}
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => ({}),
    setStatusBarMessage: () => {},
    createTextEditorDecorationType: (options) => {
      const type = {
        options,
        disposed: false,
        dispose() {
          this.disposed = true
        }
      }
      decorationTypes.push(type)
      return type
    },
    onDidChangeTextEditorSelection: (handler) => {
      selectionHandlers.push(handler)
      return { dispose() {} }
    },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    withProgress: async (options, task) =>
      task(
        { report() {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} })
        }
      )
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = `${section}.${key}`
        return Object.prototype.hasOwnProperty.call(config, full) ? config[full] : fallback
      },
      // useSuffix 只认显式设置，这里把测试配置当作用户显式写入的值。
      inspect: (key) => {
        const full = `${section}.${key}`
        const has = Object.prototype.hasOwnProperty.call(config, full)
        return {
          key: full,
          defaultValue: has ? config[full] : undefined,
          globalValue: has ? config[full] : undefined,
          workspaceValue: undefined,
          workspaceFolderValue: undefined
        }
      },
      update: async () => {}
    }),
    openTextDocument: async (options) => {
      previewContent = options && options.content ? options.content : ''
      return { uri: { scheme: 'untitled' }, getText: () => previewContent }
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    applyEdit: async (edit) => {
      const editor = mock.window.activeTextEditor
      const document = editor && editor.document
      if (!document || !edit || !Array.isArray(edit.edits) || edit.edits.length === 0) {
        return false
      }
      const text = document.getText()
      const ordered = edit.edits
        .map((item) => ({
          start: document.offsetAt(item.range.start),
          end: document.offsetAt(item.range.end),
          text: item.text
        }))
        .sort((a, b) => b.start - a.start)
      let out = text
      for (const item of ordered) {
        out = out.slice(0, item.start) + item.text + out.slice(item.end)
      }
      if (typeof document.setText === 'function') document.setText(out)
      if (typeof document.version === 'number') document.version++
      return true
    }
  },
  commands: {
    registerCommand: (id, handler) => {
      commands[id] = handler
      return { dispose() {} }
    },
    executeCommand: async (id) => {
      executedCommands.push(id)
      return true
    }
  },
  languages: {
    registerInlineCompletionItemProvider: (selector, instance) => {
      provider = instance
      return { dispose() {} }
    },
    registerCodeActionsProvider: (selector, instance) => {
      codeActionProvider = instance
      return { dispose() {} }
    }
  },
  extensions: {
    getExtension: () => undefined
  }
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return mock
  return originalLoad.call(this, request, parent, isMain)
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (_) {}
        if (req.url === '/chat') {
          chatRequests++
          lastChatBody = body
          if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end(
              'data: ' +
                JSON.stringify({ choices: [{ delta: { content: '你好，世界。' } }] }) +
                '\n\ndata: [DONE]\n\n'
            )
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({ choices: [{ message: { content: '你好，世界。' } }] })
            )
          }
          return
        }

        completionRequests++
        lastCompletionBody = body
        completionBodies.push(body)

        // FIM 端点稳定返回空：无论预算多大都没有正文。
        if (String(body.prompt || '').includes('FIM永远为空')) {
          if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end(
              'data: ' +
                JSON.stringify({
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { completion_tokens: 0 }
                }) +
                '\n\ndata: [DONE]\n\n'
            )
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                choices: [{ message: { content: '' }, finish_reason: 'stop' }],
                usage: { completion_tokens: 0 }
              })
            )
          }
          return
        }

        // 模拟推理模型把 token 预算吃光：预算小时正文为空，
        // 放大预算后的重试才有内容。
        if (
          String(body.prompt || '').includes('空响应测试') &&
          Number(body.max_tokens) <= 100
        ) {
          if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end('data: [DONE]\n\n')
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                choices: [
                  { message: { content: '' }, finish_reason: 'length' }
                ],
                usage: {
                  completion_tokens: Number(body.max_tokens),
                  completion_tokens_details: {
                    reasoning_tokens: Number(body.max_tokens)
                  }
                }
              })
            )
          }
          return
        }

        if (body.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { content: '看你怎么做。' },
                  finish_reason: 'stop'
                }
              ]
            })
          )
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const deltas = ['看', '你怎么做。', '下一句。']
        let index = 0
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer)
            return
          }
          if (index < deltas.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ text: deltas[index] }] })}\n\n`)
            index++
          } else {
            res.write('data: [DONE]\n\n')
            res.end()
            clearInterval(timer)
          }
        }, 10)
        res.on('error', () => clearInterval(timer))
      })
    })
    server.on('clientError', (error, socket) => {
      try {
        socket.destroy()
      } catch (_) {}
    })
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      resolve(server)
    })
  })
}

function makeToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
  }
}

async function main() {
  const server = await startServer()
  config['wenmai.baseUrl'] = `http://127.0.0.1:${port}/beta`
  config['wenmai.chatUrl'] = `http://127.0.0.1:${port}/chat`

  const secrets = new Map([
    ['wenmai.apiKey', 'sk-test'],
    ['deepseekFim.apiKey', 'legacy-test']
  ])
  const secretDeletes = []
  const context = {
    subscriptions: [],
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        secrets.set(key, value)
      },
      delete: async (key) => {
        secretDeletes.push(key)
        secrets.delete(key)
      }
    },
    globalState: {
      get: () => true,
      update: async () => {}
    }
  }

  const extension = require('./extension.js')
  extension.activate(context)

  if (!provider) throw new Error('provider 未注册')

  // 本地修正和 AI 续写统一用 Tab 接受，但只在预览存在且没有其他 Tab 目标时接管。
  const pkg = require('./package.json')
  const tabBinding = (pkg.contributes.keybindings || []).find(
    (item) => item.command === 'wenmai.acceptLocalFix' && item.key === 'tab'
  )
  if (!tabBinding) throw new Error('本地修正缺少 Tab 键绑定')
  if (!/wenmai\.localFixPending/.test(tabBinding.when || '')) {
    throw new Error(`Tab 键绑定缺少预览上下文: ${tabBinding.when}`)
  }
  if (!/!inlineSuggestionVisible/.test(tabBinding.when || '')) {
    throw new Error(`Tab 键绑定未避让 AI 行内建议: ${tabBinding.when}`)
  }
  if (!commands['wenmai.acceptLocalFix']) {
    throw new Error('本地修正应用命令未注册')
  }

  const text = '群众不看你说什么，只看'
  const document = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => text,
    offsetAt: (position) => position.offset
  }
  const position = { line: 0, character: text.length, offset: text.length }

  const items = await provider.provideInlineCompletionItems(
    document,
    position,
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )

  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error(`expected 1 item, got ${JSON.stringify(items)}`)
  }
  if (items[0].insertText !== '看你怎么做。') {
    throw new Error(`unexpected insertText: ${JSON.stringify(items[0].insertText)}`)
  }

  // FIM 请求永远不带 suffix：行内续写是往光标前插入，只依据上文。
  // suffix 是“填空”语义，后文完整时会让模型返回 0 token 空结果。
  if (lastCompletionBody && lastCompletionBody.suffix !== undefined) {
    throw new Error(`FIM 不应发送 suffix: ${JSON.stringify(lastCompletionBody.suffix)}`)
  }

  // 光标后有内容时也不发送 suffix，且后文不混入 prompt。
  const tail = '后面'.repeat(300)
  const suffixText = text + tail
  const suffixDoc = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => suffixText,
    offsetAt: (position) => position.offset
  }
  const suffixItems = await provider.provideInlineCompletionItems(
    suffixDoc,
    { line: 0, character: text.length, offset: text.length },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )
  if (!Array.isArray(suffixItems) || suffixItems[0].insertText !== '看你怎么做。') {
    throw new Error(`段中光标建议异常: ${JSON.stringify(suffixItems)}`)
  }
  if (!lastCompletionBody || lastCompletionBody.suffix !== undefined) {
    throw new Error(
      `段中光标也不应发送 suffix: ${JSON.stringify(lastCompletionBody && lastCompletionBody.suffix)}`
    )
  }
  if (lastCompletionBody.prompt.includes(tail)) {
    throw new Error('后文不应混入 prompt')
  }

  // 空响应：推理模型可能把预算全用在隐藏 token 上。文脉应自动放大预算，
  // 用非流式重试一次，而不是让幽灵文本“消失”。
  const emptyText = '空响应测试，继续写作。'
  const emptyDoc = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => emptyText,
    offsetAt: (position) => position.offset
  }
  const beforeEmpty = completionBodies.length
  const emptyItems = await provider.provideInlineCompletionItems(
    emptyDoc,
    { line: 0, character: emptyText.length, offset: emptyText.length },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )
  if (!Array.isArray(emptyItems) || emptyItems[0].insertText !== '看你怎么做。') {
    throw new Error(`空响应重试后仍无建议: ${JSON.stringify(emptyItems)}`)
  }
  const emptyAttempts = completionBodies.slice(beforeEmpty)
  if (emptyAttempts.length !== 2) {
    throw new Error(`空响应应重试一次，实际请求 ${emptyAttempts.length} 次`)
  }
  if (emptyAttempts[0].max_tokens !== config['wenmai.maxTokens']) {
    throw new Error('首次请求应使用配置的 token 预算')
  }
  if (emptyAttempts[1].max_tokens !== 400 || emptyAttempts[1].stream !== false) {
    throw new Error(
      `重试应放大预算并关闭流式: ${JSON.stringify(emptyAttempts[1])}`
    )
  }

  // FIM 两次都空（finish_reason=stop, 0 token）时，应改用 Chat 端点兜底，
  // 而不是让幽灵文本消失。光标后的文字只作为 Chat 的参考上下文，
  // 由 useSuffix 控制；FIM 请求本身永远不带 suffix。
  const tailText = '后面已经写好了。'
  const deadText = 'FIM永远为空测试，继续写作。'
  const deadDoc = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => deadText + tailText,
    offsetAt: (position) => position.offset
  }
  const beforeChat = chatRequests
  const beforeDeadFim = completionBodies.length
  const deadItems = await provider.provideInlineCompletionItems(
    deadDoc,
    { line: 0, character: deadText.length, offset: deadText.length },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )
  if (!Array.isArray(deadItems) || deadItems[0].insertText !== '你好，世界。') {
    throw new Error(`Chat 兜底未返回建议: ${JSON.stringify(deadItems)}`)
  }
  if (chatRequests !== beforeChat + 1) {
    throw new Error(`应请求 Chat 端点一次，实际 ${chatRequests - beforeChat} 次`)
  }
  if (completionBodies.length !== beforeDeadFim + 1) {
    throw new Error(
      `finish_reason=stop 时不应再做预算重试，FIM 请求 ${completionBodies.length - beforeDeadFim} 次`
    )
  }
  const chatUser = lastChatBody && lastChatBody.messages
    ? lastChatBody.messages[lastChatBody.messages.length - 1].content
    : ''
  if (!chatUser.includes('【上文】') || !chatUser.includes('【续写位置】')) {
    throw new Error(`Chat 兜底消息缺少上下文: ${JSON.stringify(chatUser)}`)
  }
  if (!chatUser.includes('【光标后原文】') || !chatUser.includes(tailText)) {
    throw new Error(`开启 useSuffix 时 Chat 兜底应带上后文参考: ${JSON.stringify(chatUser)}`)
  }

  // 关闭 useSuffix 后，Chat 兜底也不再带光标后的文字。
  config['wenmai.useSuffix'] = false
  const noSuffixText = 'FIM永远为空测试二，继续写作。'
  const noSuffixDoc = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => noSuffixText + tailText,
    offsetAt: (position) => position.offset
  }
  await provider.provideInlineCompletionItems(
    noSuffixDoc,
    { line: 0, character: noSuffixText.length, offset: noSuffixText.length },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )
  const noSuffixUser = lastChatBody && lastChatBody.messages
    ? lastChatBody.messages[lastChatBody.messages.length - 1].content
    : ''
  if (noSuffixUser.includes('【光标后原文】') || noSuffixUser.includes(tailText)) {
    throw new Error(`关闭 useSuffix 后 Chat 兜底不应带后文: ${JSON.stringify(noSuffixUser)}`)
  }
  config['wenmai.useSuffix'] = true

  // 只移动光标（不输入）时，应主动执行 inlineSuggest.trigger，
  // 否则 VS Code 不会调用 provider，幽灵文本永远等不到。
  const cursorDoc = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    isReadOnly: false,
    getText: () => '光标移动触发测试'
  }
  const cursorEditor = {
    document: cursorDoc,
    selection: {
      isEmpty: true,
      active: { line: 0, character: 4 }
    }
  }
  mock.window.activeTextEditor = cursorEditor
  config['wenmai.triggerOnCursorMove'] = true

  const beforeTrigger = executedCommands.length
  for (const handler of selectionHandlers) {
    handler({
      textEditor: cursorEditor,
      selections: [cursorEditor.selection],
      kind: 1
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 160))

  const triggered = executedCommands
    .slice(beforeTrigger)
    .filter((id) => id === 'editor.action.inlineSuggest.trigger')
  if (triggered.length !== 1) {
    throw new Error(`光标移动应触发一次行内建议，实际 ${triggered.length} 次`)
  }

  // 关闭开关后不再自动触发。
  config['wenmai.triggerOnCursorMove'] = false
  const beforeDisabled = executedCommands.length
  for (const handler of selectionHandlers) {
    handler({
      textEditor: cursorEditor,
      selections: [cursorEditor.selection],
      kind: 1
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 160))
  const triggeredWhenDisabled = executedCommands
    .slice(beforeDisabled)
    .filter((id) => id === 'editor.action.inlineSuggest.trigger')
  if (triggeredWhenDisabled.length !== 0) {
    throw new Error('关闭 triggerOnCursorMove 后不应自动触发')
  }
  config['wenmai.triggerOnCursorMove'] = true

  // 本地修正：标准 InlineCompletionItem 在该版本无法显示“光标前插入”，
  // 必须由装饰器预览承担；provider 命中后返回 undefined，且不产生 HTTP 请求。
  const beforeFixRequests = completionRequests
  const headingDoc = {
    languageId: 'markdown',
    uri: {
      scheme: 'file',
      toString: () => 'file:///test-heading.md'
    },
    lineCount: 1,
    version: 1,
    isReadOnly: false,
    _text: '##3.内容',
    getText() {
      return this._text
    },
    setText(value) {
      this._text = value
    },
    lineAt(line) {
      return { text: this._text.split('\n')[line] || '' }
    },
    offsetAt(position) {
      return position.character
    }
  }
  const fixItems = await provider.provideInlineCompletionItems(
    headingDoc,
    { line: 0, character: headingDoc._text.length, offset: headingDoc._text.length },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )
  if (fixItems !== undefined) {
    throw new Error(`本地修正不应返回 InlineCompletionItem: ${JSON.stringify(fixItems)}`)
  }
  if (completionRequests !== beforeFixRequests) {
    throw new Error('本地修正不应发起 HTTP 请求')
  }

  const headingEditor = {
    document: headingDoc,
    selection: {
      active: { line: 0, character: headingDoc._text.length },
      isEmpty: true
    },
    _decorations: new Map(),
    setDecorations(type, decorations) {
      this._decorations.set(type, decorations)
    }
  }
  mock.window.activeTextEditor = headingEditor
  extension._runtime.preview.refresh()

  const strikeEntry = [...headingEditor._decorations.entries()].find(
    ([type]) => type.options && type.options.textDecoration === 'line-through'
  )
  const ghostEntry = [...headingEditor._decorations.entries()].find(
    ([type]) => type.options && type.options.after
  )
  // 标题修正只是插入一个空格：不应给任何字符画删除线，也不应预览整行。
  if (!strikeEntry || strikeEntry[1].length !== 0) {
    throw new Error(`纯插入修正不应删除原文: ${JSON.stringify(strikeEntry && strikeEntry[1])}`)
  }
  if (!ghostEntry || ghostEntry[1].length !== 1) {
    throw new Error('本地修正未显示就地幽灵文本')
  }
  if (!ghostEntry[0].options.after.contentText.includes('␣')) {
    throw new Error(`空格插入预览异常: ${JSON.stringify(ghostEntry[0].options.after)}`)
  }
  if (
    ghostEntry[1][0].range.start.character !== 2 ||
    ghostEntry[1][0].range.end.character !== 2
  ) {
    throw new Error(`幽灵文本位置异常: ${JSON.stringify(ghostEntry[1][0].range)}`)
  }
  if (!ghostEntry[1][0].hoverMessage || !ghostEntry[1][0].hoverMessage.isTrusted) {
    throw new Error('本地修正悬停提示不可点击')
  }
  const headingPending = extension._runtime.preview._pending()
  if (
    !headingPending ||
    headingPending.hunks.length !== 1 ||
    headingPending.hunks[0].start !== 2 ||
    headingPending.hunks[0].end !== 2 ||
    headingPending.hunks[0].replacement !== ' '
  ) {
    throw new Error(`标题最小差异异常: ${JSON.stringify(headingPending && headingPending.hunks)}`)
  }

  const actions = codeActionProvider.provideCodeActions(
    headingDoc,
    new mock.Range(0, headingDoc._text.length, 0, headingDoc._text.length)
  )
  if (!Array.isArray(actions) || actions.length !== 1) {
    throw new Error(`本地修正未提供 Code Action: ${JSON.stringify(actions)}`)
  }
  if (
    !actions[0].edit ||
    actions[0].edit.edits.length !== 1 ||
    actions[0].edit.edits[0].text !== ' ' ||
    actions[0].edit.edits[0].range.start.character !== 2 ||
    actions[0].edit.edits[0].range.end.character !== 2
  ) {
    throw new Error(`Code Action 不是最小差异: ${JSON.stringify(actions[0])}`)
  }

  const accepted = await commands['wenmai.acceptLocalFix']()
  if (!accepted) throw new Error('本地修正应用命令失败')
  if (headingDoc.getText() !== '## 3.内容') {
    throw new Error(`本地修正应用结果异常: ${JSON.stringify(headingDoc.getText())}`)
  }
  if (extension._runtime.stats.fixed !== 1) {
    throw new Error(`本地修正统计异常: ${extension._runtime.stats.fixed}`)
  }
  if ([...headingEditor._decorations.values()].some((items) => items.length > 0)) {
    throw new Error('本地修正应用后装饰器未清理')
  }

  // 标点替换：只改逗号本身，删除线和小幽灵文本都必须落在逗号附近。
  const punctDoc = {
    languageId: 'markdown',
    uri: {
      scheme: 'file',
      toString: () => 'file:///test-punct.md'
    },
    lineCount: 1,
    version: 1,
    isReadOnly: false,
    _text: '中文,测试',
    getText() {
      return this._text
    },
    setText(value) {
      this._text = value
    },
    lineAt(line) {
      return { text: this._text.split('\n')[line] || '' }
    },
    offsetAt(position) {
      return position.character
    }
  }
  const punctEditor = {
    document: punctDoc,
    selection: {
      active: { line: 0, character: punctDoc._text.length },
      isEmpty: true
    },
    _decorations: new Map(),
    setDecorations(type, decorations) {
      this._decorations.set(type, decorations)
    }
  }
  mock.window.activeTextEditor = punctEditor
  extension._runtime.preview.refresh()

  const punctStrike = [...punctEditor._decorations.entries()].find(
    ([type]) => type.options && type.options.textDecoration === 'line-through'
  )
  const punctGhost = [...punctEditor._decorations.entries()].find(
    ([type]) => type.options && type.options.after
  )
  if (!punctStrike || punctStrike[1].length !== 1) {
    throw new Error(`标点修正应只给一个片段画删除线: ${JSON.stringify(punctStrike && punctStrike[1])}`)
  }
  if (
    punctStrike[1][0].range.start.character !== 2 ||
    punctStrike[1][0].range.end.character !== 3
  ) {
    throw new Error(`标点删除线范围异常: ${JSON.stringify(punctStrike[1][0].range)}`)
  }
  if (
    !punctGhost ||
    punctGhost[1].length !== 1 ||
    !punctGhost[0].options.after.contentText.includes('，')
  ) {
    throw new Error(`标点幽灵文本异常: ${JSON.stringify(punctGhost && punctGhost[0].options.after)}`)
  }
  if (
    punctGhost[1][0].range.start.character !== 3 ||
    punctGhost[1][0].range.end.character !== 3
  ) {
    throw new Error(`标点幽灵文本位置异常: ${JSON.stringify(punctGhost[1][0].range)}`)
  }

  const punctActions = codeActionProvider.provideCodeActions(
    punctDoc,
    new mock.Range(0, punctDoc._text.length, 0, punctDoc._text.length)
  )
  if (
    !Array.isArray(punctActions) ||
    punctActions[0].edit.edits.length !== 1 ||
    punctActions[0].edit.edits[0].text !== '，' ||
    punctActions[0].edit.edits[0].range.start.character !== 2 ||
    punctActions[0].edit.edits[0].range.end.character !== 3
  ) {
    throw new Error(`标点 Code Action 不是最小差异: ${JSON.stringify(punctActions)}`)
  }

  const punctAccepted = await commands['wenmai.acceptLocalFix']()
  if (!punctAccepted) throw new Error('标点修正应用命令失败')
  if (punctDoc.getText() !== '中文，测试') {
    throw new Error(`标点修正应用结果异常: ${JSON.stringify(punctDoc.getText())}`)
  }
  if (extension._runtime.stats.fixed !== 2) {
    throw new Error(`标点修正统计异常: ${extension._runtime.stats.fixed}`)
  }

  // 代码块内应当跳过
  const fenced = '前面的一些文字\n```js\nconst a = 1\n'
  const fencedDoc = {
    languageId: 'markdown',
    uri: { scheme: 'file' },
    lineCount: 1,
    getText: () => fenced,
    offsetAt: (position) => position.offset
  }
  const skipped = await provider.provideInlineCompletionItems(
    fencedDoc,
    { line: 0, character: fenced.length, offset: fenced.length },
    { selectedCompletionInfo: undefined, triggerKind: 0 },
    makeToken()
  )

  if (skipped !== undefined) {
    throw new Error('代码块内不应返回建议')
  }

  // 长续写命令：同一份 mock 配置下走 /chat，并插入到发起时的光标位置。
  const inserted = []
  const editorText = '群众不看你说什么，只看'
  const editorDocument = {
    languageId: 'plaintext',
    uri: { scheme: 'file' },
    version: 1,
    getText: () => editorText,
    offsetAt: (pos) => pos.offset
  }
  mock.window.activeTextEditor = {
    document: editorDocument,
    selection: { active: { line: 0, character: editorText.length, offset: editorText.length } },
    edit: async (callback) => {
      callback({ insert: (pos, value) => inserted.push({ pos, value }) })
      return true
    }
  }

  await commands['wenmai.continueLong']()

  if (inserted.length !== 1 || inserted[0].value !== '你好，世界。') {
    throw new Error(`长续写插入异常: ${JSON.stringify(inserted)}`)
  }

  await commands['wenmai.showPrompt']()
  if (
    !previewContent.includes('写作设定') ||
    !previewContent.includes('自动续写（FIM）实际 prompt') ||
    !previewContent.includes('长续写（Chat）messages')
  ) {
    throw new Error(`提示词预览异常: ${previewContent.slice(0, 200)}`)
  }

  // 设置 Key 时取消输入不能删掉已有密钥（旧实现先删后问）。
  extension._runtime.keyCache = null
  const deletesBefore = secretDeletes.length
  await commands['wenmai.setApiKey']()
  if (
    secretDeletes.length !== deletesBefore ||
    secrets.get('wenmai.apiKey') !== 'sk-test'
  ) {
    throw new Error('取消设置 API Key 时不应删除已有密钥')
  }

  // 确认输入后写入新 Key，并清掉旧扩展的密钥。
  mock.window.showInputBox = async () => 'sk-new'
  await commands['wenmai.setApiKey']()
  if (secrets.get('wenmai.apiKey') !== 'sk-new') {
    throw new Error('新 API Key 未保存')
  }
  if (secrets.has('deepseekFim.apiKey')) {
    throw new Error('设置新 Key 后应清理旧扩展密钥')
  }
  mock.window.showInputBox = async () => undefined

  console.log('provider smoke test OK')
  console.log(`insertText: ${JSON.stringify(items[0].insertText)}`)
  console.log(`光标后文本不进 FIM 请求: OK`)
  console.log(`本地修正预览（最小差异 + 幽灵文本 + Tab/应用）: OK`)
  console.log(`空响应放大预算重试: OK`)
  console.log(`FIM 空响应转 Chat 兜底: OK`)
  console.log(`光标移动自动触发（含开关）: OK`)
  console.log(`代码块跳过: OK`)
  console.log(`长续写插入: ${JSON.stringify(inserted[0].value)}`)
  console.log(`提示词预览: OK`)

  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
