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
  RpmConfig, TrackLayout, RenderOverlayRequest, SessionInfo,
} from './types'
import { telemetryStore } from './state'
import { getRowInto, createEmptyRow } from '../shared/telemetry-store'

// ── Steering wheel SVG path (from index.html) ──
const STEERING_PATH = 'M370.513 874.855c-48.815-20.02-92.685-50.082-129.215-87.716-69.276-71.384-112.122-170.011-112.122-278.945 0-108.918 42.846-207.544 112.122-278.929 69.836-71.953 170.267-107.93 270.706-107.93 100.423 0 200.861 35.977 270.688 107.93 69.276 71.384 112.131 170.01 112.131 278.929 0 108.934-42.855 207.561-112.131 278.945-36.52 37.633-80.399 67.694-129.205 87.716-45.187 18.524-93.334 27.811-141.483 27.811-48.166 0-96.298-9.288-141.491-27.811l0 0zM512.005 199.998c-80.213 0-160.425 28.732-216.19 86.211-33.202 34.203-58.802 76.253-73.97 123.216-4.189 15.772 1.398 23.218 16.742 22.364 50.317-1.991 158.745-3.58 181.017-4.735-19.13 22.356-30.724 51.706-30.724 83.843 0 35.031 13.779 66.757 36.06 89.716 7.949 8.2 16.994 15.277 26.875 20.983 18.62 10.778 39.397 16.165 60.19 16.174 20.785-0.008 41.563-5.396 60.181-16.174 9.881-5.707 18.919-12.783 26.875-20.983 22.281-22.959 36.06-54.684 36.06-89.716 0-32.136-11.603-61.488-30.716-83.843 22.263 1.155 130.691 2.744 181.001 4.735 15.345 0.853 20.94-6.593 16.742-22.364-15.159-46.962-40.762-89.012-73.971-123.216-55.764-57.48-135.968-86.211-216.174-86.211l0 0zM581.084 439.837c-35.645-36.729-102.534-36.729-138.178 0-17.676 18.215-28.613 43.389-28.613 71.185 0 27.811 10.937 52.978 28.613 71.199 6.813 7.011 14.615 13.002 23.19 17.704 28.483 15.645 63.324 15.645 91.808 0 8.566-4.702 16.377-10.694 23.182-17.704 17.684-18.222 28.62-43.389 28.62-71.199 0.001-27.794-10.936-52.969-28.62-71.185l0 0zM529.738 548.203c13.365-6.761 22.564-20.933 22.564-37.307 0-17.353-10.337-32.221-25.008-38.428-9.71-4.108-20.875-4.108-30.586 0-14.672 6.208-25.008 21.076-25.008 38.428 0 16.373 9.191 30.546 22.555 37.307 11.074 5.588 24.423 5.588 35.483 0l0 0zM575.449 817.192c58.964-12.818 111.669-43.147 152.728-85.459 42.896-44.2 73.092-101.47 84.509-165.509 4.109-17.369-3.143-22.69-15.848-22.272-25.626-0.56-51.261-0.452-75.691 4.293-87.041 16.909-118.171 60.19-133.574 159.829-5.595 36.193-9.151 78.547-12.123 109.118l0 0zM448.541 817.192c-2.963-30.572-6.528-72.925-12.114-109.118-15.404-99.638-46.54-142.919-133.583-159.829-24.423-4.745-50.065-4.853-75.691-4.293-12.699-0.418-19.957 4.902-15.841 22.272 11.408 64.039 41.614 121.309 84.501 165.509 41.068 42.312 93.764 72.64 152.728 85.459z'
const steeringPath2D = new Path2D(STEERING_PATH)

// ── Constants from existing drawing modules ──

// RPM gauge (from rpm-gauge.ts)
const RPM_START_ANGLE = 0.75 * Math.PI  // 135 degrees
const RPM_SWEEP = 1.5 * Math.PI         // 270 degrees
const RPM_W = 180
const RPM_H = 105

// G-force (from gforce-ball.ts)
const GFORCE_MAX_G = 1.5
const GFORCE_SIZE = 120

// Steering
const STEERING_ICON_SIZE = 80  // px (from CSS)

// Pedals
const PEDAL_BAR_W = 100
const PEDAL_BAR_H = 16
const PEDAL_GAP = 3

// Gear box
const GEAR_BOX_SIZE = 48

// ── GEAR_DISPLAY map ──
import { GEAR_DISPLAY } from './defaults'

