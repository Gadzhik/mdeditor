// Парсинг markdown в отдельном потоке: на больших документах markdown-it
// тратит сотни миллисекунд, и главный поток не должен этого ждать.
import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import hljs from 'highlight.js/lib/core'

export interface RenderedBlock {
  html: string
  start: number
  end: number
}
export type WorkerRequest = { id: number; text: string }
export type WorkerResponse = { type: 'render'; id: number; blocks: RenderedBlock[] } | { type: 'lang' }

// --- Подсветка кода: языки грузятся лениво при первой встрече -----------------

type LangModule = { default: Parameters<typeof hljs.registerLanguage>[1] }
const langLoaders: Record<string, () => Promise<LangModule>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  json: () => import('highlight.js/lib/languages/json'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  xml: () => import('highlight.js/lib/languages/xml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  swift: () => import('highlight.js/lib/languages/swift'),
  lua: () => import('highlight.js/lib/languages/lua'),
  sql: () => import('highlight.js/lib/languages/sql'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
}
const langAliases: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  html: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', yml: 'yaml', rs: 'rust', golang: 'go',
  kt: 'kotlin', h: 'c', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby',
  patch: 'diff', docker: 'dockerfile', toml: 'ini', conf: 'ini', make: 'makefile', jsonc: 'json',
}
const langState = new Map<string, 'loading' | 'ready' | 'failed'>()
const onLanguageLoaded = () => postMessage({ type: 'lang' } satisfies WorkerResponse)

function highlightCode(code: string, info: string): string {
  const name = langAliases[info.toLowerCase()] ?? info.toLowerCase()
  const loader = langLoaders[name]
  if (!loader) return ''
  const state = langState.get(name)
  if (state === 'ready') return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  if (!state) {
    langState.set(name, 'loading')
    loader().then(
      (m) => {
        hljs.registerLanguage(name, m.default)
        langState.set(name, 'ready')
        onLanguageLoaded()
      },
      () => langState.set(name, 'failed'),
    )
  }
  return ''
}

// --- Markdown ------------------------------------------------------------------

const md = new MarkdownIt({ html: true, linkify: true, highlight: highlightCode }).use(taskLists)

/** Делит поток токенов на верхнеуровневые блоки (абзац, список, таблица...). */
function splitBlocks(tokens: Token[]): Token[][] {
  const out: Token[][] = []
  let i = 0
  while (i < tokens.length) {
    let j = i
    if (tokens[i].nesting === 1) {
      let depth = 0
      for (; j < tokens.length; j++) {
        depth += tokens[j].nesting
        if (depth === 0) break
      }
    }
    out.push(tokens.slice(i, j + 1))
    i = j + 1
  }
  return out
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const env = {}
  const tokens = md.parse(e.data.text, env)
  const blocks = splitBlocks(tokens).map((toks) => ({
    html: md.renderer.render(toks, md.options, env),
    start: toks[0].map?.[0] ?? 0,
    end: toks[0].map?.[1] ?? 0,
  }))
  postMessage({ type: 'render', id: e.data.id, blocks } satisfies WorkerResponse)
}
