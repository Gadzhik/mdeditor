type Theme = 'auto' | 'light' | 'dark'
const order: Theme[] = ['auto', 'light', 'dark']
const labels: Record<Theme, string> = { auto: '◐ Авто', light: '☀ Светлая', dark: '☾ Тёмная' }

function load(): Theme {
  try {
    const v = localStorage.getItem('theme') as Theme | null
    return v && order.includes(v) ? v : 'auto'
  } catch {
    return 'auto'
  }
}

function apply(theme: Theme, btn: HTMLElement) {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  btn.textContent = labels[theme]
}

export function initTheme(btn: HTMLElement) {
  let theme = load()
  apply(theme, btn)
  btn.addEventListener('click', () => {
    theme = order[(order.indexOf(theme) + 1) % order.length]
    apply(theme, btn)
    try {
      localStorage.setItem('theme', theme)
    } catch {}
  })
}
