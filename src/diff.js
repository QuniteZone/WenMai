'use strict'

/*
 * 行内最小差异。
 *
 * 本地修正经常只改一个标点或补一个空格。如果直接整行替换：
 * - 预览会把整行画上删除线，视觉上像“删掉重写”；
 * - WorkspaceEdit 也会替换整行，撤销粒度变大。
 *
 * 这里用一次从左到右的贪心对齐，把差异压成尽量小的连续片段。
 * 规则修正的改动形态很固定（单字符替换、插入空格、删除重复标点），
 * 这种对齐比通用 diff 更直接，也足够快。遇到环境名这类多字符替换时，
 * 会向后找一个足够长的公共片段重新同步，避免把后面的整段正文卷进来。
 */

const LOOKAHEAD = 24

function pushHunk(hunks, start, end, replacement) {
  if (start === end && !replacement) return

  const last = hunks[hunks.length - 1]
  if (last && last.end === start) {
    last.end = end
    last.replacement += replacement
    return
  }

  hunks.push({ start, end, replacement })
}

function commonRun(before, after, i, j) {
  let length = 0
  while (
    i + length < before.length &&
    j + length < after.length &&
    before[i + length] === after[j + length]
  ) {
    length++
  }
  return length
}

/**
 * 找一个尽量长、尽量近的重新同步点。
 * 至少匹配两个字符，或者正好同时到达两段文本的末尾。
 */
function findResync(before, after, i, j) {
  const maxK = Math.min(LOOKAHEAD, before.length - i)
  const maxL = Math.min(LOOKAHEAD, after.length - j)
  let best = null

  for (let k = 0; k <= maxK; k++) {
    for (let l = 0; l <= maxL; l++) {
      if (k === 0 && l === 0) continue

      const atOldEnd = i + k === before.length
      const atNewEnd = j + l === after.length
      const run = atOldEnd || atNewEnd ? 0 : commonRun(before, after, i + k, j + l)
      const anchored =
        run >= 2 ||
        (run >= 1 && i + k + run === before.length && j + l + run === after.length) ||
        (atOldEnd && atNewEnd)
      if (!anchored) continue

      if (
        !best ||
        run > best.run ||
        (run === best.run &&
          (k + l < best.k + best.l ||
            (k + l === best.k + best.l && k < best.k)))
      ) {
        best = { k, l, run }
      }
    }
  }

  return best
}

function diffSegments(oldText, newText) {
  const before = String(oldText == null ? '' : oldText)
  const after = String(newText == null ? '' : newText)
  const hunks = []
  let i = 0
  let j = 0

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i++
      j++
      continue
    }

    // 旧文本多出一个字符：删除。
    if (i + 1 < before.length && before[i + 1] === after[j]) {
      pushHunk(hunks, i, i + 1, '')
      i++
      continue
    }

    // 新文本多出一个字符：插入。
    if (j + 1 < after.length && before[i] === after[j + 1]) {
      pushHunk(hunks, i, i, after[j])
      j++
      continue
    }

    // 多字符替换：先找重新同步点，避免把后面的相同内容整段替换。
    const resync = findResync(before, after, i, j)
    if (resync) {
      pushHunk(
        hunks,
        i,
        i + resync.k,
        after.slice(j, j + resync.l)
      )
      i += resync.k
      j += resync.l
      continue
    }

    // 其余情况按单字符替换处理；连续替换会被 pushHunk 合并。
    pushHunk(hunks, i, i + 1, after[j])
    i++
    j++
  }

  if (i < before.length) pushHunk(hunks, i, before.length, '')
  if (j < after.length) pushHunk(hunks, i, i, after.slice(j))

  return hunks
}

module.exports = { diffSegments }
