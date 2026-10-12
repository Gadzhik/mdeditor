// Привязка заметок к тексту markdown. Фрагмент хранится цитатой с контекстом,
// а ищется по «плоскому» тексту без разметки, поэтому одна и та же цитата
// находится и в исходнике (**жирный** текст), и в превью (жирный текст).
import type { MdAnchor } from './notes'

const MARKUP = new Set(['*', '_', '~', '`', '[', ']'])
// маркеры блоков в начале строки: заголовки, цитаты, пункты списков и задач
const BLOCK_MARK = /^[ \t]{0,3}(?:#{1,6}[ \t]+|(?:>[ \t]?)+|(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/

export interface Plain {
  text: string
  map: number[] // map[i] — индекс i-го символа text в исходной строке
}

/** Текст без markdown-разметки со схлопнутыми пробелами и картой позиций. */
export function plain(src: string): Plain {
  const out: string[] = []
  const map: number[] = []
  let space = true
  let lineStart = true
  for (let i = 0; i < src.length; ) {
    if (lineStart) {
      lineStart = false
      const m = BLOCK_MARK.exec(src.slice(i, i + 48))
      if (m && m[0].length) {
        i += m[0].length
        continue
      }
    }
    const c = src[i]
    if (c === ']' && src[i + 1] === '(') {
      // [текст](адрес) → текст
      const close = src.indexOf(')', i + 2)
      if (close !== -1 && close - i < 2048) {
        i = close + 1
        continue
      }
    }
    if (MARKUP.has(c) || (c === '!' && src[i + 1] === '[')) {
      i++
      continue
    }
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === ' ') {
      if (c === '\n') lineStart = true
      if (!space) {
        out.push(' ')
        map.push(i)
        space = true
      }
      i++
      continue
    }
    out.push(c)
    map.push(i)
    space = false
    i++
  }
  return { text: out.join(''), map }
}

const key = (s: string) => plain(s).text.trim()

/**
 * Лучшее вхождение цитаты: совпадение контекста до и после важнее,
 * при равенстве выигрывает ближайшее к строке-подсказке.
 */
function findQuote(hay: string, a: MdAnchor, lineOf: (i: number) => number): { start: number; end: number } | null {
  const q = key(a.quote)
  if (!q) return null
  const pre = key(a.prefix).slice(-24)
  const suf = key(a.suffix).slice(0, 24)
  let best: { start: number; end: number } | null = null
  let bestScore = -Infinity
  let guard = 0
  for (let i = hay.indexOf(q); i !== -1 && guard < 1000; i = hay.indexOf(q, i + 1), guard++) {
    let score = 0
    if (pre && hay.slice(Math.max(0, i - pre.length - 2), i).trimEnd().endsWith(pre)) score += 2
    if (suf && hay.slice(i + q.length, i + q.length + suf.length + 2).trimStart().startsWith(suf)) score += 2
    score -= Math.abs(lineOf(i) - a.line) / 1e6
    if (score > bestScore) {
      bestScore = score
      best = { start: i, end: i + q.length }
    }
  }
  return best
}

function lastLE(arr: number[], v: number): number {
  let lo = 0, hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (arr[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Найти фрагменты в исходнике. null — цитата не найдена (текст изменили). */
export function resolveInSource(src: string, anchors: MdAnchor[]): ({ from: number; to: number } | null)[] {
  if (!anchors.length) return []
  const p = plain(src)
  const lineStarts = [0]
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const lineOf = (i: number) => lastLE(lineStarts, p.map[i])
  return anchors.map((a) => {
    const m = findQuote(p.text, a, lineOf)
    return m ? { from: p.map[m.start], to: p.map[m.end - 1] + 1 } : null
  })
}

/** Текст превью с привязкой к текстовым узлам: по нему ищутся диапазоны для подсветки. */
export function previewIndex(root: HTMLElement) {
  const nodes: Text[] = []
  const starts: number[] = []
  const blockAt: number[] = []
  const blockLine: number[] = []
  let concat = ''
  for (const b of root.children as HTMLCollectionOf<HTMLElement>) {
    blockAt.push(concat.length)
    blockLine.push(+(b.dataset.line ?? 0))
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
    for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
      nodes.push(t)
      starts.push(concat.length)
      concat += t.data
    }
    concat += '\n'
  }
  const p = plain(concat)
  const point = (ci: number) => {
    const k = lastLE(starts, ci)
    return { node: nodes[k], offset: ci - starts[k] }
  }
  return {
    find(a: MdAnchor): Range | null {
      if (!nodes.length) return null
      const m = findQuote(p.text, a, (i) => blockLine[lastLE(blockAt, p.map[i])])
      if (!m) return null
      const s = point(p.map[m.start])
      const e = point(p.map[m.end - 1])
      const r = document.createRange()
      r.setStart(s.node, s.offset)
      r.setEnd(e.node, e.offset + 1)
      return r
    },
  }
}

/** Привязка для выделения в превью. */
export function previewSelection(root: HTMLElement): { anchor: MdAnchor; rect: DOMRect } | null {
  const sel = getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const quote = range.toString().replace(/\s+/g, ' ').trim()
  if (!quote) return null
  const blockOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest<HTMLElement>('#preview > .b') ?? null
  const startBlock = blockOf(range.startContainer)
  const endBlock = blockOf(range.endContainer)
  const before = document.createRange()
  before.setStart(startBlock ?? root, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const after = document.createRange()
  after.setStart(range.endContainer, range.endOffset)
  const tail = endBlock ?? root
  after.setEnd(tail, tail.childNodes.length)
  return {
    anchor: {
      kind: 'md',
      line: +(startBlock?.dataset.line ?? 0),
      quote,
      prefix: before.toString().slice(-60),
      suffix: after.toString().slice(0, 60),
    },
    rect: range.getBoundingClientRect(),
  }
}

/** Точка документа под курсором мыши (для клика по подсветке). */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  const p = d.caretPositionFromPoint?.(x, y)
  if (p) return { node: p.offsetNode, offset: p.offset }
  const r = document.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}
