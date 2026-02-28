/**
 * OpenPDR Viewer — Canvas Track Map
 *
 * Renders a GPS-derived track layout on a <canvas> element.
 * The track shape is extracted from the last full lap in the recording.
 * A position dot tracks the current video time.
 */

import { lapData, currentRow, interpPrev, interpNext, interpAlpha } from './state'
import { onTelemetryLoad, onFrameTick } from './state'
import type { TrackLayout } from './types'

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let cachedLayout: TrackLayout | null = null
let dpr = 1

// Offscreen cache for the static track polyline + S/F marker.
// Rebuilt only on telemetry load or canvas resize; per-frame work is just blit + dot.
let trackCache: HTMLCanvasElement | null = null
let trackCacheCtx: CanvasRenderingContext2D | null = null

// Last drawn dot position — skip redraw when unchanged
let lastDotLat = NaN
let lastDotLon = NaN

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the angle perpendicular to the track direction at the S/F point.
 * Finds the closest track segment, derives its heading in canvas space, and
 * returns that heading + 90°.
 */
function computePerpendicularAngle(
  points: Array<{ lat: number; lon: number }>,
  sfLat: number,
  sfLon: number
): number {
  if (points.length < 2) return 0

  // Find the closest point index
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const dlat = points[i].lat - sfLat
    const dlon = points[i].lon - sfLon
    const d = dlat * dlat + dlon * dlon
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }

  // Pick two neighbours to define the track direction at that point
  const i0 = Math.max(0, bestIdx - 1)
  const i1 = Math.min(points.length - 1, bestIdx + 1)
  if (i0 === i1) return 0

  const p0 = gpsToCanvas(points[i0].lat, points[i0].lon)
  const p1 = gpsToCanvas(points[i1].lat, points[i1].lon)
  if (!p0 || !p1) return 0

  const trackAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x)
  return trackAngle + Math.PI / 2 // perpendicular
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function drawEmpty(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.font = '13px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('No laps detected', canvas.width / 2, canvas.height / 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** Render the static track polyline + S/F marker to the offscreen cache. */
function renderTrackCache(): void {
  if (!cachedLayout || !proj) return

  // Create or resize offscreen cache to match the visible canvas
  if (!trackCache) {
    trackCache = document.createElement('canvas')
    trackCacheCtx = trackCache.getContext('2d')!
  }
  trackCache.width = canvas.width
  trackCache.height = canvas.height
  const c = trackCacheCtx!

  const { points, startFinishLat, startFinishLon } = cachedLayout

  // Track polyline — scale by DPR so it looks the same as export at native resolution
  c.beginPath()
  c.strokeStyle = 'rgba(255,255,255,0.6)'
  c.lineWidth = 5 * dpr
  c.lineJoin = 'round'
  c.lineCap = 'round'
  let first = true
  for (const pt of points) {
    const px = gpsToCanvas(pt.lat, pt.lon)
    if (!px) continue
    if (first) { c.moveTo(px.x, px.y); first = false }
    else { c.lineTo(px.x, px.y) }
  }
  c.stroke()

  // Start/finish marker — perpendicular to track direction
  const sfPx = gpsToCanvas(startFinishLat, startFinishLon)
  if (sfPx) {
    const perpAngle = computePerpendicularAngle(points, startFinishLat, startFinishLon)
    const halfLen = 10
    c.save()
    c.strokeStyle = '#fff'
    c.lineWidth = 2.5 * dpr
    c.setLineDash([4 * dpr, 4 * dpr])
    c.beginPath()
    c.moveTo(sfPx.x + Math.cos(perpAngle) * halfLen,
             sfPx.y + Math.sin(perpAngle) * halfLen)
    c.lineTo(sfPx.x - Math.cos(perpAngle) * halfLen,
             sfPx.y - Math.sin(perpAngle) * halfLen)
    c.stroke()
    c.setLineDash([])
    c.restore()
  }
}

/** Blit the cached track background to the visible canvas. */
function blitTrack(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (trackCache && trackCache.width > 0 && trackCache.height > 0) {
    ctx.drawImage(trackCache, 0, 0)
  }
}

function drawPositionDot(): void {
  if (!currentRow || !cachedLayout) return

  // Interpolate GPS position between bracketing telemetry rows for smooth movement
  let lat: number, lon: number, spd: number
  if (interpPrev && interpNext && interpPrev !== interpNext) {
    const a = interpAlpha
    lat = interpPrev.lat + (interpNext.lat - interpPrev.lat) * a
    lon = interpPrev.lon + (interpNext.lon - interpPrev.lon) * a
    spd = interpPrev.speed_kph + (interpNext.speed_kph - interpPrev.speed_kph) * a
  } else {
    lat = currentRow.lat
    lon = currentRow.lon
    spd = currentRow.speed_kph
  }

  const px = gpsToCanvas(lat, lon)
  if (!px) return

  // Colour by speed: green → yellow → red
  spd = Math.max(0, spd)
  let r: number, g: number
  if (spd < 80) {
    r = Math.round((spd / 80) * 255)
    g = 220
  } else {
    r = 255
    g = Math.round(220 * (1 - Math.min((spd - 80) / 80, 1)))
  }

  ctx.beginPath()
  ctx.arc(px.x, px.y, 6 * dpr, 0, Math.PI * 2)
  ctx.fillStyle = `rgb(${r},${g},0)`
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5 * dpr
  ctx.stroke()
}

// ── Resize handling ───────────────────────────────────────────────────────────

function resizeCanvas(): boolean {
  const rect = canvas.getBoundingClientRect()
  dpr = window.devicePixelRatio || 1
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
    lastDotLat = NaN
    lastDotLon = NaN
    const ld = lapData
    if (ld?.hasLapData && ld.trackLayout) {
      cachedLayout = ld.trackLayout
      resizeCanvas()
      buildProjection(cachedLayout)
      renderTrackCache()
      blitTrack()
      drawPositionDot()
    } else {
      cachedLayout = null
      proj = null
      drawEmpty()
    }
  })

  onFrameTick(() => {
    const resized = resizeCanvas()
    if (cachedLayout && proj) {
      if (resized) renderTrackCache()

      // Compute current GPS position to check if dot actually moved
      let lat: number, lon: number
      if (interpPrev && interpNext && interpPrev !== interpNext) {
        const a = interpAlpha
        lat = interpPrev.lat + (interpNext.lat - interpPrev.lat) * a
        lon = interpPrev.lon + (interpNext.lon - interpPrev.lon) * a
      } else if (currentRow) {
        lat = currentRow.lat
        lon = currentRow.lon
      } else {
        lat = NaN
        lon = NaN
      }

      // Skip redraw when position unchanged and no resize
      if (lat === lastDotLat && lon === lastDotLon && !resized) return
      lastDotLat = lat
      lastDotLon = lon

      blitTrack()
      drawPositionDot()
    }
  })

  new ResizeObserver(() => {
    resizeCanvas()
    if (cachedLayout) {
      buildProjection(cachedLayout)
      renderTrackCache()
      blitTrack()
      drawPositionDot()
    } else {
      drawEmpty()
    }
  }).observe(canvas)
}
