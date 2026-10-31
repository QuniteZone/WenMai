'use strict'

const http = require('http')
const https = require('https')
const { URL } = require('url')

/*
 * 网络层。两个关键性能设计：
 *
 * 1. keep-alive：复用 TLS 连接，省掉每次请求的握手开销。
 * 2. 流式 + 提前结束：模型写完第一句就可以停止生成，不必等完整响应。
 *    对写作续写来说，这能把等待时间从"整段生成"降到"首字 + 一句"。
 */

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  keepAliveMsecs: 30000
})

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 8,
  keepAliveMsecs: 30000
})

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

/**
 * 兼容用户把 baseUrl 直接写成完整补全地址的情况，避免拼出
 * /completions/completions 这种必然 404 的路径。
 */
function completionUrl(baseUrl) {
  const base = trimSlash(baseUrl)
  return /\/completions$/.test(base) ? base : `${base}/completions`
}

/**
 * chatUrl 只填了域名（https://api.deepseek.com）时补全标准路径；
 * 已经带路径的（代理、OpenAI 兼容网关）保持原样。
 */
function chatEndpoint(chatUrl) {
  const raw = trimSlash(chatUrl)
  if (!raw) return raw
  try {
    const parsed = new URL(raw)
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${raw}/chat/completions`
    }
  } catch (_) {}
  return raw
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { cancelled: true })
}

function extractError(raw) {
  const body = String(raw || '').slice(0, 4000)
  try {
    const json = JSON.parse(body)
    if (json.error) {
      if (typeof json.error === 'string') return json.error
      return json.error.message || json.error.type || body.slice(0, 300)
    }
    return body.slice(0, 300)
  } catch (_) {
    return body.slice(0, 300)
  }
}

function pickText(choice) {
  if (!choice) return ''
  if (typeof choice.text === 'string') return choice.text
  if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content
  return ''
}

/**
 * @param {string} urlString
 * @param {object} body
 * @param {object} options
 * @param {string} options.apiKey
 * @param {boolean} [options.stream]
 * @param {number} [options.timeoutMs]
 * @param {{onAbort?: Function}} [options.signal]
 * @param {(text: string) => boolean} [options.shouldStop]
 * @param {(ms: number) => void} [options.onFirstToken]
 */
function postJson(urlString, body, options) {
  const opts = options || {}
  const timeoutMs = opts.timeoutMs || 12000
  const stream = Boolean(opts.stream)
  const started = Date.now()
  const payload = JSON.stringify(body)

  // 取消发生在进入网络层之前，直接短路。
  if (opts.signal && opts.signal.cancelled) return Promise.reject(cancelledError())

  let parsed
  try {
    parsed = new URL(urlString)
  } catch (_) {
    return Promise.reject(new Error(`无效的 URL：${urlString}`))
  }

  const lib = parsed.protocol === 'http:' ? http : https
  const agent = parsed.protocol === 'http:' ? httpAgent : httpsAgent
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': 'wenmai-vscode/1.0'
  }
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

  return new Promise((resolve, reject) => {
    let settled = false
    let destroyed = false
    let timedOut = false
    let timer = null
    let text = ''
    let usage = null
    let raw = ''
    let firstTokenMs = 0
    let earlyStop = false
    let finishReason = ''

    const finishOk = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        text,
        usage,
        firstTokenMs,
        totalMs: Date.now() - started,
        earlyStop,
        finishReason
      })
    }

    const finishErr = (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(err)
    }

    const destroy = () => {
      destroyed = true
      try {
        req.destroy()
      } catch (_) {}
    }

    let req
    try {
      req = lib.request(parsed, { method: 'POST', headers, agent }, (res) => {
        const status = res.statusCode || 0

        // 连接中途被对端掐断时，不一定会触发 'end'；不处理会一直等到超时。
        res.on('aborted', () => {
          if (!settled) finishErr(new Error('响应被中断'))
        })

        if (status < 200 || status >= 300) {
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            if (raw.length < 4000) raw += chunk
          })
          res.on('end', () => {
            finishErr(new Error(`HTTP ${status}: ${extractError(raw)}`))
          })
          res.on('error', finishErr)
          return
        }

        res.setEncoding('utf8')

        if (!stream) {
          res.on('data', (chunk) => {
            if (raw.length < 2 * 1024 * 1024) raw += chunk
          })
          res.on('end', () => {
            try {
              const json = JSON.parse(raw)
              const choice = json.choices && json.choices[0]
              text = pickText(choice)
              usage = json.usage || null
              finishReason = (choice && choice.finish_reason) || ''
              finishOk()
            } catch (err) {
              finishErr(new Error(`响应解析失败：${err.message}`))
            }
          })
          res.on('error', finishErr)
          return
        }

        let buffer = ''
        res.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, '').trim()
            buffer = buffer.slice(index + 1)

            if (!line || line.startsWith(':')) continue
            if (!line.startsWith('data:')) continue

            const data = line.slice(5).trim()
            if (data === '[DONE]') {
              finishOk()
              return
            }

            let json
            try {
              json = JSON.parse(data)
            } catch (_) {
              continue
            }

            if (json.usage) usage = json.usage

            const choice = json.choices && json.choices[0]
            if (choice && choice.finish_reason) finishReason = choice.finish_reason
            const delta = pickText(choice)
            if (!delta) continue

            if (!firstTokenMs) {
              firstTokenMs = Date.now() - started
              if (opts.onFirstToken) {
                try {
                  opts.onFirstToken(firstTokenMs)
                } catch (_) {}
              }
            }

            text += delta

            if (opts.shouldStop) {
              let stop = false
              try {
                stop = Boolean(opts.shouldStop(text))
              } catch (_) {}
              if (stop) {
                earlyStop = true
                finishOk()
                destroy()
                return
              }
            }
          }
        })
        res.on('end', finishOk)
        res.on('error', finishErr)
      })
    } catch (err) {
      finishErr(err)
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      destroy()
      finishErr(new Error(`请求超时（${timeoutMs}ms）`))
    }, timeoutMs)

    if (opts.signal) {
      opts.signal.onAbort = () => {
        destroy()
        finishErr(cancelledError())
      }
      if (opts.signal.cancelled) {
        opts.signal.onAbort()
        return
      }
    }

    req.on('error', (err) => {
      if (settled) return
      if (timedOut) return
      if (destroyed) {
        finishErr(cancelledError())
        return
      }
      finishErr(err)
    })

    req.on('close', () => {
      if (settled || destroyed || timedOut) return
      finishErr(new Error('连接意外关闭'))
    })

    req.write(payload)
    req.end()
  })
}

function callCompletion(options) {
  const url = completionUrl(options.baseUrl)
  const stream = Boolean(options.stream && options.shouldStop)
  const body = {
    model: options.model,
    prompt: options.prompt,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    stream
  }
  if (options.suffix) body.suffix = options.suffix

  return postJson(url, body, {
    apiKey: options.apiKey,
    stream,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    shouldStop: options.shouldStop,
    onFirstToken: options.onFirstToken
  })
}

/**
 * 空响应的重试预算。
 *
 * deepseek-flash 这类模型会先产生隐藏推理 token。max_tokens 偏小时，
 * 推理把预算吃光，正文一个 token 都不剩，流式和非流式都会返回空。
 * 重试时把预算放大，让推理结束后还有空间输出正文。
 */
function retryTokenBudget(maxTokens) {
  const base = Number(maxTokens) || 96
  return Math.min(1024, Math.max(400, Math.round(base * 4)))
}

/** 空响应日志里带上决策信息，方便判断是预算、限流还是端点问题。 */
function describeEmptyResult(result) {
  if (!result) return '无响应'
  const usage = result.usage || {}
  const details = usage.completion_tokens_details || {}
  const parts = []
  if (result.finishReason) parts.push(`finish_reason=${result.finishReason}`)
  if (typeof usage.completion_tokens === 'number') {
    parts.push(`completion_tokens=${usage.completion_tokens}`)
  }
  if (typeof details.reasoning_tokens === 'number') {
    parts.push(`reasoning_tokens=${details.reasoning_tokens}`)
  }
  parts.push(`收到 ${String(result.text || '').length} 字`)
  return parts.join('，')
}

function callChat(options) {
  const stream = Boolean(options.stream)
  const body = {
    model: options.model,
    messages: options.messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    stream
  }

  return postJson(chatEndpoint(options.chatUrl), body, {
    apiKey: options.apiKey,
    stream,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    // 行内续写用 Chat 兜底时，也能写完一句就提前结束。
    shouldStop: options.shouldStop,
    onFirstToken: options.onFirstToken
  })
}

module.exports = {
  postJson,
  callCompletion,
  callChat,
  completionUrl,
  chatEndpoint,
  extractError,
  retryTokenBudget,
  describeEmptyResult
}
