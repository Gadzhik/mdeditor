// Минимальная key-value обёртка над IndexedDB (хранит строки и FileSystemHandle'ы).
let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('mdeditor', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction('kv', mode).objectStore('kv'))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const kvGet = <T>(key: string): Promise<T | undefined> => tx<T | undefined>('readonly', (s) => s.get(key)).catch(() => undefined)
export const kvSet = (key: string, value: unknown): Promise<void> => tx<void>('readwrite', (s) => s.put(value, key)).catch(() => {})
export const kvDel = (key: string): Promise<void> => tx<void>('readwrite', (s) => s.delete(key)).catch(() => {})

export interface Draft {
  text: string
  name: string
  path: string | null
  cursor: number
  dirty: boolean
  handle: FileSystemFileHandle | null
}
