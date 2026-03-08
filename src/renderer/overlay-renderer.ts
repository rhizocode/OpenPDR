/**
 * OpenPDR Viewer — Offscreen overlay frame renderer
 *
 * Renders all HUD overlays for a given telemetry row onto a single transparent
 * canvas at the video's native resolution. Used by the video export pipeline:
 * main process requests frames, renderer draws them here and sends PNG buffers back.
 *
 * Drawing code is extracted from the live HUD modules (rpm-gauge.ts, gforce-ball.ts,
 * track-map.ts, hud.ts) but parameterized to draw at arbitrary positions/scales
 * on a single composite canvas — no DOM references.
 */

import type {
  TelemetryRow, OverlayConfig, OverlayLayout, OverlayPosition,
  OverlayOrigin, RpmConfig, TrackLayout, RenderOverlayRequest, SessionInfo,
  TrackMapExportConfig,
} from './types'
import { telemetryStore } from './state'
import { getRowInto, createEmptyRow } from '../shared/telemetry-store'
import { buildBar, drawRpmBar } from './rpm-bar'
import { buildGauge, drawRpmGauge } from './rpm-gauge'
import { createGForceSvg, drawGForce } from './gforce-ball'
import { createSteeringSvg, drawSteeringSvg } from './steering'
import { DEFAULT_TRACKMAP_CONFIG } from './defaults'
import type { TrackMapConfig } from './defaults'
import {
  buildProjection as buildTrackProjection,
  renderTrackToCanvas, drawPositionDot as drawTrackDot,
  computeSpeedMax,
  type Proj,
} from './track-map-render'
import { fetchSatelliteImage } from './satellite-tiles'
import type { SatelliteResult } from './satellite-tiles'

// ── Constants from existing drawing modules ──

// RPM gauge SVG viewBox (from rpm-gauge.ts)
const RPM_GAUGE_W = 180
const RPM_GAUGE_H = 165

// G-force SVG viewBox
const GFORCE_SIZE = 120

// Steering
const STEERING_ICON_SIZE = 80  // px (from CSS)

// Pedals
const PEDAL_BAR_W = 100
const PEDAL_BAR_H = 16
const PEDAL_GAP = 3

// Gear box
const GEAR_BOX_SIZE = 48

import { resolveGearDisplay, getBrakeDisplay, formatTimestamp } from './defaults'

// ── Shadow helpers ──

/** Apply a canvas shadow matching a CSS text-shadow / drop-shadow. */
function setShadow(
  ctx: CanvasRenderingContext2D,
  blur: number, color: string,
  offX = 0, offY = 0,
): void {
  ctx.shadowColor = color
  ctx.shadowBlur = blur
  ctx.shadowOffsetX = offX
  ctx.shadowOffsetY = offY
}

function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
}

// ── SVG → canvas rasterizer ──

const NS = 'http://www.w3.org/2000/svg'

/** Serialize an SVG element to XML, rasterize via Image, and draw onto canvas. */
async function blitSvg(
  ctx: CanvasRenderingContext2D,
  svg: SVGSVGElement,
  x: number, y: number, w: number, h: number,
): Promise<void> {
  const xml = new XMLSerializer().serializeToString(svg)
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => { resolve() }
    img.onerror = reject
    img.src = url
  })
  ctx.drawImage(img, x, y, w, h)
  URL.revokeObjectURL(url)
}

// RPM bar geometry (from rpm-bar.ts viewBox)
const RPM_BAR_W = 400
const RPM_BAR_H = 36

// ── Export state (created once per export run, released after) ──
let rpmBarSvg: SVGSVGElement | null = null
let rpmGaugeSvg: SVGSVGElement | null = null
let gforceSvg: SVGSVGElement | null = null
let steeringSvg: SVGSVGElement | null = null

// Track map: pre-rendered cache canvas + projection (built once at export start)
let exportTrackCache: HTMLCanvasElement | null = null
let exportTrackProj: Proj | null = null
let exportTrackMapConfig: TrackMapConfig = DEFAULT_TRACKMAP_CONFIG
let exportSpeedMax = 160
let exportTrackLW = 5
let exportTrackDpr = 1

// ── Individual overlay drawing functions ──

function drawSpeed(
  ctx: CanvasRenderingContext2D, row: TelemetryRow,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  // Speed value — CSS: text-shadow: 0 0 10px rgba(0,0,0,0.8), 0 2px 4px rgba(0,0,0,0.6)
  setShadow(ctx, 10, 'rgba(0,0,0,0.8)')
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 56px Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(Math.round(row.speed_mph).toString(), 0, 56)

  // Unit — CSS: text-shadow: 0 0 8px rgba(0,0,0,0.8)
  setShadow(ctx, 8, 'rgba(0,0,0,0.8)')
  const valueWidth = ctx.measureText(Math.round(row.speed_mph).toString()).width
  ctx.fillStyle = '#fff'
  ctx.font = '18px Consolas, monospace'
  ctx.fillText('MPH', valueWidth + 4, 56)
  clearShadow(ctx)

  ctx.restore()
}


