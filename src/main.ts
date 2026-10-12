import './styles.css'
import { createEditor } from './editor'
import { Preview } from './preview'
import { ScrollSync } from './scrollsync'
import { kvDel, kvGet, kvSet, type Draft } from './storage'
import { canPickDirectory, ensurePermission, isPdf, openFile, pickDirectory, saveFileAs, writeFile } from './files'
import type { PdfReader } from './pdf'
import { FileTree, getFileByPath, resolvePath } from './tree'
import { initTheme } from './theme'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const app = $('app')
const sidebar = $('sidebar')
const editorPane = $('editor-pane')
const previewPane = $('preview-pane')
const previewEl = $('preview')
const filenameEl = $('filename')
const statsEl = $('stats')

const WELCOME = `# MD Editor

Быстрый Markdown-редактор прямо в браузере.

- **Ctrl+O**: открыть файл, **Ctrl+S**: сохранить, **Ctrl+Shift+S**: сохранить как
- **Alt+1 / Alt+2 / Alt+3**: редактор / split / режим чтения
- **Ctrl+\\\\**: боковая панель с деревом папки
- **Ctrl+B / Ctrl+I**: жирный / курсив, **Ctrl+F**: поиск
- Перетащите \`.md\` или \`.pdf\` файл либо папку в окно, чтобы открыть

Черновик сохраняется автоматически.

\`\`\`ts
const hello = (name: string) => \`Привет, \${name}!\`
\`\`\`

| Возможность | Есть |
|-------------|:----:|
| GFM-таблицы | ✓ |
| Списки задач | ✓ |

- [x] Написать редактор
- [ ] Написать что-нибудь в нём
`

// --- Состояние документа -------------------------------------------------------

const doc = {
  name: 'untitled.md',
  path: null as string | null, // путь внутри открытой папки
  handle: null as FileSystemFileHandle | null,
  dirty: false,
}

/** Открытый PDF. Markdown-документ при этом остаётся загруженным под ним. */
interface PdfDoc {
  name: string
  path: string | null
  handle: FileSystemFileHandle | null
}
let pdf: PdfDoc | null = null

const editor = createEditor(editorPane, onChange, () => {
  sync.onEditorScroll()
  saveViewSoon()
})
const preview = new Preview(previewEl, onPreviewRendered, () => scheduleRender())
const sync = new ScrollSync(editor.view, previewPane, previewEl)
const tree = new FileTree($('tree'), (handle, path) => void openFromTree(handle, path))

function updateTitle() {
  if (pdf) {
    filenameEl.textContent = pdf.path ?? pdf.name
    filenameEl.title = 'PDF, только чтение'
    document.title = `${pdf.name} — MD Editor`
    return
  }
  const dot = doc.dirty ? '● ' : ''
  filenameEl.textContent = dot + (doc.path ?? doc.name)
  filenameEl.title = doc.handle ? 'Связан с файлом на диске' : 'Не сохранён на диск'
  document.title = `${dot}${doc.name} — MD Editor`
}

function toast(msg: string) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2500)
}

// --- Рендер --------------------------------------------------------------------

let mode = 'split'
let rafPending = false
let previewStale = true

// не больше одного рендера за кадр; на больших документах воркер сам
// коалесцирует запросы, пока занят парсингом
function scheduleRender() {
  previewStale = true
  if (mode === 'editor' || rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    doRender()
  })
}

function doRender() {
  previewStale = false
  preview.render(editor.getValue())
}

let statsTimer = 0
function updateStatsSoon() {
  clearTimeout(statsTimer)
  statsTimer = setTimeout(() => {
    const text = editor.getValue()
    const words = text.match(/\S+/g)?.length ?? 0
    statsEl.textContent = `${words.toLocaleString('ru')} слов · ${editor.view.state.doc.lines.toLocaleString('ru')} строк`
  }, 300)
}

// --- Черновик ------------------------------------------------------------------

