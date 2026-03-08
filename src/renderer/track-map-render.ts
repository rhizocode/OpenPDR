/**
 * OpenPDR Viewer — Shared track map rendering functions
 *
 * Pure, stateless geometry and drawing functions used by both the live
 * track map (track-map.ts) and the video export overlay renderer
 * (overlay-renderer.ts). No DOM references or module-level state.
 */

import type { TrackLayout } from './types'
import type { TrackMapConfig } from './defaults'
import type { SatelliteResult } from './satellite-tiles'
import type { TelemetryStore } from '../shared/telemetry-store'
import { getBrakeDisplay } from './defaults'

// ── Projection ────────────────────────────────────────────────────────────────

export interface Proj {
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

export function buildProjection(layout: TrackLayout, canvasW: number, canvasH: number): Proj | null {
  const b = layout.bounds
  const latRange = b.maxLat - b.minLat
  const lonRange = b.maxLon - b.minLon
  if (latRange === 0 || lonRange === 0) return null

  const cosLat = Math.cos(((b.minLat + b.maxLat) / 2) * (Math.PI / 180))
  const mPerDegLat = 111320
  const mPerDegLon = cosLat * 111320

  const totalW = lonRange * mPerDegLon
  const totalH = latRange * mPerDegLat

  const pad = Math.min(canvasW, canvasH) * 0.08
  const availW = canvasW - 2 * pad
  const availH = canvasH - 2 * pad

  const scale = Math.min(availW / totalW, availH / totalH)
  const drawW = totalW * scale
  const drawH = totalH * scale

  return {
    padX: pad + (availW - drawW) / 2,
    padY: pad + (availH - drawH) / 2,
    drawW, drawH,
    latMin: b.minLat, latRange,
    lonMin: b.minLon, lonRange,
    cosLat,
  }
}

export function gpsToCanvas(proj: Proj, lat: number, lon: number): { x: number; y: number } {
  const nx = (lon - proj.lonMin) / proj.lonRange
  const ny = 1 - (lat - proj.latMin) / proj.latRange
  return { x: proj.padX + nx * proj.drawW, y: proj.padY + ny * proj.drawH }
}

export function computePerpendicularAngle(
  proj: Proj,
  points: Array<{ lat: number; lon: number }>,
  sfLat: number, sfLon: number,
): number {
  if (points.length < 2) return 0
  let bestIdx = 0, bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const dlat = points[i].lat - sfLat, dlon = points[i].lon - sfLon
    const d = dlat * dlat + dlon * dlon
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  const i0 = Math.max(0, bestIdx - 1)
  const i1 = Math.min(points.length - 1, bestIdx + 1)
  if (i0 === i1) return 0
  const p0 = gpsToCanvas(proj, points[i0].lat, points[i0].lon)
  const p1 = gpsToCanvas(proj, points[i1].lat, points[i1].lon)
  return Math.atan2(p1.y - p0.y, p1.x - p0.x) + Math.PI / 2
}

// ── Color helpers ─────────────────────────────────────────────────────────────

/** Map a 0..1 normalized value to red → yellow → green. */
export function valueToColor(t: number): string {
  t = Math.max(0, Math.min(1, t))
  let r: number, g: number
  if (t < 0.5) {
    r = 255
    g = Math.round((t / 0.5) * 220)
  } else {
    r = Math.round(255 * (1 - (t - 0.5) / 0.5))
    g = 220
  }
  return `rgb(${r},${g},0)`
}

// ── Track cache rendering ─────────────────────────────────────────────────────

export interface TrackRenderOptions {
  canvasW: number
  canvasH: number
  layout: TrackLayout
  config: TrackMapConfig
  satelliteImage: SatelliteResult | null
  store: TelemetryStore | null
  startIdx: number
  endIdx: number
  dpr: number
}

/**
 * Render the complete track map cache (background, track line, S/F marker,
 * attribution) onto the provided canvas context. This is the shared core
 * used by both live display and export.
 */
export function renderTrackToCanvas(c: CanvasRenderingContext2D, opts: TrackRenderOptions): void {
  const proj = buildProjection(opts.layout, opts.canvasW, opts.canvasH)
  if (!proj) return

  const { points, startFinishLat, startFinishLon } = opts.layout
  const config = opts.config
  const hasBg = config.mapBackground !== 'none'
  const dpr = opts.dpr

  // Track line width: ~3% of smaller canvas dimension, min 4 CSS px
  const minDim = Math.min(opts.canvasW, opts.canvasH)
  const trackLW = Math.max(4 * dpr, Math.round(minDim * 0.03))

  // Clip to rounded rectangle when a background is drawn
  if (hasBg) {
    const radius = 14 * dpr
    c.save()
    c.beginPath()
    c.roundRect(0, 0, opts.canvasW, opts.canvasH, radius)
    c.clip()
  }

  // Background layer
  if (config.mapBackground === 'satellite' && opts.satelliteImage) {
    drawSatelliteBg(c, proj, opts.satelliteImage)
  } else if (config.mapBackground === 'solid') {
    c.fillStyle = '#1a1a1a'
    c.fillRect(0, 0, opts.canvasW, opts.canvasH)
  }

  const hasSatBg = config.mapBackground === 'satellite' && !!opts.satelliteImage

  // Draw track (skip when 'none')
  if (config.trackColor !== 'none') {
    if (hasSatBg) {
      if (config.trackColor === 'solid') {
        drawSolidTrackBorder(c, proj, points, trackLW + 4 * dpr, 'rgba(0,0,0,0.6)')
      } else {
        drawColoredTrackBorder(c, proj, opts, trackLW + 2 * dpr)
      }
    }

    if (config.trackColor === 'solid') {
      const color = hasSatBg ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.6)'
      drawSolidTrack(c, proj, points, trackLW, color)
    } else {
      drawColoredTrack(c, proj, opts, trackLW)
    }
  }

