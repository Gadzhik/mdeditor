// Просмотр PDF на pdf.js. Модуль грузится лениво, при первом открытии PDF.
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { kvGet, kvSet } from './storage'
import type { PdfAnchor, PdfRect } from './notes'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
// компоненты просмотрщика берут библиотеку из глобальной переменной,
// поэтому импортируются только после её установки
;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib
const { EventBus, PDFLinkService, PDFFindController, PDFViewer, FindState } = await import('pdfjs-dist/web/pdf_viewer.mjs')

// cmaps, шрифты и wasm копируются в сборку плагином из vite.config.ts
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`

export interface PdfUi {
  container: HTMLDivElement
  viewer: HTMLDivElement
  outline: HTMLElement
  thumbs: HTMLElement
  page: HTMLInputElement
  pageCount: HTMLElement
  scale: HTMLSelectElement
  find: HTMLInputElement
  findCount: HTMLElement
}

interface SavedPos {
  page: number
  frac: number
  scale: string
}

interface OutlineItem {
  title: string
  dest: string | unknown[] | null
  url: string | null
  items: OutlineItem[]
}

const THUMB_WIDTH = 120 // CSS-пиксели

// последний масштаб, выставленный пользователем: с ним открываются PDF без сохранённой позиции
const lastScale = {
  get(): string | null {
    try {
      return localStorage.getItem('pdfScale')
    } catch {
      return null
    }
  },
  set(v: string) {
    try {
      localStorage.setItem('pdfScale', v)
    } catch {}
  },
}

export class PdfReader {
  private bus = new EventBus()
  private link = new PDFLinkService({ eventBus: this.bus })
  private finder = new PDFFindController({ eventBus: this.bus, linkService: this.link })
  private viewer: InstanceType<typeof PDFViewer>
  private doc: PDFDocumentProxy | null = null
  private task: PDFDocumentLoadingTask | null = null
  private posKey = ''
  private restore: SavedPos | null = null
  private saveTimer = 0
  private applyingSaved = false // масштаб ставит программа, а не пользователь
  hasOutline = false
  // миниатюры рисуются по одной за раз и только видимые в панели
  private thumbObserver: IntersectionObserver
  private thumbQueue: number[] = []
  private thumbBusy = false
  private thumbGen = 0
  private activeThumb: HTMLElement | null = null
  // заметки: прямоугольники подсветки по страницам
  private noteRects = new Map<number, { id: string; title: string; r: PdfRect }[]>()
  private flashId: string | null = null
  onNoteClick: ((id: string, near: DOMRect) => void) | null = null

  constructor(private ui: PdfUi) {
    this.viewer = new PDFViewer({
      container: ui.container,
      viewer: ui.viewer,
      eventBus: this.bus,
      linkService: this.link,
      findController: this.finder,
    })
    this.link.setViewer(this.viewer)

    this.bus.on('pagesinit', () => {
      const pos = this.restore
      this.restore = null
      this.viewer.currentScaleValue = pos?.scale ?? lastScale.get() ?? 'page-width'
      this.applyingSaved = false
      if (pos && pos.page <= this.viewer.pagesCount) {
        const div = this.viewer.getPageView(pos.page - 1).div
        ui.container.scrollTop = div.offsetTop + pos.frac * div.clientHeight
      }
    })
    // pdf.js пересоздаёт содержимое страницы при перерисовке: возвращаем подсветку
    this.bus.on('pagerendered', ({ pageNumber }: { pageNumber: number }) => this.drawNotes(pageNumber))
    ui.container.addEventListener('click', (e) => this.hitNote(e))
    this.bus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      ui.page.value = String(pageNumber)
      this.highlightThumb(pageNumber)
    })
    this.bus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      this.showScale(scale, presetValue)
      if (!this.applyingSaved) lastScale.set(this.viewer.currentScaleValue)
      this.savePosSoon()
    })
    const showCount = ({ matchesCount, state }: { matchesCount: { current: number; total: number }; state?: number }) => {
      if (!ui.find.value) ui.findCount.textContent = ''
      else if (state === FindState.NOT_FOUND || matchesCount.total === 0) ui.findCount.textContent = 'нет'
      else ui.findCount.textContent = `${matchesCount.current} / ${matchesCount.total}`
    }
    this.bus.on('updatefindmatchescount', showCount)
    this.bus.on('updatefindcontrolstate', showCount)

    ui.container.addEventListener('scroll', () => this.savePosSoon(), { passive: true })
    // Ctrl+колесо: масштаб относительно курсора, а не масштаб всей страницы браузера
    ui.container.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        const opts = { origin: [e.clientX, e.clientY], drawingDelay: 200 }
        if (e.deltaY < 0) this.viewer.increaseScale(opts)
        else this.viewer.decreaseScale(opts)
      },
      { passive: false },
    )
    ui.page.addEventListener('change', () => {
      const n = Math.round(+ui.page.value)
      if (n >= 1 && n <= this.viewer.pagesCount) this.viewer.currentPageNumber = n
      else ui.page.value = String(this.viewer.currentPageNumber)
    })
    ui.scale.addEventListener('change', () => {
      this.viewer.currentScaleValue = ui.scale.value
      ui.container.focus()
    })
    ui.find.addEventListener('input', () => this.search(false, false))
    ui.find.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.search(e.shiftKey, true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.clearSearch()
        ui.container.focus()
      }
    })
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = +(e.target as HTMLElement).dataset.page!
          if (e.isIntersecting) this.queueThumb(n)
          else this.thumbQueue = this.thumbQueue.filter((q) => q !== n) // ушла из вида до отрисовки
        }
      },
      { root: ui.thumbs, rootMargin: '300px 0px' },
    )
    ui.thumbs.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-page]')
      if (item) this.viewer.currentPageNumber = +item.dataset.page!
    })
    ui.outline.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement & { _item?: OutlineItem }>('[data-o]')
      const item = btn?._item
      if (!item) return
      if (item.dest) void this.link.goToDestination(item.dest as string)
      else if (item.url) window.open(item.url, '_blank', 'noopener')
    })
  }

  async open(data: ArrayBuffer) {
    await this.close()
    const size = data.byteLength // буфер уходит в воркер и обнуляется
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      wasmUrl: `${ASSETS}wasm/`,
      iccUrl: `${ASSETS}iccs/`,
    })
    task.onPassword = (update: (pw: string) => void, reason: number) => {
      const pw = prompt(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'Неверный пароль. Ещё раз:' : 'PDF защищён паролем:')
      if (pw === null) void task.destroy()
      else update(pw)
    }
    this.task = task
    const doc = await task.promise
    this.doc = doc
    // одна программа может записать одинаковый ID в разные PDF, поэтому
    // отпечаток дополняем числом страниц и размером файла
    this.posKey = `pdfpos:${doc.fingerprints[0]}:${doc.numPages}:${size}`
    this.restore = (await kvGet<SavedPos>(this.posKey)) ?? null
    this.applyingSaved = true // до pagesinit масштаб выставляет просмотрщик
    this.ui.pageCount.textContent = String(doc.numPages)
    this.ui.page.max = String(doc.numPages)
    this.ui.page.value = '1'
    this.viewer.setDocument(doc)
    this.link.setDocument(doc)
    await Promise.all([this.renderOutline(doc), this.buildThumbs(doc)])
    this.ui.container.focus({ preventScroll: true })
  }

  async close() {
    clearTimeout(this.saveTimer)
    if (this.doc) this.savePosNow()
    this.clearSearch()
    this.viewer.setDocument(null as unknown as PDFDocumentProxy)
    this.link.setDocument(null)
    this.ui.outline.textContent = ''
    this.hasOutline = false
    this.noteRects.clear()
    this.thumbGen++
    this.thumbObserver.disconnect()
    this.thumbQueue = []
    this.activeThumb = null
    this.ui.thumbs.textContent = ''
    const task = this.task
    this.task = null
    this.doc = null
    if (task) await task.destroy()
  }

  /** Идентификатор документа для запасного хранения заметок. */
  get docKey() {
    return this.posKey.replace(/^pdfpos:/, '')
  }

  /** Привязка для текущего выделения в тексте PDF. */
  selection(): { anchor: PdfAnchor; rect: DOMRect } | null {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!this.ui.viewer.contains(range.commonAncestorContainer)) return null
    const quote = sel.toString().replace(/\s+/g, ' ').trim()
    if (!quote) return null
    // страницы рядом с текущей: выделение не бывает длиннее пары страниц
    const cur = this.viewer.currentPageNumber
    const pages: { n: number; box: DOMRect }[] = []
    for (let n = Math.max(1, cur - 2); n <= Math.min(this.viewer.pagesCount, cur + 3); n++) {
      pages.push({ n, box: this.viewer.getPageView(n - 1).div.getBoundingClientRect() })
    }
    const rects: PdfRect[] = []
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const pg = pages.find(({ box }) => cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom)
      if (!pg) continue
      const b = pg.box
      rects.push({ page: pg.n, x: (r.left - b.left) / b.width, y: (r.top - b.top) / b.height, w: r.width / b.width, h: r.height / b.height })
    }
    if (!rects.length) return null
    return { anchor: { kind: 'pdf', page: rects[0].page, quote, rects: mergeRects(rects) }, rect: range.getBoundingClientRect() }
  }

  setNotes(notes: { id: string; title: string; rects: PdfRect[] }[]) {
    this.noteRects.clear()
    for (const n of notes) {
      for (const r of n.rects) {
        let list = this.noteRects.get(r.page)
        if (!list) this.noteRects.set(r.page, (list = []))
        list.push({ id: n.id, title: n.title, r })
      }
    }
    for (let n = 1; n <= this.viewer.pagesCount; n++) this.drawNotes(n)
  }

  /** Прокрутить к заметке и ненадолго выделить её. */
  revealNote(id: string, rects: PdfRect[]) {
    const first = rects[0]
    if (!first || first.page > this.viewer.pagesCount) return
    const div = this.viewer.getPageView(first.page - 1).div
    this.ui.container.scrollTop = div.offsetTop + first.y * div.clientHeight - this.ui.container.clientHeight / 3
    this.flashId = id
    for (const p of new Set(rects.map((r) => r.page))) this.drawNotes(p)
    setTimeout(() => {
      if (this.flashId !== id) return
      this.flashId = null
      for (const el of this.ui.viewer.querySelectorAll('.note-hl.flash')) el.classList.remove('flash')
    }, 1600)
  }

  private drawNotes(pageNumber: number) {
    const div = this.viewer.getPageView(pageNumber - 1)?.div
    if (!div) return
    div.querySelector(':scope > .note-layer')?.remove()
    const list = this.noteRects.get(pageNumber)
    if (!list?.length) return
    const layer = document.createElement('div')
    layer.className = 'note-layer'
    for (const { id, title, r } of list) {
      const hl = document.createElement('div')
      hl.className = id === this.flashId ? 'note-hl flash' : 'note-hl'
      hl.dataset.note = id
      hl.title = title
      hl.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`
      layer.appendChild(hl)
    }
    div.appendChild(layer)
  }

  /** Подсветка не перехватывает мышь (иначе текст не выделить), поэтому попадание считаем сами. */
  private hitNote(e: MouseEvent) {
    if (!this.onNoteClick || !getSelection()?.isCollapsed) return
    const page = (e.target as HTMLElement).closest<HTMLElement>('.page')
    const n = +(page?.dataset.pageNumber ?? 0)
    const list = this.noteRects.get(n)
    if (!page || !list) return
    const b = page.getBoundingClientRect()
    const x = (e.clientX - b.left) / b.width
    const y = (e.clientY - b.top) / b.height
    const hit = list.find(({ r }) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
    if (!hit) return
    const r = hit.r
    this.onNoteClick(hit.id, new DOMRect(b.left + r.x * b.width, b.top + r.y * b.height, r.w * b.width, r.h * b.height))
  }

  zoomIn() {
    this.viewer.increaseScale()
  }
  zoomOut() {
    this.viewer.decreaseScale()
  }
  zoomReset() {
    this.viewer.currentScaleValue = 'page-width'
  }

  focusFind() {
    this.ui.find.focus()
    this.ui.find.select()
  }

  search(previous: boolean, again: boolean) {
    const query = this.ui.find.value
    if (!query) return this.clearSearch()
    this.bus.dispatch('find', {
      source: this,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    })
  }

  private clearSearch() {
    this.ui.findCount.textContent = ''
    this.bus.dispatch('findbarclose', { source: this })
  }

  private showScale(scale: number, preset?: string) {
    const sel = this.ui.scale
    const custom = sel.querySelector<HTMLOptionElement>('option[data-custom]')!
    const match = [...sel.options].find((o) => !o.dataset.custom && (o.value === preset || +o.value === scale))
    custom.hidden = !!match
    if (match) sel.value = match.value
    else {
      custom.value = String(scale)
      custom.textContent = `${Math.round(scale * 100)}%`
      sel.value = custom.value
    }
  }

  private savePosSoon() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.savePosNow(), 400)
  }

  private savePosNow() {
    if (!this.doc || this.restore || !this.viewer.pagesCount) return
    const page = this.viewer.currentPageNumber
    const div = this.viewer.getPageView(page - 1)?.div
    if (!div) return
    const frac = (this.ui.container.scrollTop - div.offsetTop) / (div.clientHeight || 1)
    void kvSet(this.posKey, { page, frac, scale: this.viewer.currentScaleValue } satisfies SavedPos)
  }

  /** Прокрутить панель миниатюр к текущей странице (когда панель снова показана). */
  revealThumb() {
    const t = this.activeThumb
    const panel = this.ui.thumbs
    if (!t || !panel.offsetParent) return
    const r = t.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    // уже видна целиком — не дёргаем панель
    if (r.top >= p.top && r.bottom <= p.bottom) return
    panel.scrollTop += r.top - p.top - (p.height - r.height) / 2
  }

  private highlightThumb(n: number) {
    this.activeThumb?.classList.remove('active')
    this.activeThumb = this.ui.thumbs.children[n - 1] as HTMLElement | undefined ?? null
    if (!this.activeThumb) return
    this.activeThumb.classList.add('active')
    this.revealThumb()
  }

  /** Заглушки нужного размера для всех страниц; содержимое рисуется лениво. */
  private async buildThumbs(doc: PDFDocumentProxy) {
    const first = (await doc.getPage(1)).getViewport({ scale: 1 })
    const frag = document.createDocumentFragment()
    for (let n = 1; n <= doc.numPages; n++) {
      const item = document.createElement('button')
      item.className = 'thumb'
      item.dataset.page = String(n)
      item.title = `Страница ${n}`
      const img = document.createElement('div')
      img.className = 'thumb-img'
      img.style.aspectRatio = `${first.width} / ${first.height}`
      const label = document.createElement('span')
      label.textContent = String(n)
      item.append(img, label)
      frag.appendChild(item)
    }
    this.ui.thumbs.appendChild(frag)
    for (const item of this.ui.thumbs.children) this.thumbObserver.observe(item)
    this.highlightThumb(this.viewer.currentPageNumber || 1)
  }

  private queueThumb(n: number) {
    const item = this.ui.thumbs.children[n - 1] as HTMLElement | undefined
    if (!item || item.dataset.done || this.thumbQueue.includes(n)) return
    this.thumbQueue.push(n)
    void this.drainThumbs()
  }

  private async drainThumbs() {
    if (this.thumbBusy) return
    this.thumbBusy = true
    const gen = this.thumbGen
    try {
      while (this.thumbQueue.length && gen === this.thumbGen && this.doc) {
        const n = this.thumbQueue.shift()!
        const item = this.ui.thumbs.children[n - 1] as HTMLElement | undefined
        if (!item || item.dataset.done) continue
        item.dataset.done = '1'
        const page = await this.doc.getPage(n)
        if (gen !== this.thumbGen) return
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: (THUMB_WIDTH * devicePixelRatio) / base.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvas, viewport }).promise
        if (gen !== this.thumbGen) return
        const img = item.firstElementChild as HTMLElement
        img.style.aspectRatio = `${base.width} / ${base.height}`
        img.replaceChildren(canvas)
        page.cleanup()
      }
    } catch {
      // документ закрыт во время отрисовки: просто прекращаем
    } finally {
      this.thumbBusy = false
      // за время отрисовки могли прийти новые страницы или новый документ
      if (this.thumbQueue.length && this.doc) void this.drainThumbs()
    }
  }

  private async renderOutline(doc: PDFDocumentProxy) {
    const outline = (await doc.getOutline()) as OutlineItem[] | null
    this.hasOutline = !!outline?.length
    this.ui.outline.textContent = ''
    if (!outline?.length) {
      this.ui.outline.textContent = 'В документе нет оглавления'
      return
    }
    const build = (items: OutlineItem[]) => {
      const ul = document.createElement('ul')
      for (const item of items) {
        const li = document.createElement('li')
        const btn = document.createElement('button') as HTMLButtonElement & { _item?: OutlineItem }
        btn.dataset.o = ''
        btn._item = item
        btn.textContent = item.title
        btn.title = item.title
        if (item.items.length) {
          const details = document.createElement('details')
          const summary = document.createElement('summary')
          summary.appendChild(btn)
          details.append(summary, build(item.items))
          li.appendChild(details)
        } else li.appendChild(btn)
        ul.appendChild(li)
      }
      return ul
    }
    this.ui.outline.appendChild(build(outline))
  }
}

/** Склеить прямоугольники выделения одной строки: текстовый слой pdf.js даёт их по кусочку на слово. */
function mergeRects(rects: PdfRect[]): PdfRect[] {
  const sorted = [...rects].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
  const out: PdfRect[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    const sameLine = last && last.page === r.page && Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) / 2
    if (sameLine && r.x <= last.x + last.w + 0.01) {
      const right = Math.max(last.x + last.w, r.x + r.w)
      const top = Math.min(last.y, r.y)
      const bottom = Math.max(last.y + last.h, r.y + r.h)
      Object.assign(last, { x: Math.min(last.x, r.x), y: top, w: right - Math.min(last.x, r.x), h: bottom - top })
    } else out.push({ ...r })
  }
  return out
}