let draftTimer = 0
function saveDraftNow() {
  clearTimeout(draftTimer)
  const draft: Draft = { text: editor.getValue(), name: doc.name, path: doc.path, cursor: editor.cursor(), dirty: doc.dirty, handle: doc.handle }
  return kvSet('draft', draft)
}
function saveDraftSoon() {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(saveDraftNow, 500)
}

// --- Положение и масштаб заметок ----------------------------------------------
// Для каждого файла запоминаются строка у верхнего края, курсор и масштаб текста.

interface ViewState {
  line: number
  cursor: number
  zoom: number
}

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const zoomBtn = $('btn-zoom')
let zoom = 1
let viewKey: string | null = null // ключ состояния текущего документа в IndexedDB
let viewSeq = 0
let viewReady = false // до первой загрузки документа позицию брать неоткуда
let pendingLine: number | null = null // ждёт отрисовки превью
let lineBeforePdf = 0

/** Строка исходника у верхнего края видимой панели. */
function topLine() {
  return mode === 'preview' ? sync.previewTopLine() : sync.editorTopLine()
}

/** Прокрутить видимые панели к строке; если превью ещё рендерится, докрутим в onPreviewRendered. */
function restoreLine(line: number) {
  pendingLine = line
  requestAnimationFrame(() => {
    if (mode !== 'preview') sync.scrollEditorToLine(line)
    if (pendingLine !== line) return
    if (mode === 'editor') pendingLine = null
    else if (!previewStale && !preview.busy) {
      sync.scrollPreviewToLine(line)
      pendingLine = null
    }
  })
}

function onPreviewRendered() {
  if (pendingLine === null) return sync.syncFromEditor()
  if (mode !== 'editor' && !preview.busy) {
    sync.scrollPreviewToLine(pendingLine)
    pendingLine = null
  }
}

async function viewKeyFor(handle: FileSystemFileHandle | null, path: string | null, name: string): Promise<string> {
  // getUniqueId (Chromium) узнаёт файл даже после переименования и вне открытой папки
  const h = handle as (FileSystemFileHandle & { getUniqueId?: () => Promise<string> }) | null
  if (h?.getUniqueId) {
    try {
      return `view:id:${await h.getUniqueId()}`
    } catch {}
  }
  if (path && tree.root) return `view:path:${tree.root.name}/${path}`
  return `view:name:${name}`
}

let viewTimer = 0
function saveViewSoon() {
  clearTimeout(viewTimer)
  viewTimer = setTimeout(saveViewNow, 400)
}
function saveViewNow() {
  clearTimeout(viewTimer)
  if (!viewKey || pdf || pendingLine !== null) return
  void kvSet(viewKey, { line: topLine(), cursor: editor.cursor(), zoom } satisfies ViewState)
}

/** Вернуть сохранённые позицию и масштаб документа, загруженного в редактор. */
async function restoreView() {
  const seq = ++viewSeq
  viewKey = null
  const key = await viewKeyFor(doc.handle, doc.path, doc.name)
  const state = await kvGet<ViewState>(key)
  if (seq !== viewSeq) return // пока читали, открыли другой документ
  viewKey = key
  applyZoom(state?.zoom ?? defaultZoom())
  if (state) {
    editor.setCursor(state.cursor)
    restoreLine(state.line)
  }
}

function defaultZoom() {
  const z = parseFloat(store.get('mdZoom') ?? '')
  return z >= ZOOMS[0] && z <= ZOOMS[ZOOMS.length - 1] ? z : 1
}

function applyZoom(z: number) {
  zoom = z
  app.style.setProperty('--zoom', String(z))
  zoomBtn.textContent = `${Math.round(z * 100)}%`
  zoomBtn.classList.toggle('changed', z !== 1)
  editor.view.requestMeasure()
}

