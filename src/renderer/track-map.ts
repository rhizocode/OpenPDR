/**
 * OpenPDR Viewer — Canvas Track Map
 *
 * Renders a GPS-derived track layout on a <canvas> element.
 * The track shape is extracted from the last full lap in the recording.
 * A position dot tracks the current video time.
 */

import { lapData, currentRow } from './state'
import { onTelemetryLoad, onFrameTick } from './state'
import type { TrackLayout } from './types'

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let cachedLayout: TrackLayout | null = null

// ── Projection ────────────────────────────────────────────────────────────────

interface Proj {
  padX: number
  padY: number
  drawW: number
  drawH: number
  latMin: number
  latRange: number
  lonMin: number
  lonRange: number
  cosLat: number
}

let proj: Proj | null = null

function buildProjection(layout: TrackLayout): void {
  const b = layout.bounds
  const latRange = b.maxLat - b.minLat
  const lonRange = b.maxLon - b.minLon
  if (latRange === 0 || lonRange === 0) { proj = null; return }

  const cosLat = Math.cos(((b.minLat + b.maxLat) / 2) * (Math.PI / 180))
  const mPerDegLat = 111320
  const mPerDegLon = cosLat * 111320

  const totalW = lonRange * mPerDegLon
  const totalH = latRange * mPerDegLat

  const pad = Math.min(canvas.width, canvas.height) * 0.08
  const availW = canvas.width - 2 * pad
  const availH = canvas.height - 2 * pad

  const scale = Math.min(availW / totalW, availH / totalH)
  const drawW = totalW * scale
  const drawH = totalH * scale

  proj = {
    padX: pad + (availW - drawW) / 2,
    padY: pad + (availH - drawH) / 2,
    drawW,
    drawH,
    latMin: b.minLat,
    latRange,
    lonMin: b.minLon,
    lonRange,
    cosLat,
  }
}

function gpsToCanvas(lat: number, lon: number): { x: number; y: number } | null {
  if (!proj) return null
  const nx = (lon - proj.lonMin) / proj.lonRange
  const ny = 1 - (lat - proj.latMin) / proj.latRange
  return {
    x: proj.padX + nx * proj.drawW,
    y: proj.padY + ny * proj.drawH,
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function drawEmpty(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#555'
  ctx.font = '13px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('No laps detected', canvas.width / 2, canvas.height / 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawTrack(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (!cachedLayout || !proj) { drawEmpty(); return }

  const { points, startFinishLat, startFinishLon } = cachedLayout

  // Track polyline
  ctx.beginPath()
  ctx.strokeStyle = '#555'
  ctx.lineWidth = 5
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  let first = true
  for (const pt of points) {
    const px = gpsToCanvas(pt.lat, pt.lon)
    if (!px) continue
    if (first) { ctx.moveTo(px.x, px.y); first = false }
    else { ctx.lineTo(px.x, px.y) }
  }
  ctx.stroke()

  // Start/finish marker
  const sfPx = gpsToCanvas(startFinishLat, startFinishLon)
  if (sfPx) {
    ctx.save()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(sfPx.x - 8, sfPx.y - 8)
    ctx.lineTo(sfPx.x + 8, sfPx.y + 8)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    ctx.fillStyle = '#aaa'
    ctx.font = '10px monospace'
    ctx.fillText('S/F', sfPx.x + 11, sfPx.y + 4)
  }
}

function drawPositionDot(): void {
  if (!currentRow || !cachedLayout) return
  const px = gpsToCanvas(currentRow.lat, currentRow.lon)
  if (!px) return

  // Colour by speed: green → yellow → red
  const spd = Math.max(0, currentRow.speed_kph)
  let r: number, g: number
  if (spd < 80) {
    r = Math.round((spd / 80) * 255)
    g = 220
  } else {
    r = 255
    g = Math.round(220 * (1 - Math.min((spd - 80) / 80, 1)))
  }

  ctx.beginPath()
  ctx.arc(px.x, px.y, 6, 0, Math.PI * 2)
  ctx.fillStyle = `rgb(${r},${g},0)`
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.stroke()
}

// ── Resize handling ───────────────────────────────────────────────────────────

function resizeCanvas(): boolean {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(rect.width * dpr)
  const h = Math.round(rect.height * dpr)
  if (canvas.width === w && canvas.height === h) return false
  canvas.width = w
  canvas.height = h
  if (cachedLayout) buildProjection(cachedLayout)
  return true
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initTrackMap(el: HTMLCanvasElement): void {
  canvas = el
  const c = canvas.getContext('2d')
  if (!c) return
  ctx = c

  resizeCanvas()
  drawEmpty()

  onTelemetryLoad(() => {
    const ld = lapData
    if (ld?.hasLapData && ld.trackLayout) {
      cachedLayout = ld.trackLayout
      resizeCanvas()
      buildProjection(cachedLayout)
      drawTrack()
    } else {
      cachedLayout = null
      proj = null
      drawEmpty()
    }
  })

  onFrameTick(() => {
    const resized = resizeCanvas()
    if (cachedLayout && proj) {
      if (resized) drawTrack()
      else {
        // Redraw track then overlay dot (cheap — canvas is small)
        drawTrack()
        drawPositionDot()
      }
    }
  })

  new ResizeObserver(() => {
    resizeCanvas()
    if (cachedLayout) { buildProjection(cachedLayout); drawTrack() }
    else drawEmpty()
  }).observe(canvas)
}
