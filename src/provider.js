'use strict'

const vscode = require('vscode')

const log = require('./logger')
const { readConfig, isLanguageAllowed } = require('./config')
const { buildContext, buildPrompt } = require('./context')
const { detectLocalFix } = require('./fix')
const { resolveGenre, buildGuidelineLine } = require('./guidelines')
const { finalize, isLowQuality, shouldStop, stripInstructionEcho } = require('./postprocess')
const {
  callCompletion,
  callChat,
  retryTokenBudget,
  describeEmptyResult
} = require('./client')
const { hashKey } = require('./cache')

const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs'])

function delay(ms, token) {
  if (token.isCancellationRequested) return Promise.resolve(false)
  if (!ms || ms <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let done = false
    let subscription = null
    const timer = setTimeout(() => finish(true), ms)

    function finish(value) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (subscription) subscription.dispose()
      resolve(value)
    }

    subscription = token.onCancellationRequested(() => finish(false))
  })
}

function makeItem(text, position) {
  const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position))
  return item
}

function isStreamUnsupported(error) {
  if (!error || !error.message) return false
  return /HTTP (400|404|422)/.test(error.message) || /stream/i.test(error.message)
}

/**
 * FIM 端点偶尔会稳定返回空（finish_reason=stop、completion_tokens=0），
 * 与 token 预算无关。这时用 Chat 端点兜底，保证写作时总能拿到建议。
 */
