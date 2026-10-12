// Заметки к фрагментам текста: модель, хранение (файл рядом с документом или браузер) и интерфейс.
import { kvDel, kvGet, kvSet } from './storage'
import { ensurePermission } from './files'
import { plain } from './anchor'

/** Прямоугольник на странице PDF в долях её ширины и высоты (не зависит от масштаба). */
export interface PdfRect {
  page: number
  x: number
  y: number
  w: number
  h: number
}

export interface MdAnchor {
  kind: 'md'
  line: number // строка исходника (с 0), подсказка при поиске
  quote: string
  prefix: string
  suffix: string
}

export interface PdfAnchor {
  kind: 'pdf'
  page: number
  quote: string
  rects: PdfRect[]
}

export type Anchor = MdAnchor | PdfAnchor

export interface Note {
  id: string
  text: string
  anchor: Anchor
  created: string
  updated: string
}

// --- Хранение ------------------------------------------------------------------

export interface NotesTarget {
  dir: FileSystemDirectoryHandle | null // папка документа, если она доступна
  fileName: string
  fallbackKey: string // ключ в IndexedDB, когда писать рядом с файлом нельзя
}

interface NotesFile {
  format: 'mdeditor-notes'
  version: 1
  document: string
  savedAt: string
  notes: Note[]
}

export const sidecarName = (fileName: string) => `${fileName}.notes.json`

async function readSidecar(t: NotesTarget): Promise<NotesFile | null> {
  if (!t.dir) return null
  try {
    const fh = await t.dir.getFileHandle(sidecarName(t.fileName))
    const data = JSON.parse(await (await fh.getFile()).text()) as NotesFile
    return data?.format === 'mdeditor-notes' && Array.isArray(data.notes) ? data : null
  } catch {
    return null
  }
}

/** Берём более свежую версию: файл рядом или запасную копию в браузере. */
export async function loadNotes(t: NotesTarget): Promise<Note[]> {
  const [file, local] = await Promise.all([readSidecar(t), kvGet<{ savedAt: string; notes: Note[] }>(t.fallbackKey)])
  if (file && local) return file.savedAt >= local.savedAt ? file.notes : local.notes
  return file?.notes ?? local?.notes ?? []
}

/**
 * interactive=false — сохранение без жеста пользователя: диалог разрешения
 * показать нельзя, поэтому без доступа к папке ничего не пишем.
 */
export async function saveNotes(t: NotesTarget, notes: Note[], interactive: boolean): Promise<'file' | 'browser' | 'skipped'> {
  const savedAt = new Date().toISOString()
  if (t.dir) {
    if (await ensurePermission(t.dir, 'readwrite', interactive)) {
      try {
        const name = sidecarName(t.fileName)
        if (notes.length) {
          const fh = await t.dir.getFileHandle(name, { create: true })
          const w = await fh.createWritable()
          const data: NotesFile = { format: 'mdeditor-notes', version: 1, document: t.fileName, savedAt, notes }
          await w.write(JSON.stringify(data, null, 2))
          await w.close()
        } else {
          await t.dir.removeEntry(name).catch(() => {})
        }
        await kvDel(t.fallbackKey)
        return 'file'
      } catch {
        // упадём в запасной вариант ниже
      }
    } else if (!interactive) return 'skipped'
  }
  if (notes.length) await kvSet(t.fallbackKey, { savedAt, notes })
  else await kvDel(t.fallbackKey)
  return 'browser'
}

// --- Интерфейс -----------------------------------------------------------------

