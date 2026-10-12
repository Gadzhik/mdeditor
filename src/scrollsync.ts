import { EditorView } from '@codemirror/view'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

interface Span {
  start: number
  end: number
  top: number
  bottom: number
}

/** Ленивое чтение геометрии блока: в бинарном поиске трогаем O(log n) элементов, а не все. */
function span(el: Element, base: number): Span {
  const h = el as HTMLElement
  const top = base + h.offsetTop
  return { start: +h.dataset.line!, end: +h.dataset.end!, top, bottom: top + h.offsetHeight }
}

/**
 * Двусторонний синхронный скролл. Связь строк исходника и блоков превью
 * берётся из data-line/data-end, которые проставляет Preview.
 */
export class ScrollSync {
  private ignoreEditor = false
  private ignorePreview = false

  constructor(
    private view: EditorView,
    private pane: HTMLElement,
    private preview: HTMLElement,
  ) {
    pane.addEventListener('scroll', () => this.onPreviewScroll(), { passive: true })
  }

  /** Отступ документа CodeMirror от верха scroll-контейнера (padding контента). */
  private docOffset(): number {
    const s = this.view.scrollDOM
    return this.view.documentTop - s.getBoundingClientRect().top + s.scrollTop
  }

  onEditorScroll() {
    if (this.ignoreEditor) {
      this.ignoreEditor = false
      return
    }
    this.syncFromEditor()
  }

  syncFromEditor() {
    if (!this.pane.offsetParent || !this.view.dom.offsetParent) return
    const s = this.view.scrollDOM
    let target: number
    if (s.scrollTop <= 0) target = 0
    else if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) target = this.pane.scrollHeight
    else target = this.lineToY(this.editorTopLine())
    this.setPane(target)
  }

  /** Строка исходника (дробная, с 0) у верхнего края редактора. */
  editorTopLine(): number {
    const h = this.view.scrollDOM.scrollTop - this.docOffset()
    const blk = this.view.lineBlockAtHeight(Math.max(0, h))
    return this.view.state.doc.lineAt(blk.from).number - 1 + clamp01((h - blk.top) / (blk.height || 1))
  }

  /** Строка исходника у верхнего края превью. */
  previewTopLine(): number {
    return this.yToLine(this.pane.scrollTop)
  }

  /** Прокрутить редактор так, чтобы строка line оказалась у верхнего края. */
  scrollEditorToLine(line: number) {
    if (!this.view.dom.offsetParent) return
    const doc = this.view.state.doc
    const n = Math.min(Math.floor(Math.max(line, 0)) + 1, doc.lines)
    if (Math.floor(this.editorTopLine()) === n - 1) return
    // CodeMirror сам доизмеряет строки по пути, ручной scrollTop промахивается на оценочных высотах
    this.ignoreEditor = true
    this.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(n).from, { y: 'start', yMargin: 0 }) })
  }

  /**
   * Блоки превью вне экрана имеют оценочную высоту (content-visibility), и после
   * прокрутки браузер отрисовывает ставшие видимыми блоки с настоящей высотой,
   * сдвигая раскладку. Довыравниваем, пока не сойдётся. Проверять нужно после
   * отрисовки кадра (rAF + setTimeout), а не в начале кадра, иначе видна ещё старая раскладка.
   */
  scrollPreviewToLine(line: number, tries = 8) {
    if (!this.pane.offsetParent) return
    this.setPane(line <= 0 ? 0 : this.lineToY(line))
    if (line > 0 && tries > 1) {
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (Math.abs(this.previewTopLine() - line) > 0.5) this.scrollPreviewToLine(line, tries - 1)
        }),
      )
    }
  }

  private editorLineY(line: number): number {
    const doc = this.view.state.doc
    const n = Math.min(Math.floor(line) + 1, doc.lines)
    const blk = this.view.lineBlockAt(doc.line(n).from)
    return blk.top + (line - Math.floor(line)) * blk.height + this.docOffset()
  }

  private lineToY(line: number): number {
    const els = this.preview.children
    if (!els.length) return 0
    // последний блок, начинающийся не позже line
    let lo = 0, hi = els.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (+(els[mid] as HTMLElement).dataset.line! <= line) lo = mid
      else hi = mid - 1
    }
    const base = this.preview.offsetTop
    const a = span(els[lo], base)
    if (line < a.start) return 0
    if (line < a.end) return a.top + ((line - a.start) / (a.end - a.start)) * (a.bottom - a.top)
    if (lo + 1 >= els.length) return a.bottom
    const b = span(els[lo + 1], base)
    return a.bottom + clamp01((line - a.end) / (b.start - a.end || 1)) * (b.top - a.bottom)
  }

  private onPreviewScroll() {
    if (this.ignorePreview) {
      this.ignorePreview = false
      return
    }
    if (!this.view.dom.offsetParent) return
    const p = this.pane
    const s = this.view.scrollDOM
    let target: number
    if (p.scrollTop <= 0) target = 0
    else if (p.scrollTop + p.clientHeight >= p.scrollHeight - 2) target = s.scrollHeight
    else target = this.editorLineY(this.yToLine(p.scrollTop))
    if (Math.abs(s.scrollTop - target) > 1) {
      this.ignoreEditor = true
      s.scrollTop = target
    }
  }

  private yToLine(y: number): number {
    const els = this.preview.children
    if (!els.length) return 0
    const base = this.preview.offsetTop
    let lo = 0, hi = els.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (base + (els[mid] as HTMLElement).offsetTop <= y) lo = mid
      else hi = mid - 1
    }
    const a = span(els[lo], base)
    if (y < a.top) return 0
    if (y < a.bottom) return a.start + ((y - a.top) / (a.bottom - a.top || 1)) * (a.end - a.start)
    if (lo + 1 >= els.length) return a.end
    const b = span(els[lo + 1], base)
    return a.end + clamp01((y - a.bottom) / (b.top - a.bottom || 1)) * (b.start - a.end)
  }

  private setPane(target: number) {
    const max = this.pane.scrollHeight - this.pane.clientHeight
    target = Math.max(0, Math.min(target, max))
    if (Math.abs(this.pane.scrollTop - target) > 1) {
      this.ignorePreview = true
      this.pane.scrollTop = target
    }
  }
}