// ── Track map projection (from track-map.ts) ──

interface Proj {
  padX: number; padY: number
  drawW: number; drawH: number
  latMin: number; latRange: number
  lonMin: number; lonRange: number
  cosLat: number
}

function buildProjection(layout: TrackLayout, canvasW: number, canvasH: number): Proj | null {
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

function gpsToCanvas(proj: Proj, lat: number, lon: number): { x: number; y: number } {
  const nx = (lon - proj.lonMin) / proj.lonRange
  const ny = 1 - (lat - proj.latMin) / proj.latRange
  return { x: proj.padX + nx * proj.drawW, y: proj.padY + ny * proj.drawH }
}

function computePerpendicularAngle(
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
  ctx.fillStyle = '#ccc'
  ctx.font = '18px Consolas, monospace'
  ctx.fillText('MPH', valueWidth + 4, 56)
  clearShadow(ctx)

  ctx.restore()
}

function drawRpmGaugeOverlay(
  ctx: CanvasRenderingContext2D, rpm: number,
  x: number, y: number, scale: number,
  config: RpmConfig,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  const w = RPM_W, h = RPM_H
  const cx = w / 2, cy = h - 4
  const radius = 78
  const lineWidth = 14
  const { redline, maxRpm } = config

  // Background arc (dim)
  ctx.beginPath()
  ctx.arc(cx, cy, radius, RPM_START_ANGLE, RPM_START_ANGLE + RPM_SWEEP)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'butt'
  ctx.stroke()

  const redlinePct = redline / maxRpm

  // Green background zone (up to redline, faded)
  drawZoneArc(ctx, cx, cy, radius, 0, redlinePct, '#00cc66', 0.2, lineWidth)
  // Red background zone (redline to max, more prominent)
  drawZoneArc(ctx, cx, cy, radius, redlinePct, 1, '#ff3333', 0.45, lineWidth)
  const redlineAngle = RPM_START_ANGLE + redlinePct * RPM_SWEEP

  // Active fill: green arc from 0 up to min(rpm, redline)
  const pct = Math.min(1, Math.max(0, rpm / maxRpm))
  if (pct > 0) {
    const greenEnd = Math.min(pct, redlinePct)
    ctx.beginPath()
    ctx.arc(cx, cy, radius, RPM_START_ANGLE, RPM_START_ANGLE + greenEnd * RPM_SWEEP)
    ctx.strokeStyle = '#00cc66'
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'butt'
    ctx.stroke()
  }

  // Active fill: red arc from redline up to rpm (only when past redline)
  if (rpm > redline) {
    const redEnd = Math.min(pct, 1)
    ctx.beginPath()
    ctx.arc(cx, cy, radius, redlineAngle, RPM_START_ANGLE + redEnd * RPM_SWEEP)
    ctx.strokeStyle = '#ff3333'
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'butt'
    ctx.stroke()
  }

  // Tick marks — drawn AFTER active arcs so they stay visible on highlighted area
  ctx.lineCap = 'round'

  // Minor ticks at 500 RPM intervals
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'
  ctx.lineWidth = 1.5
  for (let r = 500; r <= maxRpm; r += 1000) {
    const angle = RPM_START_ANGLE + (r / maxRpm) * RPM_SWEEP
    const inner = radius - 4, outer = radius + 4
    ctx.beginPath()
    ctx.moveTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle))
    ctx.lineTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle))
    ctx.stroke()
  }

  // Major ticks at 1000 RPM intervals with labels
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 2
  const labelR = radius - 17
  for (let r = 0; r <= maxRpm; r += 1000) {
    const angle = RPM_START_ANGLE + (r / maxRpm) * RPM_SWEEP
    const inner = radius - 7, outer = radius + 7
    ctx.beginPath()
    ctx.moveTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle))
    ctx.lineTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle))
    ctx.stroke()

    // Numeric label (thousands digit, skip 0)
    if (r > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.font = '10px Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText((r / 1000).toString(), cx + labelR * Math.cos(angle), cy + labelR * Math.sin(angle))
    }
  }

  // Numeric readout — positioned near the bottom of the arc bowl
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 36px Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(Math.round(rpm).toString(), cx, cy - 14)

  ctx.fillStyle = '#aaa'
  ctx.font = '16px Consolas, monospace'
  ctx.fillText('RPM', cx, cy + 4)

  ctx.restore()
}

