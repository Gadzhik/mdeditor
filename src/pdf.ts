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
    await this.renderOutline(doc)
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