export interface NotesHooks {
  reveal(note: Note): void
  locate(note: Note): { label: string; order: number }
  isOrphan(note: Note): boolean
  /** Список изменён пользователем: сохранить и перерисовать подсветку. */
  changed(notes: Note[]): void
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** Цитата для показа: у markdown без разметки (в привязке хранится кусок исходника). */
const shownQuote = (a: Anchor) => (a.kind === 'md' ? plain(a.quote).text.trim() : a.quote)

/** Экранировать то, что markdown понял бы как разметку (цитаты из PDF бывают с * и _). */
const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>|~])/g, '\\$1').replace(/^(\s*)([#+-]|\d+\.)(\s)/gm, '$1\\$2$3')

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('ru', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export class NotesUI {
  notes: Note[] = []
  private panel = $('notes-panel')
  private list = $('notes-list')
  private where = $('notes-where')
  private count = $('notes-count')
  private pop = $('note-pop')
  private popQuote = $('note-pop-quote')
  private popText = $<HTMLTextAreaElement>('note-pop-text')
  private popDel = $('note-pop-del')
  // открытая в редакторе заметка: существующая (id) или новая (anchor)
  private editing: { id: string | null; anchor: Anchor | null; original: string } | null = null

  constructor(private hooks: NotesHooks) {
    this.list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.note-item')
      const note = item && this.notes.find((n) => n.id === item.dataset.id)
      if (!note) return
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'edit') this.edit(note.id, item.getBoundingClientRect())
      else if (act === 'del') this.remove(note.id)
      else this.hooks.reveal(note)
    })
    $('note-pop-save').onclick = () => this.commit()
    $('note-pop-cancel').onclick = () => this.close()
    this.popDel.onclick = () => {
      if (this.editing?.id && this.remove(this.editing.id)) this.close()
    }
    this.popText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        this.commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
      }
    })
    // клик мимо закрывает редактор, только если ничего не написано
    document.addEventListener('pointerdown', (e) => {
      // нажатие на «＋ Заметка» само открывает редактор и доходит сюда же
      if (!this.editing || this.pop.contains(e.target as Node) || (e.target as Element).closest?.('#note-add')) return
      if (this.popText.value === this.editing.original) this.close()
    })
  }

  set(notes: Note[], where: string) {
    this.close()
    this.notes = notes
    this.where.textContent = where
    this.render()
  }

  get panelOpen() {
    return !this.panel.hidden
  }

  render() {
    this.count.textContent = this.notes.length ? String(this.notes.length) : ''
    this.list.textContent = ''
    if (!this.notes.length) {
      this.list.innerHTML = '<p class="notes-empty">Заметок пока нет. Выделите текст и нажмите «＋ Заметка» или <kbd>Alt+N</kbd>.</p>'
      return
    }
    const sorted = this.notes.map((n) => ({ n, loc: this.hooks.locate(n) })).sort((a, b) => a.loc.order - b.loc.order)
    for (const { n, loc } of sorted) {
      const item = document.createElement('div')
      item.className = 'note-item'
      item.dataset.id = n.id
      const quote = document.createElement('div')
      quote.className = 'note-quote'
      quote.textContent = shownQuote(n.anchor)
      const text = document.createElement('div')
      text.className = 'note-text'
      text.textContent = n.text
      const meta = document.createElement('div')
      meta.className = 'note-meta'
      meta.textContent = `${loc.label} · ${fmtDate(n.updated)}`
      if (this.hooks.isOrphan(n)) {
        item.classList.add('orphan')
        const o = document.createElement('span')
        o.className = 'note-orphan'
        o.textContent = 'фрагмент не найден'
        o.title = 'Текст, к которому относилась заметка, изменён или удалён'
        meta.append(' · ', o)
      }
      const acts = document.createElement('span')
      acts.className = 'note-acts'
      acts.innerHTML = '<button data-act="edit">Изменить</button><button data-act="del">Удалить</button>'
      meta.appendChild(acts)
      item.append(quote)
      if (n.text) item.append(text)
      item.append(meta)
      this.list.appendChild(item)
    }
  }

  /** Все заметки документа в Markdown, в том же порядке, что и в панели. */
  toMarkdown(docName: string): string {
    const sorted = this.notes.map((n) => ({ n, loc: this.hooks.locate(n) })).sort((a, b) => a.loc.order - b.loc.order)
    const count = sorted.length
    const word = count % 10 === 1 && count % 100 !== 11 ? 'заметка' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'заметки' : 'заметок'
    const out = [`# Заметки: ${escapeMd(docName)}`, '', `_${count} ${word}, экспорт ${fmtDate(new Date().toISOString())}_`, '']
    for (const { n, loc } of sorted) {
      out.push(`## ${loc.label}`, '')
      const quote = shownQuote(n.anchor).replace(/\s+/g, ' ').trim()
      out.push(`> ${escapeMd(quote)}`, '')
      if (this.hooks.isOrphan(n)) out.push('_(фрагмент не найден в тексте)_', '')
      // текст заметки — уже markdown, вставляем как есть
      if (n.text) out.push(n.text, '')
      out.push(`<sub>${fmtDate(n.updated)}</sub>`, '')
    }
    return out.join('\n')
  }

  /** Новая заметка к выделенному фрагменту. */
  create(anchor: Anchor, near: DOMRect) {
    this.open({ id: null, anchor, original: '' }, shownQuote(anchor), '', near)
  }

  edit(id: string, near?: DOMRect) {
    const note = this.notes.find((n) => n.id === id)
    if (!note) return
    this.open({ id, anchor: null, original: note.text }, shownQuote(note.anchor), note.text, near ?? this.panel.getBoundingClientRect())
  }

  get isEditing() {
    return this.editing !== null
  }

  private open(editing: NonNullable<NotesUI['editing']>, quote: string, text: string, near: DOMRect) {
    this.editing = editing
    this.popQuote.textContent = quote.length > 300 ? quote.slice(0, 300) + '…' : quote
    this.popText.value = text
    this.popDel.hidden = !editing.id
    this.pop.hidden = false
    // под фрагментом, а если места нет — над ним; по горизонтали в пределах окна
    const w = this.pop.offsetWidth
    const h = this.pop.offsetHeight
    const left = Math.min(Math.max(8, near.left), innerWidth - w - 8)
    const below = near.bottom + 8
    const top = below + h < innerHeight - 8 ? below : Math.max(8, near.top - h - 8)
    this.pop.style.left = `${left}px`
    this.pop.style.top = `${top}px`
    this.popText.focus()
  }

  close() {
    this.editing = null
    this.pop.hidden = true
  }

  private commit() {
    const e = this.editing
    if (!e) return
    const text = this.popText.value.trim()
    const now = new Date().toISOString()
    if (e.id) {
      const note = this.notes.find((n) => n.id === e.id)
      if (note && note.text !== text) Object.assign(note, { text, updated: now })
    } else if (e.anchor) {
      this.notes.push({ id: crypto.randomUUID(), text, anchor: e.anchor, created: now, updated: now })
    }
    this.close()
    this.hooks.changed(this.notes)
  }

  remove(id: string): boolean {
    if (!confirm('Удалить заметку?')) return false
    this.notes = this.notes.filter((n) => n.id !== id)
    this.hooks.changed(this.notes)
    return true
  }
}