function drawGearOverlay(
  ctx: CanvasRenderingContext2D, gearDisplay: string,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  const s = GEAR_BOX_SIZE
  // Background box + border — CSS: border: 2px solid rgba(255,255,255,0.5); border-radius: 8px
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(0, 0, s, s, 8)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 2
  ctx.stroke()

  // Gear text
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 28px Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(gearDisplay, s / 2, s / 2)

  ctx.restore()
}

function drawPedalsOverlay(
  ctx: CanvasRenderingContext2D, throttle: number, brake: number,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  const w = PEDAL_BAR_W, h = PEDAL_BAR_H

  // Throttle bar
  drawPedalBar(ctx, 0, 0, w, h, throttle, '#00cc66', 'THR')

  // Brake bar
  drawPedalBar(ctx, 0, h + PEDAL_GAP, w, h, brake, '#ff3333', 'BRK')

  ctx.restore()
}

function drawPedalBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  value: number, color: string, label: string,
): void {
  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 3)
  ctx.fill()

  // Fill
  const fillW = w * Math.max(0, Math.min(1, value))
  if (fillW > 0) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, y, fillW, h, 3)
    ctx.fill()
  }

  // Label — CSS: text-shadow: 0 0 4px rgba(0,0,0,0.8)
  setShadow(ctx, 4, 'rgba(0,0,0,0.8)')
  ctx.fillStyle = '#ccc'
  ctx.font = '10px Consolas, monospace'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + w - 4, y + h / 2)
  clearShadow(ctx)
}

function drawGpsOverlay(
  ctx: CanvasRenderingContext2D, row: TelemetryRow,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  // Background box
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(0, 0, 100, 50, 4)
  ctx.fill()

  // CSS: text-shadow: 0 0 4px rgba(0,0,0,0.8)
  setShadow(ctx, 4, 'rgba(0,0,0,0.8)')
  ctx.fillStyle = '#aaa'
  ctx.font = '11px Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(row.lat.toFixed(6), 8, 6)
  ctx.fillText(row.lon.toFixed(6), 8, 20)
  ctx.fillText(`${row.altitude_m.toFixed(0)}m`, 8, 34)
  clearShadow(ctx)

  ctx.restore()
}

const SESSION_LINE_H = 14
const SESSION_PAD_X = 10
const SESSION_PAD_Y = 6
const SESSION_LABEL_FONT = 'bold 9px Consolas, monospace'
const SESSION_VALUE_FONT = '11px Consolas, monospace'

function getSessionFields(info: SessionInfo): Array<[string, string]> {
  const fields: Array<[string, string]> = []
  const vehicleParts = [info.year, info.vehicle]
    .filter(Boolean)
    .map(s => s!.replace(/[()]/g, ''))
  if (vehicleParts.length) fields.push(['Vehicle', vehicleParts.join(' ')])
  if (info.engine) fields.push(['Engine', info.engine])
  if (info.timestamp) fields.push(['Date', formatTimestamp(info.timestamp)])
  return fields
}

/** Measure the session overlay box dimensions (unscaled). */
function measureSessionBox(
  ctx: CanvasRenderingContext2D,
  fields: Array<[string, string]>,
): { w: number; h: number } {
  let maxW = 0
  for (const [label, value] of fields) {
    ctx.font = SESSION_LABEL_FONT
    const lw = ctx.measureText(label + ' ').width
    ctx.font = SESSION_VALUE_FONT
    const vw = ctx.measureText(value).width
    if (lw + vw > maxW) maxW = lw + vw
  }
  return {
    w: maxW + SESSION_PAD_X * 2,
    h: fields.length * SESSION_LINE_H + SESSION_PAD_Y * 2,
  }
}

function drawSessionOverlay(
  ctx: CanvasRenderingContext2D,
  fields: Array<[string, string]>,
  boxW: number, boxH: number,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(0, 0, boxW, boxH, 4)
  ctx.fill()

  // Text
  setShadow(ctx, 4, 'rgba(0,0,0,0.8)')
  let ty = SESSION_PAD_Y + 10
  for (const [label, value] of fields) {
    ctx.font = SESSION_LABEL_FONT
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const lw = ctx.measureText(label + ' ').width
    ctx.fillText(label + ' ', SESSION_PAD_X, ty)
    ctx.font = SESSION_VALUE_FONT
    ctx.fillStyle = '#ccc'
    ctx.fillText(value, SESSION_PAD_X + lw, ty)
    ty += SESSION_LINE_H
  }
  clearShadow(ctx)

  ctx.restore()
}