/** Масштаб, выставленный пользователем: держим позицию и запоминаем выбор. */
function changeZoom(z: number) {
  const line = viewReady && !pdf ? topLine() : null
  applyZoom(z)
  if (line !== null) restoreLine(line)
  store.set('mdZoom', String(z))
  saveViewSoon()
}

function stepZoom(dir: 1 | -1) {
  const next = dir > 0 ? ZOOMS.find((v) => v > zoom + 1e-3) : [...ZOOMS].reverse().find((v) => v < zoom - 1e-3)
  if (next) changeZoom(next)
}

function onChange() {
  if (!doc.dirty) {
    doc.dirty = true
    updateTitle()
  }
  scheduleRender()
  saveDraftSoon()
  saveViewSoon()
  updateStatsSoon()
}

// --- Документы и файлы ---------------------------------------------------------

const assetCache = new Map<string, Promise<string | null>>()

function assetResolver(filePath: string) {
  return (rel: string) => {
    const root = tree.root
    const p = resolvePath(filePath, rel)
    if (!root || !p) return Promise.resolve(null)
    let url = assetCache.get(p)
    if (!url) {
      url = getFileByPath(root, p)
        .then((h) => h?.getFile())
        .then((f) => (f ? URL.createObjectURL(f) : null))
        .catch(() => null)
      assetCache.set(p, url)
    }
    return url
  }
}

function loadDoc(text: string, name: string, handle: FileSystemFileHandle | null, path: string | null, cursor = 0, dirty = false) {
  saveViewNow() // позиция предыдущего документа
  pendingLine = null
  editor.setValue(text, cursor)
  Object.assign(doc, { name, handle, path, dirty })
  tree.setActive(path)
  preview.setAssetResolver(path && tree.root ? assetResolver(path) : null)
  updateTitle()
  updateStatsSoon()
  previewPane.scrollTop = 0
  scheduleRender()
  saveDraftSoon()
  void restoreView()
}

const confirmDiscard = () => !doc.dirty || confirm('Есть несохранённые изменения. Отбросить их?')

async function openFromTree(handle: FileSystemFileHandle, path: string) {
  if (pdf && path === doc.path) return closePdf() // заметка уже загружена под PDF
  if (path === (pdf ? pdf.path : doc.path)) return
  try {
    await openAny(await handle.getFile(), handle, path)
  } catch (e) {
    toast(`Не удалось открыть: ${(e as Error).message}`)
  }
}

/** Единая точка открытия: PDF показывается в читалке, остальное в редакторе. */
async function openAny(file: File, handle: FileSystemFileHandle | null, path: string | null) {
  if (isPdf(file.name)) return openPdf(file, handle, path)
  if (!confirmDiscard()) return
  const text = await file.text()
  closePdf()
  loadDoc(text, file.name, handle, path)
}

/** Путь файла внутри открытой папки, если он в ней лежит. */
async function pathInFolder(handle: FileSystemFileHandle): Promise<string | null> {
  const parts = tree.root ? await tree.root.resolve(handle) : null
  return parts ? parts.join('/') : null
}

async function openFileDialog() {
  try {
    const f = await openFile()
    if (f) await openAny(f.file, f.handle, f.handle ? await pathInFolder(f.handle) : null)
  } catch (e) {
    toast(`Не удалось открыть: ${(e as Error).message}`)
  }
}

async function save(as = false) {
  if (pdf) return
  const text = editor.getValue()
  try {
    if (!as && doc.handle) {
      if (!(await writeFile(doc.handle, text))) return toast('Нет доступа на запись')
    } else {
      const r = await saveFileAs(doc.name, text)
      if (!r) return
      if (r !== 'downloaded') {
        doc.handle = r
        doc.name = r.name
        doc.path = await pathInFolder(r)
        if (doc.path && !tree.has(doc.path) && tree.root) await tree.load(tree.root)
        tree.setActive(doc.path)
      }
    }
    doc.dirty = false
    updateTitle()
    saveDraftNow()
    toast('Сохранено')
  } catch (e) {
    toast(`Ошибка сохранения: ${(e as Error).message}`)
  }
}

