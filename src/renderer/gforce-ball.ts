/**
 * OpenPDR Viewer — G-force ball (canvas)
 *
 * Renders a circular g-force plot with lateral (X) and longitudinal (Y)
 * acceleration. Grid circles at 0.5G and 1.0G increments.
 */

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D

const MAX_G = 1.5

export function initGForceBall(): void {
  canvas = document.getElementById('gforce-canvas') as HTMLCanvasElement
  const c = canvas.getContext('2d')
  if (!c) return
  ctx = c
}

export function drawGForce(lat: number, lon: number): void {
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const cx = w / 2
  const cy = h / 2
  const radius = (w / 2) - 8

  ctx.clearRect(0, 0, w, h)

  // Background circle
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fill()

  // Grid circles
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
  ctx.lineWidth = 1
  for (const g of [0.5, 1.0]) {
    const r = (g / MAX_G) * radius
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Crosshairs
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()

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
