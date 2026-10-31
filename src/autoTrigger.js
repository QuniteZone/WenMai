'use strict'

/*
 * 光标移动触发。
 *
 * VS Code 只会在输入/删除后自动请求行内建议；仅仅移动光标不会调用
 * InlineCompletionItemProvider。写作时把光标放到某一段末尾、准备接着写，
 * 却必须先敲一个字才能看到幽灵文本，这很反直觉。
 *
 * 这里监听选区变化，在光标停稳后执行官方命令
 * editor.action.inlineSuggest.trigger，效果等同于手动按 Ctrl+Alt+Space。
 *
 * 注意区分两类光标变化：
 * - 输入导致的（短时间内有文档变更）交给 VS Code 原生触发，避免重复请求；
 * - 鼠标点击、方向键、切换编辑器导致的，才由这里补一次触发。
 * 同时加防抖和冷却，快速移动光标不会连续发请求。
 */

const vscode = require('vscode')

const log = require('./logger')
const { readConfig, isLanguageAllowed } = require('./config')

const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs'])
const SETTLE_MS = 80
const TEXT_CHANGE_GUARD_MS = 200

function createAutoTrigger(runtime) {
  let timer = null
  let lastTextChangeAt = 0
  let disposed = false

  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function fire(editor) {
    if (disposed) return
    if (!editor || !editor.document) return
    if (vscode.window.activeTextEditor !== editor) return

    const cfg = readConfig()
    if (!cfg.triggerOnCursorMove || !cfg.enabled) return
    if (Date.now() - lastTextChangeAt < TEXT_CHANGE_GUARD_MS) return
    if (!editor.selection || !editor.selection.isEmpty) return
    if (editor.document.isReadOnly) return
    if (!SUPPORTED_SCHEMES.has(editor.document.uri.scheme)) return
    if (!isLanguageAllowed(editor.document.languageId, cfg.languages)) return

    Promise.resolve(
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
    ).then(
      (shown) => {
        if (shown === false) log.debug('光标移动触发：当前没有可显示的建议')
      },
      (error) => {
        log.debug(`光标移动触发失败：${(error && error.message) || error}`)
      }
    )
  }

  function schedule(editor) {
    if (disposed) return
    cancel()
    if (!editor) return
    timer = setTimeout(() => {
      timer = null
      fire(editor)
    }, SETTLE_MS)
  }

  const selectionSub = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!event || !event.textEditor) return
    const editor = event.textEditor
    if (vscode.window.activeTextEditor && editor !== vscode.window.activeTextEditor) {
      return
    }

    // 有选区（选中文字）或出现多光标时不打断用户。
    if (!event.selections || event.selections.length !== 1) {
      cancel()
      return
    }
    if (!event.selections[0].isEmpty) {
      cancel()
      return
    }

    // 输入本身会触发 VS Code 原生行内建议，这里不重复请求。
    if (Date.now() - lastTextChangeAt < TEXT_CHANGE_GUARD_MS) return

    schedule(editor)
  })

  const activeSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    cancel()
    if (editor) schedule(editor)
  })

  const textSub = vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor
    if (!editor || event.document !== editor.document) return
    lastTextChangeAt = Date.now()
    cancel()
  })

  // 扩展激活时编辑器已经打开的情况：没有 activeTextEditor 变化事件，
  // 补一次触发，避免“刚启动后光标停着却一直不出现建议”。
  if (vscode.window.activeTextEditor) {
    schedule(vscode.window.activeTextEditor)
  }

  return {
    dispose() {
      disposed = true
      cancel()
      for (const item of [selectionSub, activeSub, textSub]) {
        try {
          item.dispose()
        } catch (_) {}
      }
    }
  }
}

module.exports = { createAutoTrigger }
