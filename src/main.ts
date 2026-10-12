import './styles.css'
import { createEditor } from './editor'
import { Preview } from './preview'
import { ScrollSync } from './scrollsync'
import { kvGet, kvSet, type Draft } from './storage'
import { canPickDirectory, ensurePermission, openFile, pickDirectory, readHandle, saveFileAs, writeFile } from './files'
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
- Перетащите \`.md\` файл или папку в окно, чтобы открыть

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

const editor = createEditor(editorPane, onChange, () => sync.onEditorScroll())
const preview = new Preview(previewEl, () => sync.syncFromEditor(), () => scheduleRender())
const sync = new ScrollSync(editor.view, previewPane, previewEl)
const tree = new FileTree($('tree'), (handle, path) => void openFromTree(handle, path))

function updateTitle() {
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

function onChange() {
  if (!doc.dirty) {
    doc.dirty = true
    updateTitle()
  }
  scheduleRender()
  saveDraftSoon()
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
  editor.setValue(text, cursor)
  Object.assign(doc, { name, handle, path, dirty })
  tree.setActive(path)
  preview.setAssetResolver(path && tree.root ? assetResolver(path) : null)
  updateTitle()
  updateStatsSoon()
  previewPane.scrollTop = 0
  scheduleRender()
  saveDraftSoon()
}

const confirmDiscard = () => !doc.dirty || confirm('Есть несохранённые изменения. Отбросить их?')

async function openFromTree(handle: FileSystemFileHandle, path: string) {
  if (path === doc.path || !confirmDiscard()) return
  try {
    const f = await readHandle(handle)
    loadDoc(f.text, f.name, handle, path)
  } catch (e) {
    toast(`Не удалось открыть: ${(e as Error).message}`)
  }
}

/** Путь файла внутри открытой папки, если он в ней лежит. */
async function pathInFolder(handle: FileSystemFileHandle): Promise<string | null> {
  const parts = tree.root ? await tree.root.resolve(handle) : null
  return parts ? parts.join('/') : null
}

async function openFileDialog() {
  if (!confirmDiscard()) return
  try {
    const f = await openFile()
    if (f) loadDoc(f.text, f.name, f.handle, f.handle ? await pathInFolder(f.handle) : null)
  } catch (e) {
    toast(`Не удалось открыть: ${(e as Error).message}`)
  }
}

async function save(as = false) {
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
  if (confirmDiscard()) loadDoc('', 'untitled.md', null, null)
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
  // текущий документ мог оказаться внутри новой папки
  doc.path = doc.handle ? await pathInFolder(doc.handle) : null
  tree.setActive(doc.path)
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
  mode = m
  app.dataset.mode = m
  for (const b of document.querySelectorAll<HTMLElement>('#mode-switch button')) b.classList.toggle('on', b.dataset.mode === m)
  store.set('mode', m)
  editor.view.requestMeasure()
  if (m !== 'editor' && previewStale) doRender()
  if (m === 'editor') editor.view.focus()
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

window.addEventListener(
  'keydown',
  (e) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && !e.altKey && k === 's') {
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
    if (!confirmDiscard()) return
    if (handle) {
      const fh = handle as FileSystemFileHandle
      const f = await readHandle(fh)
      loadDoc(f.text, f.name, fh, await pathInFolder(fh))
    } else if (file) {
      loadDoc(await file.text(), file.name, null, null)
    }
  } catch (e) {
    toast(`Не удалось открыть: ${(e as Error).message}`)
  }
})

window.addEventListener('beforeunload', (e) => {
  saveDraftNow()
  // текст в черновике не потеряется, но файл на диске останется старым
  if (doc.dirty && doc.handle) e.preventDefault()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveDraftNow()
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
  editor.view.focus()
}

init()
