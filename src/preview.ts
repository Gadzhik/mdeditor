import DOMPurify from 'dompurify'
import type { RenderedBlock, WorkerRequest, WorkerResponse } from './md.worker'

const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url)

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? ''
    if (/^https?:/i.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  } else if (node.tagName === 'IMG') {
    // относительные картинки резолвим из открытой папки, а не с сервера приложения
    const src = node.getAttribute('src')
    if (src && isRelative(src)) {
      node.setAttribute('data-rel', src)
      node.removeAttribute('src')
    }
  }
})

interface Block {
  html: string
  el: HTMLElement
  start: number
  end: number
}

export type AssetResolver = (relPath: string) => Promise<string | null>

export class Preview {
  private blocks: Block[] = []
  private resolver: AssetResolver | null = null
  private worker = new Worker(new URL('./md.worker.ts', import.meta.url), { type: 'module' })
  private seq = 0
  private inFlight = false
  private queued: string | null = null

  /**
   * onRendered вызывается после патча DOM;
   * onRerenderNeeded — когда превью устарело без правки текста (догрузился язык подсветки).
   */
  constructor(
    private root: HTMLElement,
    private onRendered: () => void,
    onRerenderNeeded: () => void,
  ) {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'lang') {
        this.invalidate()
        onRerenderNeeded()
        return
      }
      this.inFlight = false
      // пока воркер парсил, текст мог измениться: отправляем только последнюю версию
      if (this.queued !== null) {
        const next = this.queued
        this.queued = null
        this.post(next)
      }
      if (msg.id === this.seq) {
        this.patch(msg.blocks)
        this.onRendered()
      }
    }
  }

  setAssetResolver(r: AssetResolver | null) {
    this.resolver = r
    this.invalidate()
  }

  /** Сбросить кэш: следующий render перестроит все блоки. */
  invalidate() {
    for (const b of this.blocks) b.html = ''
  }

  /** true, пока воркер готовит новую версию превью. */
  get busy() {
    return this.inFlight
  }

  render(text: string) {
    if (this.inFlight) this.queued = text
    else this.post(text)
  }

  private post(text: string) {
    this.inFlight = true
    this.worker.postMessage({ id: ++this.seq, text } satisfies WorkerRequest)
  }

  private patch(next: RenderedBlock[]) {
    // общий префикс и суффикс остаются в DOM как есть, заменяется только середина
    const old = this.blocks
    let p = 0
    while (p < old.length && p < next.length && old[p].html === next[p].html) p++
    let s = 0
    while (s < old.length - p && s < next.length - p && old[old.length - 1 - s].html === next[next.length - 1 - s].html) s++

    const anchor = s > 0 ? old[old.length - s].el : null
    for (let k = p; k < old.length - s; k++) old[k].el.remove()

    const frag = document.createDocumentFragment()
    const fresh: Block[] = []
    for (let k = p; k < next.length - s; k++) {
      const el = document.createElement('div')
      el.className = 'b'
      el.innerHTML = DOMPurify.sanitize(next[k].html)
      this.loadAssets(el)
      frag.appendChild(el)
      fresh.push({ html: next[k].html, el, start: -1, end: -1 })
    }
    this.root.insertBefore(frag, anchor)
    this.blocks = [...old.slice(0, p), ...fresh, ...old.slice(old.length - s)]

    // номера строк сдвигаются и у неизменённых блоков после правки (префикс не трогаем)
    for (let k = p; k < next.length; k++) {
      const b = this.blocks[k]
      const { start, end } = next[k]
      if (b.start !== start) b.el.dataset.line = String((b.start = start))
      if (b.end !== end) b.el.dataset.end = String((b.end = end))
    }
  }

  private loadAssets(el: HTMLElement) {
    const resolver = this.resolver
    if (!resolver) return
    for (const img of el.querySelectorAll<HTMLImageElement>('img[data-rel]')) {
      resolver(img.dataset.rel!).then((url) => {
        if (url) img.src = url
      })
    }
  }
}