function buildChatMessages(info, cfg, genre) {
  const guideline = cfg.useGuidelines
    ? buildGuidelineLine({
        genre,
        maxSentences: cfg.maxSentences,
        maxChars: cfg.maxChars,
        custom: cfg.writingRules
      })
    : ''
  const system =
    (guideline ? `${guideline}\n` : '') +
    '你是中文写作续写引擎。只输出紧接光标处的正文，不解释、不加标题、不使用代码块，也不要重复上文。'
  const user =
    `【上文】\n${info.pre}\n\n` +
    (cfg.useSuffix && info.suffix ? `【光标后原文】\n${info.suffix}\n\n` : '') +
    '【续写位置】\n请紧接光标处续写 1~2 句，只输出正文。'
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

function createProvider(runtime) {
  return {
    async provideInlineCompletionItems(document, position, context, token) {
      runtime.stats.requested++

      const cfg = readConfig()

      if (!cfg.enabled) {
        runtime.stats.skipped++
        return undefined
      }
      if (!isLanguageAllowed(document.languageId, cfg.languages)) {
        runtime.stats.skipped++
        return undefined
      }
      if (!SUPPORTED_SCHEMES.has(document.uri.scheme)) {
        runtime.stats.skipped++
        return undefined
      }
      if (context.selectedCompletionInfo) {
        return undefined
      }
      if (token.isCancellationRequested) {
        runtime.stats.cancelled++
        return undefined
      }

      // 防抖：等用户真正停下来再请求。每个按键都会触发 provider，
      // 而 VS Code 会取消上一次调用，所以这里只是在"最后一次"上继续。
      const idle = await delay(cfg.debounceMs, token)
      if (!idle || token.isCancellationRequested) {
        runtime.stats.cancelled++
        return undefined
      }

      let info
      try {
        const text = document.getText()
        const offset = document.offsetAt(position)

        // L1：本地规则修正。
        // VS Code 1.144 的行内建议可见性判定会过滤掉“光标前插入字符”的替换，
        // 标准的 InlineCompletionItem 无法显示这类修正；预览由
        // src/localFixPreview.js 的装饰器负责。这里只负责在命中的行上
        // 抑制 AI 续写，避免两个建议互相竞争，也不发起任何请求。
        if (cfg.autoFix) {
          const fixed = detectLocalFix({
            text,
            offset,
            languageId: document.languageId,
            cfg
          })
          if (fixed) {
            log.debug(
              `本地修正候选（由行内预览呈现）| ${fixed.changes.join('、')} | ${fixed.oldText.length} 字`
            )
            return undefined
          }
        }

        info = buildContext({
          text,
          offset,
          languageId: document.languageId,
          cfg
        })
      } catch (error) {
        log.debug('构建上下文失败', error)
        return undefined
      }

      if (info.skip) {
        runtime.stats.skipped++
        log.debug(`跳过：${info.skip}`)
        return undefined
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

      // 行内续写是“往光标前插入”，发给 FIM 的请求永远不带 suffix：
      // FIM 的 suffix 是“填空”语义，光标后已是完整句子时模型会返回
      // finish_reason=stop、0 token 的空结果（实测 DeepSeek 稳定复现）。
      // 光标后的文字只在 Chat 兜底时作为参考，由 useSuffix 控制。
      const suffix = cfg.useSuffix ? info.suffix : ''

      const cacheKey = hashKey([
        cfg.model,
        cfg.chatModel,
        cfg.chatUrl,
        cfg.temperature,
        cfg.maxTokens,
        cfg.maxSentences,
        cfg.maxChars,
        suffix,
        prompt
      ])

      const cached = runtime.cache.get(cacheKey)
      if (cached) {
        runtime.stats.cacheHits++
        runtime.stats.shown++
        log.debug(`缓存命中（${cached.length} 字）`)
        if (runtime.notify) runtime.notify()
        return [makeItem(cached, position)]
      }

      const now = Date.now()
      if (cfg.minIntervalMs > 0 && now - runtime.lastRequestAt < cfg.minIntervalMs) {
        runtime.stats.throttled++
        return undefined
      }
      runtime.lastRequestAt = now

      let apiKey = null
      try {
        apiKey = runtime.getApiKey ? await runtime.getApiKey() : null
      } catch (error) {
        log.error(`读取 API Key 失败：${(error && error.message) || error}`)
      }
      if (!apiKey) {
        if (runtime.onMissingKey) runtime.onMissingKey()
        return undefined
      }
      if (token.isCancellationRequested) {
        runtime.stats.cancelled++
        return undefined
      }

      const signal = { cancelled: false }
      const cancellation = token.onCancellationRequested(() => {
        signal.cancelled = true
        if (signal.onAbort) signal.onAbort()
      })

      if (runtime.setGenerating) runtime.setGenerating(true)
      const requestStarted = Date.now()

      try {
        const request = {
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          prompt,
          maxTokens: cfg.maxTokens,
          temperature: cfg.temperature,
          timeoutMs: cfg.timeoutMs,
          stream: cfg.stream,
          // 先去掉可能被复述的准则，避免准则里的分号被误判成句末而提前停止。
          shouldStop: (text) =>
            shouldStop(stripInstructionEcho(text), cfg.maxSentences, cfg.maxChars),
          signal,
          apiKey
        }

        let result
        try {
          result = await callCompletion(request)
        } catch (error) {
          if (error.cancelled) return undefined
          if (cfg.stream && isStreamUnsupported(error)) {
            log.warn(`流式请求失败，回退非流式：${error.message}`)
            result = await callCompletion(Object.assign({}, request, { stream: false }))
          } else {
            throw error
          }
        }

        // 有些兼容端点会忽略 stream，直接返回一整段 JSON；此时流式解析结果为空。
        // 推理型模型也可能把 max_tokens 全用在隐藏推理上，正文为空。
        // 这时用更大的预算做一次非流式重试：推理结束后仍有空间写正文。
        if (cfg.stream && !result.text && !token.isCancellationRequested) {
          if (result.finishReason === 'stop') {
            // 端点正常结束却一个 token 都没写，说明不是预算问题，
            // 放大预算重试只会再等一轮；交给下面的 suffix 重试/Chat 兜底。
            log.warn(
              `流式响应为空（${describeEmptyResult(result)}），` +
                'finish_reason=stop，跳过预算重试'
            )
          } else {
            const retryTokens = retryTokenBudget(cfg.maxTokens)
            log.warn(
              `流式响应为空（${describeEmptyResult(result)}），` +
                `以 ${retryTokens} token 预算重试非流式`
            )
            result = await callCompletion(
              Object.assign({}, request, { stream: false, maxTokens: retryTokens })
            )
            if (!result.text) {
              log.warn(`非流式重试仍为空（${describeEmptyResult(result)}）`)
            }
          }
        }

        // FIM 为空（没有正文，或 finish_reason=stop/0 token），改用 Chat 端点兜底。
        // 行内续写请求本身不带 suffix，空结果通常意味着模型判断“无需插入”
        // 或预算被隐藏推理吃光；Chat 端点稳定可用。
        if (!result.text && !token.isCancellationRequested && cfg.chatUrl) {
          log.warn('FIM 连续返回空，改用 Chat 端点兜底')
          try {
            result = await callChat({
              chatUrl: cfg.chatUrl,
              model: cfg.chatModel,
              messages: buildChatMessages(info, cfg, genre),
              maxTokens: Math.max(cfg.maxTokens * 8, 800),
              temperature: cfg.temperature,
              timeoutMs: cfg.timeoutMs,
              stream: cfg.stream,
              shouldStop: (text) =>
                shouldStop(stripInstructionEcho(text), cfg.maxSentences, cfg.maxChars),
              signal,
              apiKey
            })
          } catch (error) {
            if (error.cancelled) return undefined
            log.warn(`Chat 兜底失败：${(error && error.message) || error}`)
            if (runtime.onRequestError) {
              try {
                runtime.onRequestError(error)
              } catch (_) {}
            }
          }
          if (result && !result.text) {
            log.warn(`Chat 兜底仍为空（${describeEmptyResult(result)}）`)
          }
        }

        if (token.isCancellationRequested) {
          runtime.stats.cancelled++
          return undefined
        }

        const text = finalize(
          result.text,
          { pre: info.pre, suffix, prevChar: info.prevChar },
          cfg
        )

        // 原始响应有内容、后处理后却为空，说明模型复述了上文或后文，
        // 被去重逻辑整段丢弃。把这件事写进日志，避免看起来像“没有触发”。
        if (!text && result.text) {
          log.warn(
            `补全结果被去重逻辑过滤（原始 ${String(result.text).length} 字）`
          )
        }

        if (isLowQuality(text, { pre: info.pre, suffix })) {
          runtime.stats.rejected++
          log.debug(`丢弃低质量结果：${JSON.stringify(String(result.text || '').slice(0, 80))}`)
          return undefined
        }

        runtime.cache.set(cacheKey, text)
        runtime.stats.shown++
        if (runtime.recordLatency) {
          runtime.recordLatency({
            firstTokenMs: result.firstTokenMs,
            totalMs: result.totalMs || Date.now() - requestStarted,
            chars: text.length,
            earlyStop: result.earlyStop
          })
        }

        log.info(
          `建议 ${text.length} 字 | 首字 ${result.firstTokenMs || '?'}ms ` +
            `总 ${result.totalMs || '?'}ms${result.earlyStop ? '（提前结束）' : ''} | ${genre}`
        )
        log.debug(`内容=${JSON.stringify(text.slice(0, 120))}`)

        return [makeItem(text, position)]
      } catch (error) {
        if (!error.cancelled) {
          runtime.stats.failed++
          log.error(`补全失败：${(error && error.message) || error}`)
          // Key 失效、余额不足、限流这类错误值得让用户知道一次，
          // 否则表现只是“幽灵文本不出现”。
          if (runtime.onRequestError) {
            try {
              runtime.onRequestError(error)
            } catch (_) {}
          }
        }
        return undefined
      } finally {
        cancellation.dispose()
        if (runtime.setGenerating) runtime.setGenerating(false)
        if (runtime.notify) runtime.notify()
      }
    }
  }
}

module.exports = { createProvider, delay }
