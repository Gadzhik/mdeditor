import { EditorView, keymap, drawSelection, highlightActiveLine, dropCursor, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, EditorSelection, StateEffect, StateField, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '700', color: 'var(--c-heading)' },
  { tag: t.heading2, fontSize: '1.25em', fontWeight: '700', color: 'var(--c-heading)' },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: '700', color: 'var(--c-heading)' },
  { tag: t.heading, fontWeight: '700', color: 'var(--c-heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--c-link)' },
  { tag: t.monospace, color: 'var(--c-code)' },
  { tag: t.quote, color: 'var(--c-muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: 'var(--c-muted)' },
  // токены внутри fenced-блоков
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--h-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--h-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--h-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--h-number)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--h-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--h-func)' },
  { tag: [t.tagName, t.attributeName], color: 'var(--h-tag)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '24px 0 50vh', maxWidth: '860px', margin: '0 auto', caretColor: 'var(--c-fg)' },
  '.cm-line': { padding: '0 24px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--c-fg)', borderLeftWidth: '2px' },
  '.cm-activeLine': { backgroundColor: 'var(--c-active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--c-selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--c-selection-match)' },
  '.cm-panels': { backgroundColor: 'var(--c-bg-alt)', color: 'var(--c-fg)', borderColor: 'var(--c-border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--c-search)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--c-search-current)' },
  '.cm-textfield, .cm-button': { background: 'var(--c-bg)', color: 'var(--c-fg)', border: '1px solid var(--c-border)', borderRadius: '4px', backgroundImage: 'none' },
})

/** Ctrl+B / Ctrl+I: обернуть выделение маркером или снять его, если он уже есть. */
function toggleMark(mark: string) {
  return (view: EditorView) => {
    const { state } = view
    const n = mark.length
    view.dispatch(
      state.changeByRange((r) => {
        const before = state.sliceDoc(r.from - n, r.from)
        const after = state.sliceDoc(r.to, r.to + n)
        if (before === mark && after === mark) {
          return {
            changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }],
            range: EditorSelection.range(r.from - n, r.to - n),
          }
        }
        return {
          changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }],
          range: EditorSelection.range(r.from + n, r.to + n),
        }
      }),
    )
    return true
  }
}

// --- Подсветка заметок: диапазоны сдвигаются вместе с правками текста ---

export interface NoteRange {
  id: string
  from: number
  to: number
  title: string
}

const setNotes = StateEffect.define<NoteRange[]>()

const notesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setNotes)) continue
      deco = Decoration.set(
        e.value
          .filter((r) => r.to > r.from)
          .map((r) => Decoration.mark({ class: 'cm-note', attributes: { 'data-note': r.id, title: r.title } }).range(r.from, r.to)),
        true,
      )
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

export interface Editor {
  view: EditorView
  getValue(): string
  setValue(text: string, cursor?: number): void
  cursor(): number
  setCursor(pos: number): void
  setNoteRanges(ranges: NoteRange[]): void
  /** Текущие (с учётом правок) диапазоны заметок. Удалённые целиком сюда не попадают. */
  noteRanges(): { id: string; from: number; to: number }[]
  /** Выделить диапазон и прокрутить к нему. */
  reveal(from: number, to: number): void
}

export function createEditor(parent: HTMLElement, onChange: () => void, onScroll: () => void): Editor {
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(highlight),
    notesField,
    theme,
    keymap.of([
      { key: 'Mod-b', run: toggleMark('**') },
      { key: 'Mod-i', run: toggleMark('*') },
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange()
    }),
    EditorView.domEventHandlers({ scroll: () => void onScroll() }),
  ]

  const makeState = (doc: string, cursor = 0) =>
    EditorState.create({ doc, extensions, selection: { anchor: Math.min(cursor, doc.length) } })

  const view = new EditorView({ state: makeState(''), parent })

  return {
    view,
    getValue: () => view.state.doc.toString(),
    // новое состояние: сбрасывает историю undo при открытии другого файла
    setValue(text, cursor = 0) {
      view.setState(makeState(text, cursor))
      view.scrollDOM.scrollTop = 0
      if (cursor) view.dispatch({ effects: EditorView.scrollIntoView(Math.min(cursor, text.length), { y: 'center' }) })
    },
    cursor: () => view.state.selection.main.head,
    setCursor: (pos) => view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } }),
    setNoteRanges: (ranges) => view.dispatch({ effects: setNotes.of(ranges) }),
    noteRanges() {
      const out: { id: string; from: number; to: number }[] = []
      view.state.field(notesField).between(0, view.state.doc.length, (from, to, d) => {
        out.push({ id: (d.spec.attributes as Record<string, string>)['data-note'], from, to })
      })
      return out
    },
    reveal(from, to) {
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    },
  }
}
