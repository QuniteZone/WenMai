'use strict'

const vscode = require('vscode')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 100 }

let channel = null
let threshold = LEVELS.info

function init(context, name) {
  if (channel) return channel
  channel = vscode.window.createOutputChannel(name || '文脉 Wenmai', { log: true })
  context.subscriptions.push(channel)
  return channel
}

function setLevel(level) {
  threshold = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level]
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (_) {
    return String(value)
  }
}

function write(level, args) {
  if (LEVELS[level] < threshold) return
  const line = `[${stamp()}] [${level.toUpperCase()}] ${args.map(stringify).join(' ')}`
  if (channel) {
    if (level === 'error') channel.error(line)
    else if (level === 'warn') channel.warn(line)
    else if (level === 'debug') channel.debug(line)
    else channel.info(line)
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function show() {
  if (channel) channel.show(true)
}

function getChannel() {
  return channel
}

module.exports = {
  init,
  setLevel,
  show,
  getChannel,
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args)
}
