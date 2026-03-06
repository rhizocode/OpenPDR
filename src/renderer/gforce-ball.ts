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

// Per-canvas offscreen cache for secondary canvases
const bgCacheMap = new WeakMap<HTMLCanvasElement, { bg: HTMLCanvasElement, w: number, h: number }>()

const MAX_G = 1.5

export function initGForceBall(): void {
  canvas = document.getElementById('gforce-canvas') as HTMLCanvasElement
  const c = canvas.getContext('2d')
  if (!c) return
  ctx = c
}

/** Render static elements into a given context. */
function renderBgCacheToCtx(c: CanvasRenderingContext2D, w: number, h: number): void {
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

/** Rebuild the singleton offscreen cache for the primary canvas. */
function renderBgCache(w: number, h: number): void {
  if (!bgCache) {
    bgCache = document.createElement('canvas')
    bgCacheCtx = bgCache.getContext('2d')!
  }
  bgCache.width = w
  bgCache.height = h
  bgCacheW = w
  bgCacheH = h
  renderBgCacheToCtx(bgCacheCtx!, w, h)
}

export function drawGForce(lat: number, lon: number, targetCanvas?: HTMLCanvasElement): void {
  const c = targetCanvas ?? canvas
  let drawCtx: CanvasRenderingContext2D
  let bg: HTMLCanvasElement | null
  let bgW: number, bgH: number

  if (!targetCanvas) {
    if (!ctx) return
    drawCtx = ctx
    bg = bgCache; bgW = bgCacheW; bgH = bgCacheH
  } else {
    const tc = targetCanvas.getContext('2d')
    if (!tc) return
    drawCtx = tc
    let entry = bgCacheMap.get(targetCanvas)
    if (!entry) {
      entry = { bg: document.createElement('canvas'), w: 0, h: 0 }
      bgCacheMap.set(targetCanvas, entry)
    }
    bg = entry.bg; bgW = entry.w; bgH = entry.h
  }

  const w = c.width
  const h = c.height
  const cx = w / 2
  const cy = h / 2
  const radius = (w / 2) - 8

  // Rebuild background cache if needed
  if (!targetCanvas) {
    if (!bgCache || bgCacheW !== w || bgCacheH !== h) {
      renderBgCache(w, h)
      bg = bgCache
    }
  } else {
    const entry = bgCacheMap.get(targetCanvas)!
    if (bgW !== w || bgH !== h) {
      entry.bg.width = w; entry.bg.height = h
      entry.w = w; entry.h = h
      renderBgCacheToCtx(entry.bg.getContext('2d')!, w, h)
    }
    bg = entry.bg
  }

  drawCtx.clearRect(0, 0, w, h)
  if (bg) drawCtx.drawImage(bg, 0, 0)

  // G-force dot
  const clamp = (v: number) => Math.max(-MAX_G, Math.min(MAX_G, v))
  const dotX = cx + (clamp(lat) / MAX_G) * radius
  const dotY = cy - (clamp(lon) / MAX_G) * radius
  drawCtx.beginPath()
  drawCtx.arc(dotX, dotY, 5, 0, Math.PI * 2)
  drawCtx.fillStyle = '#ff6b00'
  drawCtx.fill()
  drawCtx.strokeStyle = '#fff'
  drawCtx.lineWidth = 1.5
  drawCtx.stroke()
}