// ── Composite frame renderer ──

/** Track map canvas size — adapts to the track's aspect ratio while preserving
 *  roughly the same area as the original 200×160 default. */
function getTrackMapSize(trackLayout: TrackLayout | null): { w: number; h: number } {
  if (!trackLayout) return { w: 200, h: 160 }
  const b = trackLayout.bounds
  const latRange = b.maxLat - b.minLat
  const lonRange = b.maxLon - b.minLon
  if (latRange === 0 || lonRange === 0) return { w: 200, h: 160 }

  const cosLat = Math.cos(((b.minLat + b.maxLat) / 2) * (Math.PI / 180))
  const trackW = lonRange * cosLat * 111320
  const trackH = latRange * 111320
  const aspect = trackW / trackH

  const area = 200 * 160
  let w = Math.sqrt(area * aspect)
  let h = area / w
  w = Math.max(100, Math.min(260, Math.round(w)))
  h = Math.max(100, Math.min(260, Math.round(h)))
  return { w, h }
}

async function renderOverlayFrame(
  ctx: CanvasRenderingContext2D,
  row: TelemetryRow,
  width: number,
  height: number,
  layout: OverlayLayout,
  config: OverlayConfig,
  rpmConfig: RpmConfig,
  trackLayout: TrackLayout | null,
  gearDisplay: string,
  sessionInfo?: SessionInfo,
): Promise<void> {
  ctx.clearRect(0, 0, width, height)

  // Resolve %-based position to pixel coordinates, adjusting for origin.
  // Draw functions always draw from top-left, so for non-tl origins we
  // offset x/y by the scaled content dimensions.
  const px = (pos: OverlayPosition, contentW: number, contentH: number) => {
    const origin: OverlayOrigin = pos.origin ?? 'tl'
    let x = (pos.left / 100) * width
    let y = (pos.top / 100) * height
    if (origin.includes('r')) x -= contentW * pos.scale
    if (origin.includes('b')) y -= contentH * pos.scale
    return { x, y, s: pos.scale }
  }

  if (config.speed) {
    // Speed: ~120px wide (variable), 60px tall
    const p = px(layout.speed, 120, 60)
    drawSpeed(ctx, row, p.x, p.y, p.s)
  }

  if (config.rpmGauge && rpmGaugeSvg) {
    drawRpmGauge(row.rpm, rpmGaugeSvg, rpmConfig)
    const p = px(layout.rpmGauge, RPM_GAUGE_W, RPM_GAUGE_H)
    await blitSvg(ctx, rpmGaugeSvg, p.x, p.y, RPM_GAUGE_W * p.s, RPM_GAUGE_H * p.s)
  }

  if (config.rpmBar && rpmBarSvg) {
    drawRpmBar(row.rpm, rpmBarSvg, rpmConfig)
    const p = px(layout.rpmBar, RPM_BAR_W, RPM_BAR_H)
    await blitSvg(ctx, rpmBarSvg, p.x, p.y, RPM_BAR_W * p.s, RPM_BAR_H * p.s)
  }

  if (config.gear) {
    const p = px(layout.gear, GEAR_BOX_SIZE, GEAR_BOX_SIZE)
    drawGearOverlay(ctx, gearDisplay, p.x, p.y, p.s)
  }

  if (config.steering && steeringSvg) {
    drawSteeringSvg(row.steering_deg, steeringSvg)
    const p = px(layout.steering, STEERING_ICON_SIZE, STEERING_ICON_SIZE)
    await blitSvg(ctx, steeringSvg, p.x, p.y, STEERING_ICON_SIZE * p.s, STEERING_ICON_SIZE * p.s)
  }

  if (config.gforce && gforceSvg) {
    drawGForce(row.gforce_lat, row.gforce_lon, gforceSvg)
    const p = px(layout.gforce, GFORCE_SIZE, GFORCE_SIZE)
    await blitSvg(ctx, gforceSvg, p.x, p.y, GFORCE_SIZE * p.s, GFORCE_SIZE * p.s)
  }

  if (config.pedals) {
    const p = px(layout.pedals, PEDAL_BAR_W, PEDAL_BAR_H * 2 + PEDAL_GAP)
    drawPedalsOverlay(ctx, row.throttle, getBrakeDisplay(row.brake), p.x, p.y, p.s)
  }

  if (config.gps) {
    const p = px(layout.gps, 100, 50)
    drawGpsOverlay(ctx, row, p.x, p.y, p.s)
  }

  if (config.trackMap && exportTrackCache && exportTrackProj) {
    const mapSize = getTrackMapSize(trackLayout)
    const p = px(layout.trackMap, mapSize.w, mapSize.h)

    ctx.save()
    ctx.translate(p.x, p.y)
    // No ctx.scale — cache is already rendered at display resolution

    // Drop shadow around the track map
    setShadow(ctx, 6, 'rgba(0,0,0,0.7)', 0, 2)

    // Blit the pre-rendered track cache (native size = display size)
    ctx.drawImage(exportTrackCache, 0, 0)
    clearShadow(ctx)

    // Per-frame position dot (uses same coordinate space as cache)
    drawTrackDot(ctx, exportTrackProj, {
      lat: row.lat, lon: row.lon,
      speed: row.speed_kph,
      throttle: row.throttle,
      brake: row.brake,
      dotColor: exportTrackMapConfig.dotColor,
      speedMax: exportSpeedMax,
      trackLW: exportTrackLW,
      dpr: exportTrackDpr,
    })

    ctx.restore()
  }

  if (config.session && sessionInfo) {
    const fields = getSessionFields(sessionInfo)
    if (fields.length > 0) {
      const box = measureSessionBox(ctx, fields)
      const p = px(layout.session, box.w, box.h)
      drawSessionOverlay(ctx, fields, box.w, box.h, p.x, p.y, p.s)
    }
  }
}

