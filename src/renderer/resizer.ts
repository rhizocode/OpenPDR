/**
 * OpenPDR Viewer — Panel resize handle
 *
 * Drag handle between video and chart panel. Uses pointer events
 * for touch/PWA compatibility.
 */

const STORAGE_KEY = 'pdr-chart-height'
const MIN_HEIGHT = 80
const MAX_RATIO = 0.6

export function initResizer(): void {
  const handle = document.getElementById('resize-handle') as HTMLDivElement
  const chartPanel = document.getElementById('chart-panel') as HTMLDivElement
  const mainContent = document.getElementById('main-content') as HTMLDivElement

  let dragging = false
  let startY = 0
  let startHeight = 0

  handle.addEventListener('pointerdown', (e) => {
    dragging = true
    startY = e.clientY
    startHeight = chartPanel.offsetHeight
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    e.preventDefault()
  })

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const delta = startY - e.clientY // drag up = bigger chart
    const maxH = mainContent.offsetHeight * MAX_RATIO
    const newH = Math.max(MIN_HEIGHT, Math.min(maxH, startHeight + delta))
    chartPanel.style.height = `${newH}px`
  })

  handle.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false
      handle.classList.remove('dragging')
      localStorage.setItem(STORAGE_KEY, chartPanel.style.height)
    }
  })

  // Restore saved height
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) chartPanel.style.height = saved
  else chartPanel.style.height = '200px'
}

/** Show the resize handle and chart panel (call after file loads) */
export function showChartPanel(): void {
  document.getElementById('resize-handle')!.classList.add('active')
  document.getElementById('chart-panel')!.classList.add('active')
  document.getElementById('chart-empty')?.classList.remove('hidden')
}
