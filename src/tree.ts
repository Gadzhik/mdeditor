// Боковая панель: дерево markdown- и PDF-файлов из открытой папки.

export interface TreeNode {
  name: string
  path: string
  handle: FileSystemFileHandle | FileSystemDirectoryHandle
  children?: TreeNode[]
}

const DOC_RE = /\.(md|markdown|mdown|mkd|pdf)$/i
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__'])
const MAX_DEPTH = 10

async function scan(dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<TreeNode[]> {
  const dirs: Promise<TreeNode | null>[] = []
  const files: TreeNode[] = []
  for await (const h of dir.values()) {
    const path = prefix + h.name
    if (h.kind === 'directory') {
      if (depth >= MAX_DEPTH || h.name.startsWith('.') || SKIP.has(h.name)) continue
      const dh = h as FileSystemDirectoryHandle
      dirs.push(scan(dh, path + '/', depth + 1).then((children) => (children.length ? { name: h.name, path, handle: dh, children } : null)))
    } else if (DOC_RE.test(h.name)) {
      files.push({ name: h.name, path, handle: h as FileSystemFileHandle })
    }
  }
  const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  const subdirs = (await Promise.all(dirs)).filter((d): d is TreeNode => d !== null)
  return [...subdirs.sort(byName), ...files.sort(byName)]
}

export class FileTree {
  root: FileSystemDirectoryHandle | null = null
  private items = new Map<string, HTMLElement>()
  private active: string | null = null
  private nodes = new Map<string, TreeNode>()

  constructor(
    private el: HTMLElement,
    private onOpen: (handle: FileSystemFileHandle, path: string) => void,
  ) {
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
      if (!a) return
      e.preventDefault()
      const node = this.nodes.get(a.dataset.path!)
      if (node) this.onOpen(node.handle as FileSystemFileHandle, node.path)
    })
  }

  async load(root: FileSystemDirectoryHandle) {
    this.root = root
    this.el.textContent = 'Сканирую…'
    const tree = await scan(root, '', 0)
    this.items.clear()
    this.nodes.clear()
    this.el.textContent = ''
    if (!tree.length) {
      this.el.textContent = 'Markdown- и PDF-файлов не найдено'
      return
    }
    this.el.appendChild(this.renderList(tree))
    if (this.active) this.setActive(this.active)
  }

  private renderList(nodes: TreeNode[]): HTMLElement {
    const ul = document.createElement('ul')
    for (const n of nodes) {
      const li = document.createElement('li')
      if (n.children) {
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = n.name
        details.append(summary, this.renderList(n.children))
        li.appendChild(details)
      } else {
        const a = document.createElement('a')
        a.href = '#'
        a.dataset.path = n.path
        a.textContent = n.name.replace(DOC_RE, '')
        if (/\.pdf$/i.test(n.name)) a.dataset.kind = 'pdf'
        a.title = n.path
        this.items.set(n.path, a)
        this.nodes.set(n.path, n)
        li.appendChild(a)
      }
      ul.appendChild(li)
    }
    return ul
  }

  setActive(path: string | null) {
    if (this.active) this.items.get(this.active)?.classList.remove('active')
    this.active = path
    const el = path ? this.items.get(path) : null
    if (!el) return
    el.classList.add('active')
    // раскрыть родительские папки
    for (let p = el.parentElement; p && p !== this.el; p = p.parentElement) {
      if (p instanceof HTMLDetailsElement) p.open = true
    }
    el.scrollIntoView({ block: 'nearest' })
  }

  has(path: string) {
    return this.nodes.has(path)
  }

  open(path: string) {
    const n = this.nodes.get(path)
    if (n) this.onOpen(n.handle as FileSystemFileHandle, n.path)
  }

  clear() {
    this.root = null
    this.items.clear()
    this.nodes.clear()
    this.el.textContent = ''
  }
}

/** Нормализует путь относительно директории файла: 'docs/a.md' + '../img/x.png' → 'img/x.png'. */
export function resolvePath(fromFile: string, rel: string): string | null {
  const clean = decodeURIComponent(rel.split(/[?#]/)[0])
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

export async function getFileByPath(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle | null> {
  const segs = path.split('/')
  try {
    let dir = root
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s)
    return await dir.getFileHandle(segs[segs.length - 1])
  } catch {
    return null
  }
}