// ── Interpolation helpers ──

/** Linearly interpolate the numeric fields used by overlay drawing. */
function lerpRow(a: TelemetryRow, b: TelemetryRow, alpha: number, out: TelemetryRow): void {
  const mix = (va: number, vb: number) => va + (vb - va) * alpha
  out.speed_mph = mix(a.speed_mph, b.speed_mph)
  out.speed_kph = mix(a.speed_kph, b.speed_kph)
  out.rpm = mix(a.rpm, b.rpm)
  out.steering_deg = mix(a.steering_deg, b.steering_deg)
  out.throttle = mix(a.throttle, b.throttle)
  out.brake = mix(a.brake, b.brake)
  out.gforce_lat = mix(a.gforce_lat, b.gforce_lat)
  out.gforce_lon = mix(a.gforce_lon, b.gforce_lon)
  out.lat = a.lat + (b.lat - a.lat) * alpha
  out.lon = a.lon + (b.lon - a.lon) * alpha
  out.altitude_m = mix(a.altitude_m, b.altitude_m)
  // Sparse fields: use lower row
  out.gear = a.gear
}

// ── IPC frame rendering pipeline ──

let isRendering = false

async function handleRenderRequest(request: RenderOverlayRequest): Promise<void> {
  if (isRendering) {
    console.warn('[overlay-renderer] Already rendering, ignoring duplicate request')
    return
  }
  isRendering = true

  const {
    startIdx, endIdx, width, height,
    overlayConfig, overlayLayout, rpmConfig, trackLayout, sessionInfo,
  } = request

  const store = telemetryStore
  if (!store) {
    console.error('[overlay-renderer] No telemetry store available')
    window.pdr.sendOverlayFramesDone()
    isRendering = false
    return
  }

  // Resolve fps/totalFrames — main process provides them for smooth interpolation;
  // fall back to telemetry rate if missing (backwards compat with older main builds)
  const times = store.time
  const startTime = times[startIdx]
  const endTime = times[Math.min(endIdx - 1, store.length - 1)]
  const duration = endTime - startTime

  const fps = request.fps ?? (duration > 0 ? (endIdx - startIdx) / duration : 10)
  const totalFrames = request.totalFrames ?? (endIdx - startIdx)

  console.log(`[overlay-renderer] Render request: ${totalFrames} frames at ${fps.toFixed(1)} fps, idx ${startIdx}..${endIdx}, ${width}x${height}`)

  // Create offscreen canvas at video resolution
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  // Pre-allocate scratch rows for interpolation (no per-frame allocation)
  const rowA = createEmptyRow()
  const rowB = createEmptyRow()
  const lerpedRow = createEmptyRow()
  let lastKnownGear = '-'
  const frameBuffer = new Uint8Array(width * height * 4)

  // Create detached SVG instances for export (serialized → rasterized each frame)
  if (overlayConfig.rpmBar) {
    rpmBarSvg = document.createElementNS(NS, 'svg') as SVGSVGElement
    buildBar(rpmBarSvg, rpmConfig)
  }
  if (overlayConfig.rpmGauge) {
    rpmGaugeSvg = document.createElementNS(NS, 'svg') as SVGSVGElement
    buildGauge(rpmGaugeSvg, rpmConfig)
  }
  if (overlayConfig.gforce) {
    gforceSvg = createGForceSvg()
  }
  if (overlayConfig.steering) {
    steeringSvg = createSteeringSvg()
  }

  // Pre-render the track map cache (background, track line, S/F marker)
  if (overlayConfig.trackMap && trackLayout) {
    const tmCfg = request.trackMapConfig
    exportTrackMapConfig = tmCfg
      ? { dotColor: tmCfg.dotColor, trackColor: tmCfg.trackColor, mapBackground: tmCfg.mapBackground } as TrackMapConfig
      : DEFAULT_TRACKMAP_CONFIG
    exportSpeedMax = store ? computeSpeedMax(store) : 160

    const mapSize = getTrackMapSize(trackLayout)
    // Render cache at display resolution (mapSize × overlay scale) to avoid pixelation
    const trackScale = overlayLayout.trackMap?.scale ?? 1
    const cacheW = Math.round(mapSize.w * trackScale)
    const cacheH = Math.round(mapSize.h * trackScale)

    const cacheCanvas = document.createElement('canvas')
    cacheCanvas.width = cacheW
    cacheCanvas.height = cacheH
    const cacheCtx = cacheCanvas.getContext('2d')!

    // Fetch satellite tiles if needed (async, blocks briefly at export start)
    let satImage: SatelliteResult | null = null
    if (exportTrackMapConfig.mapBackground === 'satellite') {
      try {
        satImage = await fetchSatelliteImage(trackLayout.bounds)
      } catch { /* proceed without satellite */ }
    }

    renderTrackToCanvas(cacheCtx, {
      canvasW: cacheW,
      canvasH: cacheH,
      layout: trackLayout,
      config: exportTrackMapConfig,
      satelliteImage: satImage,
      store,
      startIdx,
      endIdx,
      dpr: trackScale,
    })

    exportTrackCache = cacheCanvas
    exportTrackProj = buildTrackProjection(trackLayout, cacheW, cacheH)
    const minDim = Math.min(cacheW, cacheH)
    exportTrackLW = Math.max(4 * trackScale, Math.round(minDim * 0.03))
    exportTrackDpr = trackScale
  }

  try {
    for (let f = 0; f < totalFrames; f++) {
      const t = startTime + f / fps

      // Binary search for bracketing telemetry rows
      let lo = startIdx, hi = endIdx - 1
      if (t <= times[lo]) {
        hi = lo
      } else if (t >= times[hi]) {
        lo = hi
      } else {
        while (hi - lo > 1) {
          const mid = (lo + hi) >>> 1
          if (times[mid] <= t) lo = mid
          else hi = mid
        }
      }

      // Build the interpolated row
      getRowInto(store, lo, rowA)
      let row: TelemetryRow
      if (lo === hi) {
        row = rowA
      } else {
        getRowInto(store, hi, rowB)
        const span = times[hi] - times[lo]
        const alpha = span > 0 ? (t - times[lo]) / span : 0
        lerpRow(rowA, rowB, alpha, lerpedRow)
        row = lerpedRow
      }

      // Carry-forward gear
      if (row.gear !== undefined) {
        lastKnownGear = resolveGearDisplay(row.gear)
      }

      await renderOverlayFrame(
        ctx, row, width, height,
        overlayLayout, overlayConfig, rpmConfig, trackLayout,
        lastKnownGear, sessionInfo,
      )

      // Extract raw RGBA pixels and copy into pre-allocated buffer to reduce GC pressure
      const pixels = ctx.getImageData(0, 0, width, height)
      frameBuffer.set(pixels.data)
      // invoke-based IPC: await provides backpressure + natural event-loop yield
      await window.pdr.sendOverlayFrameData(f, frameBuffer)
    }
  } catch (err) {
    console.error('[overlay-renderer] Error rendering frame:', err)
  }

  // Release export state
  rpmBarSvg = null
  rpmGaugeSvg = null
  gforceSvg = null
  steeringSvg = null
  exportTrackCache = null
  exportTrackProj = null

  window.pdr.sendOverlayFramesDone()
  isRendering = false
}

export function initOverlayRenderer(): void {
  if (!window.pdr?.onRenderOverlayFrames) return
  window.pdr.onRenderOverlayFrames((request) => {
    handleRenderRequest(request).catch((err) => {
      console.error('[overlay-renderer] Unhandled error:', err)
      window.pdr.sendOverlayFramesDone()
      isRendering = false
    })
  })
}
