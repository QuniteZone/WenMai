'use strict'

/*
 * L1 本地修正的行内预览。
 *
 * 为什么不用 InlineCompletionItem：
 * VS Code 1.144 的行内建议可见性判定要求“新文本在光标前的前缀必须
 * startsWith 旧文本在光标前的前缀”。本地修正经常要在光标前插入空格、
 * 替换标点，标准 InlineCompletionItem 会被内部过滤掉，扩展宿主也
 * 没有把 filterText 传进内部模型，所以无法用原生幽灵文本展示。
 *
 * 这里改用装饰器，并且只标出真正变化的片段：
 * - 只有差异字符画删除线，不再整行删除；
 * - 在差异位置就地显示斜体、editorGhostText 配色的替换文本；
 * - 应用时只提交差异范围，未变化的内容不重新写入；
 * - 和 AI 续写统一：Tab 应用，悬停可点击，也保留 Ctrl+Alt+. 和快速修复。
 *
 * 装饰器只负责预览，真正写入文档必须经过 accept()，不会静默改文件。
 */

const vscode = require('vscode')

const log = require('./logger')
const { readConfig, isLanguageAllowed } = require('./config')
const { detectLocalFix } = require('./fix')
const { diffSegments } = require('./diff')

const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs'])
// 预览比 AI 续写的防抖更慢一些：输入法输拼音时会产生大量短暂的“候选”，
// 等用户真正停下来再画删除线，避免一闪一闪，也避免误判。
const PREVIEW_DELAY_MS = 450
const CODE_ACTION_LANGUAGES = [
  { language: 'markdown' },
  { language: 'mdx' },
  { language: 'quarto' },
  { language: 'rmd' },
  { language: 'latex' },
  { language: 'tex' }
]

function makeHover(changes) {
  const hover = new vscode.MarkdownString(
    [
      `**文脉本地修正**：${changes.join('、')}`,
      '',
      '只替换有差异的字符，其余内容保持原样。',
      '',
      '[应用修正](command:wenmai.acceptLocalFix) · [忽略](command:wenmai.dismissLocalFix)',
      '',
      '快捷键：Tab（与 AI 续写一致）；备用 Ctrl+Alt+.（macOS：Cmd+Alt+.）'
    ].join('\n')
  )
  hover.isTrusted = true
  return hover
}

/** 让插入的空格/制表符在行内预览里可见。 */
function visibleReplacement(text) {
  if (/^[ \t]+$/.test(text)) {
    return text.replace(/ /g, '␣').replace(/\t/g, '⇥')
  }
  return text
}

