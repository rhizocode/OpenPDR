/**
 * OpenPDR Viewer — Canvas Track Map
 *
 * Renders a GPS-derived track layout on a <canvas> element.
 * The track shape is extracted from the last full lap in the recording.
 * A position dot tracks the current video time.
 */

import { lapData, currentRow, interpPrev, interpNext, interpAlpha, telemetryStore, chartZoom, onChartZoomChange, getSyncedTime } from './state'
import { onTelemetryLoad, onFrameTick } from './state'
import { findClosestTimeIndex } from '../shared/telemetry-store'
import { getTrackMapConfig, onTrackMapConfigChange, getBrakeDisplay } from './defaults'
import type { TrackMapColorMode } from './defaults'
import type { TrackLayout } from './types'
import { fetchSatelliteImage } from './satellite-tiles'
import type { SatelliteResult } from './satellite-tiles'

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let cachedLayout: TrackLayout | null = null
let dpr = 1
let hudElement: HTMLElement | null = null

// Offscreen cache for the static track polyline + S/F marker.
// Rebuilt only on telemetry load or canvas resize; per-frame work is just blit + dot.
let trackCache: HTMLCanvasElement | null = null
let trackCacheCtx: CanvasRenderingContext2D | null = null

// Satellite imagery
let satelliteImage: SatelliteResult | null = null
let satelliteFetchInFlight = false
let satelliteBoundsKey = ''   // tracks which bounds we fetched for

// Last drawn dot position — skip redraw when unchanged
let lastDotLat = NaN
let lastDotLon = NaN
let lastZoomRef: typeof chartZoom = null

// ── Track color state ────────────────────────────────────────────────────────

let trackLW = 5               // track line width in device pixels (recomputed on resize)

let speedMax = 160            // auto-scaled max speed in kph
let currentLapStartIdx = 0    // telemetry store index for current lap start
let currentLapEndIdx = 0      // telemetry store index for current lap end
let trackedLapIdx = -1        // which lap index the colored cache was built for

/** Map a 0..1 normalized value to red→yellow→green. */
function valueToColor(t: number): string {
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

function autoScaleStep(value: number): number {
  if (value <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(value)))
  if (value / mag <= 2) return mag / 5
  if (value / mag <= 5) return mag / 2
  return mag
}

function niceMax(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

/** Compute auto-scaled max speed from the telemetry file. */
function computeSpeedMax(): void {
  const store = telemetryStore
  if (!store || store.length === 0) { speedMax = 160; return }
  let max = 0
  for (let i = 0; i < store.length; i++) {
    if (store.speed_kph[i] > max) max = store.speed_kph[i]
  }
  if (max <= 0) { speedMax = 160; return }
  const step = autoScaleStep(max)
  speedMax = niceMax(max, step)
}

/** Detect current lap and update store index range. Returns true if lap changed. */
function updateCurrentLap(): boolean {
  const ld = lapData
  const store = telemetryStore
  if (!ld?.hasLapData || !store || store.length === 0) {
    if (trackedLapIdx !== -1) {
      trackedLapIdx = -1
      currentLapStartIdx = 0
      currentLapEndIdx = store ? store.length - 1 : 0
      return true
    }
    return false
  }

  const t = getSyncedTime()
  let lapIdx = -1

  // Check if currently inside a lap
  for (let i = 0; i < ld.laps.length; i++) {
    if (t >= ld.laps[i].startTime && t < ld.laps[i].endTime) {
      lapIdx = i
      break
    }
  }

  // If between laps, use last completed lap
  if (lapIdx === -1) {
    for (let i = ld.laps.length - 1; i >= 0; i--) {
      if (t >= ld.laps[i].endTime) { lapIdx = i; break }
    }
  }

  // Before any laps started — use first lap
  if (lapIdx === -1 && ld.laps.length > 0) lapIdx = 0

  if (lapIdx === trackedLapIdx) return false
  trackedLapIdx = lapIdx

  if (lapIdx >= 0 && lapIdx < ld.laps.length) {
    const lap = ld.laps[lapIdx]
    currentLapStartIdx = findClosestTimeIndex(store.time, lap.startTime, store.length)
    currentLapEndIdx = findClosestTimeIndex(store.time, lap.endTime, store.length)
  } else {
    currentLapStartIdx = 0
    currentLapEndIdx = store.length - 1
  }
  return true
}

// ── Container sizing ─────────────────────────────────────────────────────────

/** Default CSS area (200 × 160 = 32000 sq px). */
const BASE_AREA = 200 * 160
const MIN_DIM = 100
const MAX_DIM = 260

/** Resize #hud-trackMap to match the track's meter-space aspect ratio. */
function fitContainerToTrack(layout: TrackLayout): void {
  if (!hudElement) return
  const b = layout.bounds
  const latRange = b.maxLat - b.minLat
  const lonRange = b.maxLon - b.minLon
  if (latRange === 0 || lonRange === 0) return

  const cosLat = Math.cos(((b.minLat + b.maxLat) / 2) * (Math.PI / 180))
  const trackW = lonRange * cosLat * 111320
  const trackH = latRange * 111320
  const aspect = trackW / trackH // >1 = wide, <1 = tall

  // Solve: w * h = BASE_AREA and w/h = aspect
  let w = Math.sqrt(BASE_AREA * aspect)
  let h = BASE_AREA / w

  // Clamp
  w = Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(w)))
  h = Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(h)))

  hudElement.style.width = `${w}px`
  hudElement.style.height = `${h}px`
}

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

  // Track line width: ~3% of smaller canvas dimension, min 4 CSS px
  const minDim = Math.min(canvas.width, canvas.height)
  trackLW = Math.max(4 * dpr, Math.round(minDim * 0.03))
}

