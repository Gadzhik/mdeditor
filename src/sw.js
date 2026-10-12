// Service worker MD Editor. Версию и список файлов подставляет плагин в vite.config.ts.
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const CACHE = `mdeditor-${VERSION}`
const RUNTIME = 'mdeditor-runtime' // ресурсы pdf.js: шрифты, cmaps — по мере надобности

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', ...PRECACHE])))
})

// Новая версия включается, когда закрыты все окна старой: иначе открытая страница
// не найдёт свои старые чанки, которые сборка уже удалила.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('mdeditor-') && k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)))),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return

  // страница: сначала сервер (свежая версия), без сервера — из кэша
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()))
          return res
        })
        .catch(() => caches.match('/', { ignoreVary: true })),
    )
    return
  }

  const cacheName = url.pathname.startsWith('/pdfjs/') ? RUNTIME : CACHE
  event.respondWith(
    // ignoreVary: сервер отдаёт «Vary: Origin», а модули запрашиваются с Origin, кэш — без
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) caches.open(cacheName).then((c) => c.put(req, res.clone()))
          return res
        }),
    ),
  )
})