function createLocalFixPreview(runtime) {
  const strikeType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    opacity: '0.55'
  })

  let ghostTypes = []
  let decoratedEditor = null
  let pending = null
  let timer = null
  let disposed = false
  // 用户点过“忽略”的修正：在文本再次变化前不要又冒出来。
  let dismissedSignature = ''

  function setPendingContext(value) {
    try {
      Promise.resolve(
        vscode.commands.executeCommand('setContext', 'wenmai.localFixPending', value)
      ).then(undefined, () => {})
    } catch (_) {}
  }

  function clear() {
    // 取消排队中的刷新，否则 dismiss() 之后 450ms 又会把预览画回来。
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (decoratedEditor) {
      try {
        decoratedEditor.setDecorations(strikeType, [])
        for (const type of ghostTypes) {
          decoratedEditor.setDecorations(type, [])
        }
      } catch (_) {}
    }
    for (const type of ghostTypes) {
      try {
        type.dispose()
      } catch (_) {}
    }
    ghostTypes = []
    decoratedEditor = null
    pending = null
    setPendingContext(false)
  }

  function schedule() {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, PREVIEW_DELAY_MS)
  }

  function refresh() {
    if (disposed) return

    const editor = vscode.window.activeTextEditor
    if (!editor || !editor.document || !editor.selection) {
      clear()
      return
    }

    // 切换编辑器时，旧编辑器上的装饰器要主动清掉。
    if (decoratedEditor && decoratedEditor !== editor) clear()

    const document = editor.document
    const cfg = readConfig()
    if (
      !cfg.autoFix ||
      !isLanguageAllowed(document.languageId, cfg.languages) ||
      !SUPPORTED_SCHEMES.has(document.uri.scheme) ||
      document.isReadOnly ||
      !editor.selection.isEmpty ||
      (Array.isArray(editor.selections) && editor.selections.length > 1)
    ) {
      clear()
      return
    }

    let fixed
    try {
      const position = editor.selection.active
      fixed = detectLocalFix({
        text: document.getText(),
        offset: document.offsetAt(position),
        languageId: document.languageId,
        cfg
      })
    } catch (error) {
      log.debug('本地修正预览计算失败', error)
      clear()
      return
    }

    if (!fixed) {
      clear()
      return
    }

    const position = editor.selection.active
    let lineText = ''
    try {
      lineText = document.lineAt(position.line).text
    } catch (_) {
      clear()
      return
    }
    if (lineText !== fixed.oldText) {
      clear()
      return
    }

    const hunks = diffSegments(fixed.oldText, fixed.newText)
    if (hunks.length === 0) {
      clear()
      return
    }

    const signature = [
      document.uri.toString(),
      position.line,
      fixed.oldText,
      fixed.newText
    ].join('\u0000')

    if (dismissedSignature === signature) return

    // 同一行、同一修正内容不重复创建装饰器，但同步文档版本，
    // 避免用户在其他地方改动后旧版本号让应用命令失效。
    if (pending && decoratedEditor === editor && pending.signature === signature) {
      pending.version = document.version
      return
    }

    clear()

    const hover = makeHover(fixed.changes)
    const strikeDecorations = []

    decoratedEditor = editor

    for (const hunk of hunks) {
      if (hunk.end > hunk.start) {
        strikeDecorations.push({
          range: new vscode.Range(
            position.line,
            hunk.start,
            position.line,
            hunk.end
          ),
          hoverMessage: hover
        })
      }

      if (!hunk.replacement) continue

      const shown = visibleReplacement(hunk.replacement)
      const ghostType = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: `   ⟶   ${shown}`,
          color: new vscode.ThemeColor('editorGhostText.foreground'),
          fontStyle: 'italic',
          margin: '0 0 0 0.2em'
        }
      })
      ghostTypes.push(ghostType)
      editor.setDecorations(ghostType, [
        {
          range: new vscode.Range(
            position.line,
            hunk.end,
            position.line,
            hunk.end
          ),
          hoverMessage: hover
        }
      ])
    }

    editor.setDecorations(strikeType, strikeDecorations)

    pending = {
      signature,
      uri: document.uri.toString(),
      version: document.version,
      line: position.line,
      oldText: fixed.oldText,
      newText: fixed.newText,
      changes: fixed.changes,
      hunks
    }
    setPendingContext(true)
  }

  async function accept() {
    if (!pending) refresh()
    if (!pending) {
      vscode.window.setStatusBarMessage('文脉：当前行没有可应用的本地修正', 2000)
      return false
    }

    const editor = vscode.window.activeTextEditor
    if (!editor || !editor.document || editor.document.uri.toString() !== pending.uri) {
      clear()
      return false
    }

    const document = editor.document
    let lineText = ''
    try {
      lineText = document.lineAt(pending.line).text
    } catch (_) {
      clear()
      return false
    }
    if (lineText !== pending.oldText) {
      refresh()
      return false
    }
    if (editor.selection.active.line !== pending.line) {
      refresh()
      return false
    }

    const snapshot = pending
    const oldCursor = editor.selection.active.character
    const edit = new vscode.WorkspaceEdit()
    for (const hunk of snapshot.hunks) {
      edit.replace(
        document.uri,
        new vscode.Range(
          snapshot.line,
          hunk.start,
          snapshot.line,
          hunk.end
        ),
        hunk.replacement
      )
    }

    let applied = false
    try {
      applied = await vscode.workspace.applyEdit(edit)
    } catch (error) {
      log.warn(`应用本地修正失败：${(error && error.message) || error}`)
    }
    if (!applied) {
      vscode.window.setStatusBarMessage('文脉：应用本地修正失败，文档可能已被修改', 3000)
      return false
    }

    // 光标跟着差异长度平移，避免改完一个标点后跳到其他位置。
    let newLineLength = snapshot.oldText.length
    let delta = 0
    for (const hunk of snapshot.hunks) {
      const change = hunk.replacement.length - (hunk.end - hunk.start)
      newLineLength += change
      if (hunk.end <= oldCursor || hunk.start < oldCursor) delta += change
    }
    const cursor = Math.max(0, Math.min(oldCursor + delta, newLineLength))
    const end = new vscode.Position(snapshot.line, cursor)
    try {
      editor.selection = new vscode.Selection(end, end)
    } catch (_) {}

    runtime.stats.fixed++
    log.info(
      `本地修正已应用 | ${snapshot.changes.join('、')} | ${snapshot.oldText.length} 字`
    )
    clear()
    if (runtime.notify) runtime.notify()
    return true
  }

  function dismiss() {
    if (pending) dismissedSignature = pending.signature
    clear()
    return true
  }

  function provideCodeActions(document, range) {
    const cfg = readConfig()
    if (
      !cfg.autoFix ||
      !isLanguageAllowed(document.languageId, cfg.languages) ||
      !SUPPORTED_SCHEMES.has(document.uri.scheme) ||
      document.isReadOnly
    ) {
      return undefined
    }

    let fixed
    try {
      fixed = detectLocalFix({
        text: document.getText(),
        offset: document.offsetAt(range.start),
        languageId: document.languageId,
        cfg,
        // 快速修复是用户主动触发的，不受“正在输入”保护影响。
        manual: true
      })
    } catch (_) {
      return undefined
    }
    if (!fixed) return undefined

    const hunks = diffSegments(fixed.oldText, fixed.newText)
    if (hunks.length === 0) return undefined

    const action = new vscode.CodeAction(
      `文脉：应用本地修正（${fixed.changes.join('、')}）`,
      vscode.CodeActionKind.QuickFix
    )
    action.isPreferred = true
    action.edit = new vscode.WorkspaceEdit()
    for (const hunk of hunks) {
      action.edit.replace(
        document.uri,
        new vscode.Range(
          range.start.line,
          hunk.start,
          range.start.line,
          hunk.end
        ),
        hunk.replacement
      )
    }
    return [action]
  }

  // 激活时如果光标已经停在可修正行上，也应该立即看到预览。
  setTimeout(() => {
    if (!disposed) refresh()
  }, 0)

  const disposables = [
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(() => {
      dismissedSignature = ''
      clear()
      schedule()
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor
      if (!editor || event.document === editor.document) {
        // 内容变了，之前“忽略”的判断不再适用。
        dismissedSignature = ''
        schedule()
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('wenmai')) {
        dismissedSignature = ''
        clear()
        schedule()
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      CODE_ACTION_LANGUAGES,
      { provideCodeActions },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  ]

  return {
    refresh,
    accept,
    dismiss,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      clear()
      try {
        strikeType.dispose()
      } catch (_) {}
      for (const item of disposables) {
        try {
          item.dispose()
        } catch (_) {}
      }
    },
    _pending: () => pending
  }
}

module.exports = { createLocalFixPreview }
