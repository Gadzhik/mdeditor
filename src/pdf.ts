// Просмотр PDF на pdf.js. Модуль грузится лениво, при первом открытии PDF.
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { kvGet, kvSet } from './storage'

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
  hasOutline = false
  // миниатюры рисуются по одной за раз и только видимые в панели
  private thumbObserver: IntersectionObserver
  private thumbQueue: number[] = []
  private thumbBusy = false
  private thumbGen = 0
  private activeThumb: HTMLElement | null = null

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
      this.viewer.currentScaleValue = pos?.scale ?? 'page-width'
      if (pos && pos.page <= this.viewer.pagesCount) {
        const div = this.viewer.getPageView(pos.page - 1).div
        ui.container.scrollTop = div.offsetTop + pos.frac * div.clientHeight
      }
    })
    this.bus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      ui.page.value = String(pageNumber)
      this.highlightThumb(pageNumber)
    })
    this.bus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
      this.showScale(scale, presetValue)
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
    this.posKey = `pdfpos:${doc.fingerprints[0]}`
    this.restore = (await kvGet<SavedPos>(this.posKey)) ?? null
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