function newDoc() {
  if (!confirmDiscard()) return
  closePdf()
  loadDoc('', 'untitled.md', null, null)
}

// --- PDF -----------------------------------------------------------------------

const pdfPane = $('pdf-pane')
const pdfSide = $('pdf-side')
let readerPromise: Promise<PdfReader> | null = null

/** pdf.js (~1 МБ) загружается только при первом открытии PDF. */
function getReader() {
  readerPromise ??= import('./pdf').then(
    ({ PdfReader }) =>
      new PdfReader({
        container: $<HTMLDivElement>('pdf-container'),
        viewer: $<HTMLDivElement>('pdf-viewer'),
        outline: $('pdf-outline'),
        thumbs: $('pdf-thumbs'),
        page: $<HTMLInputElement>('pdf-page'),
        pageCount: $('pdf-count'),
        scale: $<HTMLSelectElement>('pdf-scale'),
        find: $<HTMLInputElement>('pdf-find'),
        findCount: $('pdf-find-count'),
      }),
  )
  return readerPromise
}

function setKind(kind: 'md' | 'pdf') {
  document.body.dataset.kind = kind
  pdfPane.hidden = kind !== 'pdf'
}

function showSide(show: boolean) {
  pdfSide.hidden = !show
  $('pdf-btn-side').classList.toggle('on', show)
  if (show && pdfSide.dataset.tab === 'thumbs') readerPromise?.then((r) => r.revealThumb())
}

function setPdfTab(tab: string) {
  pdfSide.dataset.tab = tab
  for (const b of pdfSide.querySelectorAll<HTMLElement>('.pdf-tabs button')) b.classList.toggle('on', b.dataset.tab === tab)
  if (tab === 'thumbs') readerPromise?.then((r) => r.revealThumb())
}

async function openPdf(file: File, handle: FileSystemFileHandle | null, path: string | null) {
  if (!pdf) {
    saveViewNow()
    lineBeforePdf = topLine() // скрытые панели теряют прокрутку
  }
  const me: PdfDoc = { name: file.name, path, handle }
  pdf = me
  setKind('pdf')
  tree.setActive(path)
  updateTitle()
  $('pdf-loading').hidden = false
  try {
    const reader = await getReader()
    await reader.open(await file.arrayBuffer())
    if (pdf !== me) return
    // вкладка «Оглавление» есть смысл открывать, только если оно в файле есть
    const tab = store.get('pdfTab') ?? (reader.hasOutline ? 'outline' : 'thumbs')
    setPdfTab(tab === 'outline' && !reader.hasOutline ? 'thumbs' : tab)
    showSide(store.get('pdfSide') !== '0')
    // без handle (fallback-открытие) PDF после перезагрузки не вернуть
    if (handle) kvSet('lastPdf', me)
    else kvDel('lastPdf')
  } catch (e) {
    if (pdf !== me) return
    closePdf()
    toast(`Не удалось открыть PDF: ${(e as Error).message}`)
  } finally {
    if (pdf === me) $('pdf-loading').hidden = true
  }
}

function closePdf() {
  if (!pdf) return
  pdf = null
  readerPromise?.then((r) => r.close())
  kvDel('lastPdf')
  setKind('md')
  tree.setActive(doc.path)
  updateTitle()
  editor.view.requestMeasure()
  if (previewStale) scheduleRender()
  restoreLine(lineBeforePdf)
}

