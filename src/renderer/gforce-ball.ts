/**
 * OpenPDR Viewer — G-force ball (canvas)
 *
 * Renders a circular g-force plot with lateral (X) and longitudinal (Y)
 * acceleration. Grid circles at 0.5G and 1.0G increments.
 */

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D

// Offscreen cache for static elements (background circle, grid, crosshairs)
let bgCache: HTMLCanvasElement | null = null
let bgCacheCtx: CanvasRenderingContext2D | null = null
let bgCacheW = 0
let bgCacheH = 0

const MAX_G = 1.5

export function initGForceBall(): void {
  canvas = document.getElementById('gforce-canvas') as HTMLCanvasElement
  const c = canvas.getContext('2d')
  if (!c) return
  ctx = c
}

/** Render static elements (background circle, grid circles, crosshairs) to offscreen cache. */
function renderBgCache(w: number, h: number): void {
  if (!bgCache) {
    bgCache = document.createElement('canvas')
    bgCacheCtx = bgCache.getContext('2d')!
  }
  bgCache.width = w
  bgCache.height = h
  bgCacheW = w
  bgCacheH = h
  const c = bgCacheCtx!

  const cx = w / 2
  const cy = h / 2
  const radius = (w / 2) - 8

  // Background circle
  c.beginPath()
  c.arc(cx, cy, radius, 0, Math.PI * 2)
  c.fillStyle = 'rgba(0, 0, 0, 0.4)'
  c.fill()

  // Grid circles
  c.strokeStyle = 'rgba(255, 255, 255, 0.15)'
  c.lineWidth = 1
  for (const g of [0.5, 1.0]) {
    const r = (g / MAX_G) * radius
    c.beginPath()
    c.arc(cx, cy, r, 0, Math.PI * 2)
    c.stroke()
  }

  // Crosshairs
  c.beginPath()
  c.moveTo(cx - radius, cy)
  c.lineTo(cx + radius, cy)
  c.moveTo(cx, cy - radius)
  c.lineTo(cx, cy + radius)
  c.stroke()
}

export function drawGForce(lat: number, lon: number): void {
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const cx = w / 2
  const cy = h / 2
  const radius = (w / 2) - 8

  // Rebuild background cache if needed (canvas resize)
  if (!bgCache || bgCacheW !== w || bgCacheH !== h) {
    renderBgCache(w, h)
  }

  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bgCache!, 0, 0)

  // G-force dot
  const clamp = (v: number) => Math.max(-MAX_G, Math.min(MAX_G, v))
  const dotX = cx + (clamp(lat) / MAX_G) * radius
  const dotY = cy - (clamp(lon) / MAX_G) * radius
  ctx.beginPath()
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2)
  ctx.fillStyle = '#ff6b00'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.stroke()
}
