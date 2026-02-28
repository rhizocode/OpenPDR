/**
 * OpenPDR Viewer — RPM arc gauge (canvas)
 *
 * 270-degree arc gauge with configurable color zones (green/yellow/red).
 * Zone thresholds are user-configurable via settings for different vehicles.
 * Default values are for the LT4 supercharged V8 (CT5-V Blackwing).
 */

import type { RpmConfig } from './types'

const STORAGE_KEY = 'pdr-rpm-config'

// Default zone thresholds for LT4 V8
const DEFAULT_CONFIG: RpmConfig = {
  yellowStart: 5500,
  redline: 6500,
  maxRpm: 7000,
}

let config: RpmConfig = DEFAULT_CONFIG
let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D

// Arc geometry: 270-degree sweep from 7 o'clock to 5 o'clock
const START_ANGLE = 0.75 * Math.PI    // 135 degrees
const SWEEP = 1.5 * Math.PI           // 270 degrees

export function loadRpmConfig(): RpmConfig {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) }
    } catch {
      config = { ...DEFAULT_CONFIG }
    }
  } else {
    config = { ...DEFAULT_CONFIG }
  }
  return config
}

export function saveRpmConfig(newConfig: RpmConfig): void {
  config = { ...newConfig }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export function getRpmConfig(): RpmConfig {
  return config
}

export function initRpmGauge(): void {
  canvas = document.getElementById('rpm-gauge-canvas') as HTMLCanvasElement
  const c = canvas.getContext('2d')
  if (!c) return
  ctx = c
  loadRpmConfig()
}

export function drawRpmGauge(rpm: number): void {
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const cx = w / 2
  const cy = h - 4      // center at bottom edge for half-circle look
  const radius = h - 16  // margin for tick labels

  ctx.clearRect(0, 0, w, h)

  const { yellowStart, redline, maxRpm } = config
  const lineWidth = 10

  // Background arc (dim)
  ctx.beginPath()
  ctx.arc(cx, cy, radius, START_ANGLE, START_ANGLE + SWEEP)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'butt'
  ctx.stroke()

  // Color zone arcs (dim background showing the zones)
  drawZoneArc(cx, cy, radius, 0, yellowStart / maxRpm, '#00cc66', 0.2) // green
  drawZoneArc(cx, cy, radius, yellowStart / maxRpm, redline / maxRpm, '#ffaa00', 0.25) // yellow
  drawZoneArc(cx, cy, radius, redline / maxRpm, 1, '#ff3333', 0.3) // red

  // Active fill arc up to current RPM
  const pct = Math.min(1, Math.max(0, rpm / maxRpm))
  if (pct > 0) {
    const endAngle = START_ANGLE + pct * SWEEP
    let fillColor: string
    if (rpm >= redline) fillColor = '#ff3333'
    else if (rpm >= yellowStart) fillColor = '#ffaa00'
    else fillColor = '#00cc66'

    ctx.beginPath()
    ctx.arc(cx, cy, radius, START_ANGLE, endAngle)
    ctx.strokeStyle = fillColor
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'butt'
    ctx.stroke()
  }

  // Tick marks at 1000 RPM intervals
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'
  ctx.lineWidth = 1.5
  for (let r = 0; r <= maxRpm; r += 1000) {
    const angle = START_ANGLE + (r / maxRpm) * SWEEP
    const inner = radius - 14
    const outer = radius + 2
    ctx.beginPath()
    ctx.moveTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle))
    ctx.lineTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle))
    ctx.stroke()
  }

  // Numeric readout centered in arc
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 18px Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(Math.round(rpm).toString(), cx, cy - 12)

  ctx.fillStyle = '#aaa'
  ctx.font = '10px Consolas, monospace'
  ctx.fillText('RPM', cx, cy + 2)
}

function drawZoneArc(
  cx: number, cy: number, r: number,
  startPct: number, endPct: number, color: string, alpha: number
): void {
  ctx.beginPath()
  ctx.arc(cx, cy, r, START_ANGLE + startPct * SWEEP, START_ANGLE + endPct * SWEEP)
  ctx.strokeStyle = color
  ctx.globalAlpha = alpha
  ctx.lineWidth = 10
  ctx.lineCap = 'butt'
  ctx.stroke()
  ctx.globalAlpha = 1.0
}
