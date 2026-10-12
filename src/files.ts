// File System Access API (Chrome/Edge) с fallback на <input type=file> и скачивание.

export interface OpenedFile {
  file: File
  handle: FileSystemFileHandle | null
}

type PickerOpts = { types?: { description: string; accept: Record<string, string[]> }[]; suggestedName?: string; excludeAcceptAllOption?: boolean }
interface FSAWindow {
  showOpenFilePicker?: (o?: PickerOpts) => Promise<FileSystemFileHandle[]>
  showSaveFilePicker?: (o?: PickerOpts) => Promise<FileSystemFileHandle>
  showDirectoryPicker?: (o?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}
const w = window as unknown as FSAWindow

const mdTypes = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.txt'] } }]
// один общий фильтр: при нескольких Chrome показывает только первый
const openTypes = [{ description: 'Markdown и PDF', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.txt'], 'application/pdf': ['.pdf'] } }]

export const isPdf = (name: string) => /\.pdf$/i.test(name)

export const canPickDirectory = typeof w.showDirectoryPicker === 'function'

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export async function openFile(): Promise<OpenedFile | null> {
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: openTypes })
      return readHandle(handle)
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.mdown,.txt,.pdf,text/markdown,text/plain,application/pdf'
    input.onchange = () => {
      const f = input.files?.[0]
      resolve(f ? { file: f, handle: null } : null)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export async function readHandle(handle: FileSystemFileHandle): Promise<OpenedFile> {
  return { file: await handle.getFile(), handle }
}

type PermHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}

/** request=false — только проверить, без диалога (вызов вне жеста пользователя). */
export async function ensurePermission(handle: FileSystemHandle, mode: 'read' | 'readwrite', request = true): Promise<boolean> {
  const h = handle as PermHandle
  if (!h.queryPermission) return true
  if ((await h.queryPermission({ mode })) === 'granted') return true
  return request && !!h.requestPermission && (await h.requestPermission({ mode })) === 'granted'
}

export async function writeFile(handle: FileSystemFileHandle, text: string): Promise<boolean> {
  if (!(await ensurePermission(handle, 'readwrite'))) return false
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  return true
}

/** Возвращает новый handle, `null` при отмене, либо `'downloaded'` в fallback-режиме. */
export async function saveFileAs(name: string, text: string): Promise<FileSystemFileHandle | 'downloaded' | null> {
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: mdTypes })
      await writeFile(handle, text)
      return handle
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await w.showDirectoryPicker?.({ mode: 'readwrite' })) ?? null
  } catch (e) {
    if (isAbort(e)) return null
    throw e
  }
}