  // Start/finish marker — perpendicular to track direction
  const sfPx = gpsToCanvas(proj, startFinishLat, startFinishLon)
  const perpAngle = computePerpendicularAngle(proj, points, startFinishLat, startFinishLon)
  const halfLen = 10
  c.save()
  c.strokeStyle = '#fff'
  c.lineWidth = 2.5 * dpr
  c.setLineDash([4 * dpr, 4 * dpr])
  c.beginPath()
  c.moveTo(sfPx.x + Math.cos(perpAngle) * halfLen, sfPx.y + Math.sin(perpAngle) * halfLen)
  c.lineTo(sfPx.x - Math.cos(perpAngle) * halfLen, sfPx.y - Math.sin(perpAngle) * halfLen)
  c.stroke()
  c.setLineDash([])
  c.restore()

  // Attribution when satellite background is active
  if (hasSatBg) {
    c.save()
    c.font = `${Math.round(9 * dpr)}px sans-serif`
    c.fillStyle = 'rgba(255,255,255,0.5)'
    c.textAlign = 'right'
    c.textBaseline = 'bottom'
    c.fillText('Powered by Esri', opts.canvasW - 4 * dpr, opts.canvasH - 2 * dpr)
    c.restore()
  }

  // Restore the rounded-rect clip
  if (hasBg) {
    c.restore()
  }
}

// ── Position dot ──────────────────────────────────────────────────────────────

export interface PositionDotOptions {
  lat: number
  lon: number
  speed: number
  throttle: number
  brake: number
  dotColor: TrackMapConfig['dotColor']
  speedMax: number
  trackLW: number
  dpr: number
}

/**
 * Draw the current-position dot on the track map.
 * Called per-frame after blitting the cached track.
 */
export function drawPositionDot(
  c: CanvasRenderingContext2D,
  proj: Proj,
  opts: PositionDotOptions,
): void {
  const px = gpsToCanvas(proj, opts.lat, opts.lon)

  let fillColor: string
  switch (opts.dotColor) {
    case 'solid':
      fillColor = '#ffffff'
      break
    case 'speed': {
      const t = opts.speedMax > 0 ? Math.max(0, opts.speed) / opts.speedMax : 0
      fillColor = valueToColor(t)
      break
    }
    case 'throttle':
      fillColor = valueToColor(opts.throttle)
      break
    case 'brake':
      fillColor = valueToColor(1 - getBrakeDisplay(opts.brake))
      break
    default:
      fillColor = '#ffffff'
  }

  const dotR = Math.max(opts.trackLW * 0.9, 6 * opts.dpr)
  c.beginPath()
  c.arc(px.x, px.y, dotR, 0, Math.PI * 2)
  c.fillStyle = fillColor
  c.fill()
  c.strokeStyle = 'rgba(0,0,0,0.5)'
  c.lineWidth = 3 * opts.dpr
  c.stroke()
}

