import { defineConfig, type Plugin } from 'vite'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PDFJS = fileURLToPath(new URL('./node_modules/pdfjs-dist', import.meta.url))
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

/** Ресурсы pdf.js (cmaps для CJK, стандартные шрифты, wasm-декодеры) по адресу /pdfjs/. */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!PDFJS_DIRS.includes(rel.split('/')[0]) || rel.includes('..')) return next()
        const file = join(PDFJS, rel)
        try {
          if (!statSync(file).isFile()) return next()
        } catch {
          return next()
        }
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const name of readdirSync(join(PDFJS, dir))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(PDFJS, dir, name)) })
        }
      }
    },
  }
}

/**
 * Service worker для работы без сервера: установленное приложение открывается
 * из кэша, даже когда локальный сервер не запущен. Список файлов и версия
 * подставляются при сборке, поэтому каждая сборка обновляет кэш.
 */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const publicFiles = readdirSync(fileURLToPath(new URL('./public', import.meta.url)))
      const files = [...Object.keys(bundle), ...publicFiles].filter((f) => !f.startsWith('pdfjs/') && !f.endsWith('.map') && f !== 'index.html')
      // версия по содержимому: меняется при любой правке, даже если имена файлов те же
      const hash = createHash('sha256')
      for (const f of files.sort()) {
        const item = bundle[f]
        hash.update(f)
        if (item) hash.update(item.type === 'chunk' ? item.code : item.source)
        else hash.update(readFileSync(fileURLToPath(new URL(`./public/${f}`, import.meta.url))))
      }
      const version = hash.digest('hex').slice(0, 12)
      const source = readFileSync(fileURLToPath(new URL('./src/sw.js', import.meta.url)), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(files.map((f) => '/' + f)))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

export default defineConfig({
  build: { target: 'es2022' },
  // es-формат нужен, чтобы языки подсветки в воркере грузились отдельными чанками
  worker: { format: 'es' },
  plugins: [pdfjsAssets(), serviceWorker()],
})