$('pdf-close').onclick = closePdf
$('pdf-zoom-in').onclick = () => getReader().then((r) => r.zoomIn())
$('pdf-zoom-out').onclick = () => getReader().then((r) => r.zoomOut())
$('pdf-find-next').onclick = () => getReader().then((r) => r.search(false, true))
$('pdf-find-prev').onclick = () => getReader().then((r) => r.search(true, true))
$('pdf-btn-side').onclick = () => {
  const show = !!pdfSide.hidden
  showSide(show)
  store.set('pdfSide', show ? '1' : '0')
}
pdfSide.querySelector<HTMLElement>('.pdf-tabs')!.onclick = (e) => {
  const tab = (e.target as HTMLElement).dataset.tab
  if (!tab) return
  setPdfTab(tab)
  store.set('pdfTab', tab)
}
$('pdf-invert').onclick = () => {
  const on = pdfPane.classList.toggle('invert')
  store.set('pdfInvert', on ? '1' : '0')
}

// --- Папка ---------------------------------------------------------------------

const folderName = $('folder-name')
const restoreBtn = $('btn-restore')

async function openFolder(dir: FileSystemDirectoryHandle) {
  for (const url of assetCache.values()) url.then((u) => u && URL.revokeObjectURL(u))
  assetCache.clear()
  restoreBtn.hidden = true
  folderName.textContent = dir.name
  setSidebar(true)
  kvSet('dir', dir)
  await tree.load(dir)
  // текущие документы могли оказаться внутри новой папки
  doc.path = doc.handle ? await pathInFolder(doc.handle) : null
  if (pdf) pdf.path = pdf.handle ? await pathInFolder(pdf.handle) : null
  tree.setActive(pdf ? pdf.path : doc.path)
  preview.setAssetResolver(doc.path ? assetResolver(doc.path) : null)
  updateTitle()
  scheduleRender()
}

async function openFolderDialog() {
  if (!canPickDirectory) return toast('Открытие папок поддерживается только в Chrome/Edge')
  try {
    const dir = await pickDirectory()
    if (dir) await openFolder(dir)
  } catch (e) {
    toast(`Не удалось открыть папку: ${(e as Error).message}`)
  }
}

// --- Раскладка -----------------------------------------------------------------

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {}
  },
}

function setMode(m: string) {
  // строка, которую видно сейчас, должна остаться наверху и в новом режиме
  const line = viewReady && !pdf && m !== mode ? topLine() : null
  mode = m
  app.dataset.mode = m
  for (const b of document.querySelectorAll<HTMLElement>('#mode-switch button')) b.classList.toggle('on', b.dataset.mode === m)
  store.set('mode', m)
  editor.view.requestMeasure()
  if (m !== 'editor' && previewStale) doRender()
  if (m === 'editor') editor.view.focus()
  if (line !== null) restoreLine(line)
}

function setSidebar(show: boolean) {
  sidebar.hidden = !show
  store.set('sidebar', show ? '1' : '0')
}

function setSplit(ratio: number) {
  app.style.setProperty('--split', String(ratio))
}

const divider = $('divider')
divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId)
  document.body.classList.add('resizing')
  const move = (ev: PointerEvent) => {
    const left = editorPane.getBoundingClientRect().left
    const right = app.getBoundingClientRect().right
    setSplit(Math.min(0.85, Math.max(0.15, (ev.clientX - left) / (right - left))))
  }
  const up = () => {
    divider.removeEventListener('pointermove', move)
    document.body.classList.remove('resizing')
    store.set('split', app.style.getPropertyValue('--split'))
  }
  divider.addEventListener('pointermove', move)
  divider.addEventListener('pointerup', up, { once: true })
})
divider.addEventListener('dblclick', () => {
  setSplit(0.5)
  store.set('split', '0.5')
})

// --- События -------------------------------------------------------------------

$('btn-new').onclick = newDoc
$('btn-open').onclick = openFileDialog
$('btn-folder').onclick = openFolderDialog
$('btn-save').onclick = () => save(false)
$('btn-sidebar').onclick = () => setSidebar(!!sidebar.hidden)
$('mode-switch').onclick = (e) => {
  const m = (e.target as HTMLElement).dataset.mode
  if (m) setMode(m)
}
initTheme($('btn-theme'))
zoomBtn.onclick = () => changeZoom(1)
previewPane.addEventListener('scroll', saveViewSoon, { passive: true })

