import { defineConfig, type Plugin } from 'vite'
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

export default defineConfig({
  build: { target: 'es2022' },
  // es-формат нужен, чтобы языки подсветки в воркере грузились отдельными чанками
  worker: { format: 'es' },
  plugins: [pdfjsAssets()],
})