function drawZoneArc(
  c: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  startPct: number, endPct: number, color: string, alpha: number,
  lw = 14,
): void {
  c.beginPath()
  c.arc(cx, cy, r, RPM_START_ANGLE + startPct * RPM_SWEEP, RPM_START_ANGLE + endPct * RPM_SWEEP)
  c.strokeStyle = color
  c.globalAlpha = alpha
  c.lineWidth = lw
  c.lineCap = 'butt'
  c.stroke()
  c.globalAlpha = 1.0
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

function drawSteeringOverlay(
  ctx: CanvasRenderingContext2D, deg: number,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  // Label at the top of the bounding box (matches DOM: label block sits above SVG)
  const labelH = 22  // approximate line-height for bold 18px font
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 18px Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(`${Math.abs(Math.round(deg))}\u00B0`, STEERING_ICON_SIZE / 2, 0)

  // Steering wheel icon — rotate around center, positioned below label
  const iconCx = STEERING_ICON_SIZE / 2
  const iconCy = labelH + STEERING_ICON_SIZE / 2
  ctx.translate(iconCx, iconCy)
  ctx.rotate((-deg * Math.PI) / 180)  // negate: PDR positive = left turn
  const iconScale = STEERING_ICON_SIZE / 1024  // SVG viewBox is 1024x1024
  ctx.scale(iconScale, iconScale)
  ctx.translate(-512, -512)  // center the path
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.fill(steeringPath2D)

  ctx.restore()
}

function drawGForceOverlay(
  ctx: CanvasRenderingContext2D, lat: number, lon: number,
  x: number, y: number, scale: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  const s = GFORCE_SIZE
  const cx = s / 2, cy = s / 2
  const radius = (s / 2) - 8

  // Outer ring — CSS: background: rgba(0,0,0,0.5); border-radius: 50%
  ctx.beginPath()
  ctx.arc(cx, cy, s / 2, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fill()

  // Inner background circle
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  ctx.fill()

  // Grid circles
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'
  ctx.lineWidth = 1
  for (const g of [0.5, 1.0]) {
    const r = (g / GFORCE_MAX_G) * radius
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
  const clamp = (v: number) => Math.max(-GFORCE_MAX_G, Math.min(GFORCE_MAX_G, v))
  const dotX = cx + (clamp(lat) / GFORCE_MAX_G) * radius
  const dotY = cy - (clamp(lon) / GFORCE_MAX_G) * radius
  ctx.beginPath()
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2)
  ctx.fillStyle = '#ff6b00'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.stroke()

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

function drawTrackMapOverlay(
  ctx: CanvasRenderingContext2D,
  row: TelemetryRow,
  x: number, y: number,
  mapW: number, mapH: number,
  scale: number,
  trackLayout: TrackLayout,
): void {
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  // CSS: filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.7))
  setShadow(ctx, 6, 'rgba(0,0,0,0.7)', 0, 2)

  const proj = buildProjection(trackLayout, mapW, mapH)
  if (!proj) { ctx.restore(); return }

  const { points, startFinishLat, startFinishLon } = trackLayout

  // Track polyline
  ctx.beginPath()
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.lineWidth = 5
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  let first = true
  for (const pt of points) {
    const px = gpsToCanvas(proj, pt.lat, pt.lon)
    if (first) { ctx.moveTo(px.x, px.y); first = false }
    else ctx.lineTo(px.x, px.y)
  }
  ctx.stroke()

  // S/F marker
  const sfPx = gpsToCanvas(proj, startFinishLat, startFinishLon)
  const perpAngle = computePerpendicularAngle(proj, points, startFinishLat, startFinishLon)
  const halfLen = 10
  ctx.save()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2.5
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(sfPx.x + Math.cos(perpAngle) * halfLen, sfPx.y + Math.sin(perpAngle) * halfLen)
  ctx.lineTo(sfPx.x - Math.cos(perpAngle) * halfLen, sfPx.y - Math.sin(perpAngle) * halfLen)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()

  // Position dot (colour by speed) — no shadow on the dot itself
  clearShadow(ctx)
  const lat = row.lat, lon = row.lon
  let spd = Math.max(0, row.speed_kph)
  const px = gpsToCanvas(proj, lat, lon)
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

  ctx.restore()
}

function drawSessionOverlay(
  ctx: CanvasRenderingContext2D,
  info: SessionInfo,
  x: number, y: number, scale: number,
): void {
  const fields: Array<[string, string]> = []
  const vehicleParts = [info.year, info.vehicle]
    .filter(Boolean)
    .map(s => s!.replace(/[()]/g, ''))
  if (vehicleParts.length) fields.push(['Vehicle', vehicleParts.join(' ')])
  if (info.engine) fields.push(['Engine', info.engine])
  if (fields.length === 0) return

  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)

  const lineH = 14
  const padX = 10, padY = 6
  const labelFont = 'bold 9px Consolas, monospace'
  const valueFont = '11px Consolas, monospace'

  // Measure max width
  ctx.font = valueFont
  let maxW = 0
  for (const [label, value] of fields) {
    ctx.font = labelFont
    const lw = ctx.measureText(label + ' ').width
    ctx.font = valueFont
    const vw = ctx.measureText(value).width
    if (lw + vw > maxW) maxW = lw + vw
  }

  const boxW = maxW + padX * 2
  const boxH = fields.length * lineH + padY * 2

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.roundRect(0, 0, boxW, boxH, 4)
  ctx.fill()

  // Text
  setShadow(ctx, 4, 'rgba(0,0,0,0.8)')
  let ty = padY + 10
  for (const [label, value] of fields) {
    ctx.font = labelFont
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const lw = ctx.measureText(label + ' ').width
    ctx.fillText(label + ' ', padX, ty)
    ctx.font = valueFont
    ctx.fillStyle = '#ccc'
    ctx.fillText(value, padX + lw, ty)
    ty += lineH
  }
  clearShadow(ctx)

  ctx.restore()
}

// ── Composite frame renderer ──

/** Track map canvas size — must match the CSS dimensions of #hud-trackMap (200×160)
 *  since the overlay anchor is at native video resolution, these CSS pixels map 1:1. */
function getTrackMapSize(): { w: number; h: number } {
  return { w: 200, h: 160 }
}

function renderOverlayFrame(
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
): void {
  ctx.clearRect(0, 0, width, height)

  // Helper to resolve % position to pixels
  const px = (pos: OverlayPosition) => ({
    x: (pos.left / 100) * width,
    y: (pos.top / 100) * height,
    s: pos.scale,
  })

  if (config.speed) {
    const p = px(layout.speed)
    drawSpeed(ctx, row, p.x, p.y, p.s)
  }

  if (config.rpmGauge) {
    const p = px(layout.rpmGauge)
    drawRpmGaugeOverlay(ctx, row.rpm, p.x, p.y, p.s, rpmConfig)
  }

  if (config.gear) {
    const p = px(layout.gear)
    drawGearOverlay(ctx, gearDisplay, p.x, p.y, p.s)
  }

  if (config.steering) {
    const p = px(layout.steering)
    drawSteeringOverlay(ctx, row.steering_deg, p.x, p.y, p.s)
  }

  if (config.gforce) {
    const p = px(layout.gforce)
    drawGForceOverlay(ctx, row.gforce_lat, row.gforce_lon, p.x, p.y, p.s)
  }

  if (config.pedals) {
    const p = px(layout.pedals)
    drawPedalsOverlay(ctx, row.throttle, row.brake, p.x, p.y, p.s)
  }

  if (config.gps) {
    const p = px(layout.gps)
    drawGpsOverlay(ctx, row, p.x, p.y, p.s)
  }

  if (config.trackMap && trackLayout) {
    const p = px(layout.trackMap)
    const mapSize = getTrackMapSize()
    drawTrackMapOverlay(ctx, row, p.x, p.y, mapSize.w, mapSize.h, p.s, trackLayout)
  }

  if (config.session && sessionInfo) {
    const p = px(layout.session)
    drawSessionOverlay(ctx, sessionInfo, p.x, p.y, p.s)
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
        lastKnownGear = GEAR_DISPLAY[row.gear] ?? row.gear
      }

      renderOverlayFrame(
        ctx, row, width, height,
        overlayLayout, overlayConfig, rpmConfig, trackLayout,
        lastKnownGear, sessionInfo,
      )

      // Extract raw RGBA pixels (instant — no PNG compression)
      const pixels = ctx.getImageData(0, 0, width, height)
      // invoke-based IPC: await provides backpressure + natural event-loop yield
      await window.pdr.sendOverlayFrameData(f, new Uint8Array(pixels.data.buffer))
    }
  } catch (err) {
    console.error('[overlay-renderer] Error rendering frame:', err)
  }

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