// Ctrl+колесо: масштаб текста заметки (у PDF свой обработчик)
let wheelAcc = 0
app.addEventListener(
  'wheel',
  (e) => {
    if (pdf || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    wheelAcc += e.deltaY
    if (Math.abs(wheelAcc) >= 60) {
      stepZoom(wheelAcc < 0 ? 1 : -1)
      wheelAcc = 0
    }
  },
  { passive: false },
)

// --- Ширина текста превью ---

const DEFAULT_WIDTH = 1200
const widthBtn = $('btn-width')
const widthPop = $('width-pop')
const widthRange = $<HTMLInputElement>('width-range')
const widthFull = $<HTMLInputElement>('width-full')
const widthVal = $('width-val')

/** 0 — во всю ширину окна. */
function setReadWidth(px: number) {
  const full = px === 0
  app.style.setProperty('--read-width', full ? 'none' : `${px}px`)
  widthFull.checked = full
  widthRange.disabled = full
  if (!full) widthRange.value = String(px)
  widthVal.textContent = full ? 'во всю ширину' : `${px} px`
  widthBtn.title = `Ширина текста: ${widthVal.textContent} (Alt+[ / Alt+])`
  store.set('readWidth', String(px))
}

function toggleWidthPop(show = !!widthPop.hidden) {
  widthPop.hidden = !show
  widthBtn.classList.toggle('on', show)
}

widthBtn.onclick = () => toggleWidthPop()
widthRange.oninput = () => setReadWidth(+widthRange.value)
widthRange.ondblclick = () => setReadWidth(DEFAULT_WIDTH)
widthFull.onchange = () => setReadWidth(widthFull.checked ? 0 : +widthRange.value)
document.addEventListener('pointerdown', (e) => {
  if (!widthPop.hidden && !$('width-ctl').contains(e.target as Node)) toggleWidthPop(false)
})

/** Шаг ширины с клавиатуры: Alt+[ уже, Alt+] шире. */
function stepReadWidth(dir: -1 | 1) {
  const cur = widthFull.checked ? +widthRange.max : +widthRange.value
  const next = Math.min(+widthRange.max, Math.max(+widthRange.min, cur + dir * 100))
  setReadWidth(next)
}

/** Клавиши читалки PDF. true — событие обработано. */
function handlePdfKey(e: KeyboardEvent, mod: boolean, k: string): boolean {
  const run = (fn: (r: PdfReader) => void) => {
    e.preventDefault()
    getReader().then(fn)
    return true
  }
  if (mod && !e.altKey && k === 'f') return run((r) => r.focusFind())
  if (mod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) return run((r) => r.zoomIn())
  if (mod && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return run((r) => r.zoomOut())
  if (mod && !e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0')) return run((r) => r.zoomReset())
  // сохранять нечего, режимы редактора к PDF не относятся
  if ((mod && !e.altKey && k === 's') || (e.altKey && !mod && /^Digit[123]$/.test(e.code))) {
    e.preventDefault()
    return true
  }
  return false
}

window.addEventListener(
  'keydown',
  (e) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (pdf && handlePdfKey(e, mod, k)) return
    if (mod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
      e.preventDefault()
      stepZoom(1)
    } else if (mod && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      e.preventDefault()
      stepZoom(-1)
    } else if (mod && !e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
      e.preventDefault()
      changeZoom(1)
    } else if (mod && !e.altKey && k === 's') {
      e.preventDefault()
      save(e.shiftKey)
    } else if (mod && !e.altKey && !e.shiftKey && k === 'o') {
      e.preventDefault()
      openFileDialog()
    } else if (mod && e.key === '\\') {
      e.preventDefault()
      setSidebar(!!sidebar.hidden)
    } else if (e.altKey && !mod && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault()
      stepReadWidth(e.code === 'BracketLeft' ? -1 : 1)
    } else if (e.key === 'Escape' && !widthPop.hidden) {
      toggleWidthPop(false)
    } else if (e.altKey && !mod && !e.shiftKey && /^Digit[123]$/.test(e.code)) {
      e.preventDefault()
      setMode(['editor', 'split', 'preview'][+e.code.slice(5) - 1])
    }
  },
  true,
)

// ссылки на другие .md внутри папки открываем в редакторе
previewEl.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a')
  const href = a?.getAttribute('href')
  if (!href || href.startsWith('#') || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return
  e.preventDefault()
  const p = doc.path && tree.root ? resolvePath(doc.path, href) : null
  if (p && tree.has(p)) tree.open(p)
  else toast('Ссылка ведёт на файл вне открытой папки')
})

// drag & drop файла или папки
const dropzone = $('dropzone')
let dragDepth = 0
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return
  dragDepth++
  dropzone.hidden = false
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    dropzone.hidden = true
  }
})
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault()
})
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dropzone.hidden = true
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === 'file')
  if (!item) return
  // оба вызова обязаны быть синхронными внутри обработчика drop
  type WithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
  const handlePromise = (item as WithHandle).getAsFileSystemHandle?.()
  const file = item.getAsFile()
  try {
    const handle = await handlePromise
    if (handle?.kind === 'directory') return void (await openFolder(handle as FileSystemDirectoryHandle))
    if (handle) {
      const fh = handle as FileSystemFileHandle
      await openAny(await fh.getFile(), fh, await pathInFolder(fh))
    } else if (file) {
      await openAny(file, null, null)
    }
  } catch (e) {
    toast(`Не удалось открыть: ${(e as Error).message}`)
  }
})