/** Allocating version — used in non-hot paths (track cache, S/F marker). */
function gpsToCanvas(lat: number, lon: number): { x: number; y: number } | null {
  if (!proj) return null
  const nx = (lon - proj.lonMin) / proj.lonRange
  const ny = 1 - (lat - proj.latMin) / proj.latRange
  return {
    x: proj.padX + nx * proj.drawW,
    y: proj.padY + ny * proj.drawH,
  }
}

/** Pre-allocated output for per-frame gpsToCanvas calls (zero allocation). */
const _canvasXY = { x: 0, y: 0 }
function gpsToCanvasInto(lat: number, lon: number): typeof _canvasXY | null {
  if (!proj) return null
  _canvasXY.x = proj.padX + ((lon - proj.lonMin) / proj.lonRange) * proj.drawW
  _canvasXY.y = proj.padY + (1 - (lat - proj.latMin) / proj.latRange) * proj.drawH
  return _canvasXY
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

// ── Satellite imagery ─────────────────────────────────────────────────────────

/** Compute a cache key for bounds so we don't re-fetch for the same track. */
function boundsKey(b: TrackLayout['bounds']): string {
  return `${b.minLat.toFixed(6)},${b.maxLat.toFixed(6)},${b.minLon.toFixed(6)},${b.maxLon.toFixed(6)}`
}

/** Trigger a satellite fetch if needed. Async — redraws when complete. */
function maybeFetchSatellite(): void {
  if (!cachedLayout) return
  const config = getTrackMapConfig()
  if (config.mapBackground !== 'satellite') return

  const key = boundsKey(cachedLayout.bounds)
  if (satelliteImage && satelliteBoundsKey === key) return  // already fetched
  if (satelliteFetchInFlight) return

  satelliteFetchInFlight = true
  fetchSatelliteImage(cachedLayout.bounds).then(result => {
    satelliteFetchInFlight = false
    if (result) {
      satelliteImage = result
      satelliteBoundsKey = key
      // Redraw with satellite background
      renderTrackCache()
      blitTrack()
      drawZoomHighlight()
      drawPositionDot()
    }
  }).catch(() => {
    satelliteFetchInFlight = false
  })
}

/** Draw satellite image onto the given canvas context, mapped to GPS projection. */
function drawSatelliteBackground(c: CanvasRenderingContext2D): void {
  if (!satelliteImage || !proj) return

  // Map the satellite image's lat/lon bounds to canvas pixel positions
  const topLeft = gpsToCanvas(satelliteImage.maxLat, satelliteImage.minLon)
  const bottomRight = gpsToCanvas(satelliteImage.minLat, satelliteImage.maxLon)
  if (!topLeft || !bottomRight) return

  const dx = topLeft.x
  const dy = topLeft.y
  const dw = bottomRight.x - topLeft.x
  const dh = bottomRight.y - topLeft.y

  c.drawImage(satelliteImage.image, dx, dy, dw, dh)
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

/** Draw the track as individually colored line segments based on telemetry values. */
function drawColoredTrack(c: CanvasRenderingContext2D, mode: TrackMapColorMode): void {
  const store = telemetryStore
  if (!store || store.length === 0) return

  const startIdx = currentLapStartIdx
  const endIdx = currentLapEndIdx
  if (endIdx <= startIdx) return

  c.lineWidth = trackLW
  c.lineCap = 'round'

  let prevX = NaN, prevY = NaN
  for (let i = startIdx; i <= endIdx; i++) {
    if (store.lat[i] === 0 && store.lon[i] === 0) continue
    const px = gpsToCanvas(store.lat[i], store.lon[i])
    if (!px) continue

    if (!isNaN(prevX)) {
      let t: number
      switch (mode) {
        case 'speed':
          t = speedMax > 0 ? store.speed_kph[i] / speedMax : 0
          break
        case 'throttle':
          t = store.throttle[i]
          break
        case 'brake':
          t = 1 - getBrakeDisplay(store.brake[i]) // invert: high brake = red
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

/** Draw a dark border path behind the colored track for satellite contrast. */
function drawColoredTrackBorder(c: CanvasRenderingContext2D): void {
  const store = telemetryStore
  if (!store || store.length === 0) return

  const startIdx = currentLapStartIdx
  const endIdx = currentLapEndIdx
  if (endIdx <= startIdx) return

  c.beginPath()
  c.strokeStyle = 'rgba(0,0,0,0.35)'
  c.lineWidth = trackLW + 2 * dpr
  c.lineJoin = 'round'
  c.lineCap = 'round'

  let first = true
  for (let i = startIdx; i <= endIdx; i++) {
    if (store.lat[i] === 0 && store.lon[i] === 0) continue
    const px = gpsToCanvas(store.lat[i], store.lon[i])
    if (!px) continue
    if (first) { c.moveTo(px.x, px.y); first = false }
    else c.lineTo(px.x, px.y)
  }
  c.stroke()
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
  const config = getTrackMapConfig()
  const hasBg = config.mapBackground !== 'none'

  // Clip to rounded rectangle when a background is drawn
  if (hasBg) {
    const radius = 14 * dpr
    c.save()
    c.beginPath()
    c.roundRect(0, 0, trackCache.width, trackCache.height, radius)
    c.clip()
  }

  // Background layer
  if (config.mapBackground === 'satellite' && satelliteImage) {
    drawSatelliteBackground(c)
  } else if (config.mapBackground === 'solid') {
    c.fillStyle = '#1a1a1a'
    c.fillRect(0, 0, trackCache!.width, trackCache!.height)
  }

  const hasSatBg = config.mapBackground === 'satellite' && !!satelliteImage

  // Draw track (skip when 'none')
  if (config.trackColor !== 'none') {
    // Dark border stroke for contrast on satellite imagery
    if (hasSatBg) {
      if (config.trackColor === 'solid') {
        c.beginPath()
        c.strokeStyle = 'rgba(0,0,0,0.6)'
        c.lineWidth = trackLW + 4 * dpr
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
      } else {
        drawColoredTrackBorder(c)
      }
    }

    if (config.trackColor === 'solid') {
      // Original white polyline
      c.beginPath()
      c.strokeStyle = hasSatBg ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.6)'
      c.lineWidth = trackLW
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
    } else {
      drawColoredTrack(c, config.trackColor)
    }
  }

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

  // Attribution when satellite background is active
  if (hasSatBg) {
    c.save()
    c.font = `${Math.round(9 * dpr)}px sans-serif`
    c.fillStyle = 'rgba(255,255,255,0.5)'
    c.textAlign = 'right'
    c.textBaseline = 'bottom'
    c.fillText('Powered by Esri', trackCache!.width - 4 * dpr, trackCache!.height - 2 * dpr)
    c.restore()
  }

  // Restore the rounded-rect clip
  if (hasBg) {
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

/** Pre-allocated output for currentGps — reused every frame. */
const _gpsOut = { lat: NaN, lon: NaN, spd: 0, throttle: 0, brake: 0 }

/** Interpolated GPS position + telemetry for the current frame (zero allocation). */
function currentGps(): typeof _gpsOut | null {
  if (!currentRow) return null
  if (interpPrev && interpNext && interpPrev !== interpNext) {
    const a = interpAlpha
    _gpsOut.lat = interpPrev.lat + (interpNext.lat - interpPrev.lat) * a
    _gpsOut.lon = interpPrev.lon + (interpNext.lon - interpPrev.lon) * a
    _gpsOut.spd = interpPrev.speed_kph + (interpNext.speed_kph - interpPrev.speed_kph) * a
    _gpsOut.throttle = interpPrev.throttle + (interpNext.throttle - interpPrev.throttle) * a
    _gpsOut.brake = interpPrev.brake + (interpNext.brake - interpPrev.brake) * a
  } else {
    _gpsOut.lat = currentRow.lat
    _gpsOut.lon = currentRow.lon
    _gpsOut.spd = currentRow.speed_kph
    _gpsOut.throttle = currentRow.throttle
    _gpsOut.brake = currentRow.brake
  }
  return _gpsOut
}

function drawPositionDot(gps?: typeof _gpsOut): void {
  if (!cachedLayout) return
  const pos = gps ?? currentGps()
  if (!pos) return

  const px = gpsToCanvasInto(pos.lat, pos.lon)
  if (!px) return

  const config = getTrackMapConfig()
  let fillColor: string

  switch (config.dotColor) {
    case 'solid':
      fillColor = '#ffffff'
      break
    case 'speed': {
      const t = speedMax > 0 ? Math.max(0, pos.spd) / speedMax : 0
      fillColor = valueToColor(t)
      break
    }
    case 'throttle':
      fillColor = valueToColor(pos.throttle)
      break
    case 'brake':
      fillColor = valueToColor(1 - getBrakeDisplay(pos.brake))
      break
    default:
      fillColor = '#ffffff'
  }

  const dotR = Math.max(trackLW * 0.9, 6 * dpr)
  ctx.beginPath()
  ctx.arc(px.x, px.y, dotR, 0, Math.PI * 2)
  ctx.fillStyle = fillColor
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'
  ctx.lineWidth = 3 * dpr
  ctx.stroke()
}

// ── Zoom highlight ────────────────────────────────────────────────────────────

/** Dim the track sections outside the chart zoom window. */
function drawZoomHighlight(): void {
  if (!chartZoom || !telemetryStore || !proj) return
  const store = telemetryStore
  if (store.length === 0) return

  const zoomStart = findClosestTimeIndex(store.time, chartZoom.startTime, store.length)
  const zoomEnd = findClosestTimeIndex(store.time, chartZoom.endTime, store.length)
  if (zoomEnd <= zoomStart) return

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.lineWidth = Math.round(trackLW * 1.6)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Dim segment before zoom window
  if (zoomStart > currentLapStartIdx) {
    ctx.beginPath()
    let first = true
    for (let i = currentLapStartIdx; i <= zoomStart; i++) {
      if (store.lat[i] === 0 && store.lon[i] === 0) continue
      const px = gpsToCanvasInto(store.lat[i], store.lon[i])
      if (!px) continue
      if (first) { ctx.moveTo(px.x, px.y); first = false }
      else ctx.lineTo(px.x, px.y)
    }
    ctx.stroke()
  }

  // Dim segment after zoom window
  if (zoomEnd < currentLapEndIdx) {
    ctx.beginPath()
    let first = true
    for (let i = zoomEnd; i <= currentLapEndIdx; i++) {
      if (store.lat[i] === 0 && store.lon[i] === 0) continue
      const px = gpsToCanvasInto(store.lat[i], store.lon[i])
      if (!px) continue
      if (first) { ctx.moveTo(px.x, px.y); first = false }
      else ctx.lineTo(px.x, px.y)
    }
    ctx.stroke()
  }
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
  hudElement = canvas.closest('#hud-trackMap') as HTMLElement | null
  const c = canvas.getContext('2d')
  if (!c) return
  ctx = c

  resizeCanvas()
  drawEmpty()

  onTelemetryLoad(() => {
    lastDotLat = NaN
    lastDotLon = NaN
    trackedLapIdx = -1
    satelliteImage = null
    satelliteBoundsKey = ''
    const ld = lapData
    if (ld?.hasLapData && ld.trackLayout) {
      cachedLayout = ld.trackLayout
      fitContainerToTrack(cachedLayout)
      resizeCanvas()
      buildProjection(cachedLayout)
      computeSpeedMax()
      updateCurrentLap()
      maybeFetchSatellite()
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

      // Check if lap changed (only matters for colored track mode)
      const tmConfig = getTrackMapConfig()
      if (tmConfig.trackColor !== 'solid') {
        const lapChanged = updateCurrentLap()
        if (lapChanged) renderTrackCache()
      }

      // Skip redraw when position unchanged, no resize, and no zoom change
      const gps = currentGps()
      const lat = gps?.lat ?? NaN
      const lon = gps?.lon ?? NaN
      const zoomChanged = lastZoomRef !== chartZoom
      lastZoomRef = chartZoom
      if (lat === lastDotLat && lon === lastDotLon && !resized && !zoomChanged) return
      lastDotLat = lat
      lastDotLon = lon

      blitTrack()
      drawZoomHighlight()
      drawPositionDot(gps ?? undefined)
    }
  })

  onChartZoomChange(() => {
    if (cachedLayout && proj) {
      blitTrack()
      drawZoomHighlight()
      drawPositionDot()
    }
  })

  // Rebuild track cache when color settings change
  onTrackMapConfigChange(() => {
    if (cachedLayout && proj) {
      maybeFetchSatellite()
      updateCurrentLap()
      renderTrackCache()
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
