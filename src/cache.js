'use strict'

const crypto = require('crypto')

class LruCache {
  constructor(limit) {
    this.limit = Math.max(0, Number(limit) || 0)
    this.map = new Map()
  }

  setLimit(limit) {
    this.limit = Math.max(0, Number(limit) || 0)
    this.trim()
  }

  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key, value) {
    if (this.limit <= 0) return
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    this.trim()
  }

  trim() {
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }

  clear() {
    this.map.clear()
  }

  get size() {
    return this.map.size
  }
}

function hashKey(parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex')
}

module.exports = { LruCache, hashKey }
