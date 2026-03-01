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

// Per-canvas offscreen cache (keyed by canvas element)
const bgCacheMap = new WeakMap<HTMLCanvasElement, { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number }>()
// Track secondary canvases for cache invalidation on config change
const secondaryCanvases: HTMLCanvasElement[] = []

// Offscreen cache for static elements (background arc, zone arcs, tick marks)
// Kept as the primary cache for the singleton canvas; secondary canvases use bgCacheMap.
let bgCache: HTMLCanvasElement | null = null
let bgCacheCtx: CanvasRenderingContext2D | null = null
let bgCacheW = 0
let bgCacheH = 0

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
  bgCache = null // invalidate singleton cache so next draw rebuilds
  // Invalidate all secondary canvas caches (force rebuild on next draw)
  for (const c of secondaryCanvases) {
    const entry = bgCacheMap.get(c)
    if (entry) entry.w = 0
  }
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

/** Render static elements (background arc, zone arcs, tick marks) into a given context. */
function renderBgCacheToCtx(c: CanvasRenderingContext2D, w: number, h: number): void {
  const cx = w / 2
  const cy = h - 4
  const radius = h - 16
  const { yellowStart, redline, maxRpm } = config
  const lineWidth = 10

  // Background arc (dim)
  c.beginPath()
  c.arc(cx, cy, radius, START_ANGLE, START_ANGLE + SWEEP)
  c.strokeStyle = 'rgba(255,255,255,0.08)'
  c.lineWidth = lineWidth
  c.lineCap = 'butt'
  c.stroke()

  // Color zone arcs
  drawZoneArc(c, cx, cy, radius, 0, yellowStart / maxRpm, '#00cc66', 0.2)
  drawZoneArc(c, cx, cy, radius, yellowStart / maxRpm, redline / maxRpm, '#ffaa00', 0.25)
  drawZoneArc(c, cx, cy, radius, redline / maxRpm, 1, '#ff3333', 0.3)

  // Tick marks at 1000 RPM intervals
  c.strokeStyle = 'rgba(255,255,255,0.4)'
  c.lineWidth = 1.5
  for (let r = 0; r <= maxRpm; r += 1000) {
    const angle = START_ANGLE + (r / maxRpm) * SWEEP
    const inner = radius - 14
    const outer = radius + 2
    c.beginPath()
    c.moveTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle))
    c.lineTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle))
    c.stroke()
  }
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

export function drawRpmGauge(rpm: number, targetCanvas?: HTMLCanvasElement): void {
  const c = targetCanvas ?? canvas
  let drawCtx: CanvasRenderingContext2D
  let cache: HTMLCanvasElement | null
  let cacheW: number
  let cacheH: number

  if (!targetCanvas) {
    if (!ctx) return
    drawCtx = ctx
    cache = bgCache
    cacheW = bgCacheW
    cacheH = bgCacheH
  } else {
    let entry = bgCacheMap.get(targetCanvas)
    if (!entry) {
      const tc = targetCanvas.getContext('2d')
      if (!tc) return
      entry = { canvas: document.createElement('canvas'), ctx: tc, w: 0, h: 0 }
      bgCacheMap.set(targetCanvas, entry)
      secondaryCanvases.push(targetCanvas)
    }
    drawCtx = entry.ctx
    cache = entry.canvas
    cacheW = entry.w
    cacheH = entry.h
  }

  const w = c.width
  const h = c.height
  const cx = w / 2
  const cy = h - 4
  const radius = h - 16

  // Rebuild background cache if needed (config change or canvas resize)
  if (!targetCanvas) {
    if (!bgCache || bgCacheW !== w || bgCacheH !== h) {
      renderBgCache(w, h)
      cache = bgCache; cacheW = bgCacheW; cacheH = bgCacheH
    }
  } else {
    const entry = bgCacheMap.get(targetCanvas)!
    if (cacheW !== w || cacheH !== h) {
      entry.canvas.width = w; entry.canvas.height = h
      entry.w = w; entry.h = h
      // Render bg into entry.canvas
      const bc = entry.canvas.getContext('2d')!
      renderBgCacheToCtx(bc, w, h)
    }
    cache = entry.canvas
  }

  drawCtx.clearRect(0, 0, w, h)
  drawCtx.drawImage(cache!, 0, 0)

  const { yellowStart, redline, maxRpm } = config

  // Active fill arc up to current RPM
  const pct = Math.min(1, Math.max(0, rpm / maxRpm))
  if (pct > 0) {
    const endAngle = START_ANGLE + pct * SWEEP
    let fillColor: string
    if (rpm >= redline) fillColor = '#ff3333'
    else if (rpm >= yellowStart) fillColor = '#ffaa00'
    else fillColor = '#00cc66'

    drawCtx.beginPath()
    drawCtx.arc(cx, cy, radius, START_ANGLE, endAngle)
    drawCtx.strokeStyle = fillColor
    drawCtx.lineWidth = 10
    drawCtx.lineCap = 'butt'
    drawCtx.stroke()
  }

  // Numeric readout centered in arc
  drawCtx.fillStyle = '#fff'
  drawCtx.font = 'bold 18px Consolas, monospace'
  drawCtx.textAlign = 'center'
  drawCtx.textBaseline = 'middle'
  drawCtx.fillText(Math.round(rpm).toString(), cx, cy - 12)

  drawCtx.fillStyle = '#aaa'
  drawCtx.font = '10px Consolas, monospace'
  drawCtx.fillText('RPM', cx, cy + 2)
}

function drawZoneArc(
  c: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  startPct: number, endPct: number, color: string, alpha: number
): void {
  c.beginPath()
  c.arc(cx, cy, r, START_ANGLE + startPct * SWEEP, START_ANGLE + endPct * SWEEP)
  c.strokeStyle = color
  c.globalAlpha = alpha
  c.lineWidth = 10
  c.lineCap = 'butt'
  c.stroke()
  c.globalAlpha = 1.0
}