// ── Speed max calculation ─────────────────────────────────────────────────────

/** Compute auto-scaled max speed from the telemetry store. */
export function computeSpeedMax(store: TelemetryStore): number {
  if (store.length === 0) return 160
  let max = 0
  for (let i = 0; i < store.length; i++) {
    if (store.speed_kph[i] > max) max = store.speed_kph[i]
  }
  if (max <= 0) return 160
  const mag = Math.pow(10, Math.floor(Math.log10(max)))
  let step: number
  if (max / mag <= 2) step = mag / 5
  else if (max / mag <= 5) step = mag / 2
  else step = mag
  return Math.ceil(max / step) * step
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function drawSatelliteBg(
  c: CanvasRenderingContext2D,
  proj: Proj,
  sat: SatelliteResult,
): void {
  const topLeft = gpsToCanvas(proj, sat.maxLat, sat.minLon)
  const bottomRight = gpsToCanvas(proj, sat.minLat, sat.maxLon)
  c.drawImage(sat.image, topLeft.x, topLeft.y,
    bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
}

function drawSolidTrack(
  c: CanvasRenderingContext2D,
  proj: Proj,
  points: Array<{ lat: number; lon: number }>,
  lineWidth: number,
  color: string,
): void {
  c.beginPath()
  c.strokeStyle = color
  c.lineWidth = lineWidth
  c.lineJoin = 'round'
  c.lineCap = 'round'
  let first = true
  for (const pt of points) {
    const px = gpsToCanvas(proj, pt.lat, pt.lon)
    if (first) { c.moveTo(px.x, px.y); first = false }
    else c.lineTo(px.x, px.y)
  }
  c.stroke()
}

function drawSolidTrackBorder(
  c: CanvasRenderingContext2D,
  proj: Proj,
  points: Array<{ lat: number; lon: number }>,
  lineWidth: number,
  color: string,
): void {
  drawSolidTrack(c, proj, points, lineWidth, color)
}

function drawColoredTrack(
  c: CanvasRenderingContext2D,
  proj: Proj,
  opts: TrackRenderOptions,
  trackLW: number,
): void {
  const store = opts.store
  if (!store || store.length === 0) return
  if (opts.endIdx <= opts.startIdx) return

  const speedMax = computeSpeedMax(store)

  c.lineWidth = trackLW
  c.lineCap = 'round'

  let prevX = NaN, prevY = NaN
  for (let i = opts.startIdx; i <= opts.endIdx; i++) {
    if (store.lat[i] === 0 && store.lon[i] === 0) continue
    const px = gpsToCanvas(proj, store.lat[i], store.lon[i])

    if (!isNaN(prevX)) {
      let t: number
      switch (opts.config.trackColor) {
        case 'speed':
          t = speedMax > 0 ? store.speed_kph[i] / speedMax : 0
          break
        case 'throttle':
          t = store.throttle[i]
          break
        case 'brake':
          t = 1 - getBrakeDisplay(store.brake[i])
          break
        default:
          t = 0
      }
      c.beginPath()
      c.strokeStyle = valueToColor(t)
      c.moveTo(prevX, prevY)
      c.lineTo(px.x, px.y)
      c.stroke()
    }
    prevX = px.x
    prevY = px.y
  }
}

function drawColoredTrackBorder(
  c: CanvasRenderingContext2D,
  proj: Proj,
  opts: TrackRenderOptions,
  borderLW: number,
): void {
  const store = opts.store
  if (!store || store.length === 0) return
  if (opts.endIdx <= opts.startIdx) return

  c.beginPath()
  c.strokeStyle = 'rgba(0,0,0,0.35)'
  c.lineWidth = borderLW
  c.lineJoin = 'round'
  c.lineCap = 'round'

  let first = true
  for (let i = opts.startIdx; i <= opts.endIdx; i++) {
    if (store.lat[i] === 0 && store.lon[i] === 0) continue
    const px = gpsToCanvas(proj, store.lat[i], store.lon[i])
    if (first) { c.moveTo(px.x, px.y); first = false }
    else c.lineTo(px.x, px.y)
  }
  c.stroke()
}
