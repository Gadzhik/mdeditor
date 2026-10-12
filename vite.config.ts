import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022' },
  // es-формат нужен, чтобы языки подсветки в воркере грузились отдельными чанками
  worker: { format: 'es' },
})