window.addEventListener('beforeunload', (e) => {
  saveDraftNow()
  saveViewNow()
  // текст в черновике не потеряется, но файл на диске останется старым
  if (doc.dirty && doc.handle) e.preventDefault()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveDraftNow()
    saveViewNow()
  }
})

// --- Старт ---------------------------------------------------------------------

async function init() {
  const split = parseFloat(store.get('split') ?? '')
  if (split > 0 && split < 1) setSplit(split)
  const savedWidth = parseInt(store.get('readWidth') ?? '', 10)
  setReadWidth(savedWidth === 0 || savedWidth >= 500 ? savedWidth : DEFAULT_WIDTH)
  setMode(store.get('mode') ?? 'split')
  setSidebar(store.get('sidebar') === '1')
  if (!canPickDirectory) $('btn-folder').hidden = true
  if (store.get('pdfInvert') === '0') pdfPane.classList.remove('invert')
  setKind('md')

  const [draft, dir] = await Promise.all([kvGet<Draft>('draft'), kvGet<FileSystemDirectoryHandle>('dir')])

  if (dir) {
    folderName.textContent = dir.name
    if (await ensurePermission(dir, 'read', false)) {
      tree.root = dir
      await tree.load(dir)
    } else {
      // браузер требует жест пользователя для повторного доступа
      restoreBtn.hidden = false
      restoreBtn.onclick = async () => {
        if (await ensurePermission(dir, 'read')) await openFolder(dir)
      }
    }
  }

  if (draft) loadDoc(draft.text, draft.name, draft.handle ?? null, draft.path, draft.cursor, draft.dirty)
  else loadDoc(WELCOME, 'welcome.md', null, null)
  viewReady = true
  editor.view.focus()

  // последний открытый PDF, если браузер ещё помнит разрешение на чтение
  const last = await kvGet<PdfDoc>('lastPdf')
  if (last?.handle && (await ensurePermission(last.handle, 'read', false))) {
    try {
      await openPdf(await last.handle.getFile(), last.handle, last.path)
    } catch {
      kvDel('lastPdf')
    }
  }
}

init()
