/**
 * OpenPDR Viewer — Strip chart panel
 *
 * Time-series graphs for telemetry channels rendered below the video.
 * Uses offscreen canvas caching: data traces are rendered once on load/resize,
 * only the playhead is drawn per animation frame.
 *
 * Architecture:
 *   1. On file load → pre-extract channel values into number[] arrays
 *   2. Render full traces to per-channel offscreen canvases
 *   3. Per frame → composite offscreens + draw playhead (near-zero cost)
 *   4. On resize → re-render offscreens (debounced)
 */

import type { TelemetryRow } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { telemetryStore, duration, video, onRowUpdate, onFrameTick, onTelemetryLoad, currentRow, setCurrentRow, findRowAtTime, lapData } from './state'

// ── Channel configuration ──

interface ChartChannel {
  key: string
  label: string
  color: string
  /** Extract values array from the columnar store */
  storeAccessor: (store: TelemetryStore) => ArrayLike<number>
  /** Scale factor applied to raw store values (e.g. 100 for 0-1 → 0-100%) */
  scale: number
  /** Read a single value for HUD current-value display */
  rowAccessor: (row: TelemetryRow) => number
  unit: string
  min: number
  max: number
  precision: number  // decimal places for display (0 = whole numbers)
  defaultEnabled: boolean
}

const CHANNELS: ChartChannel[] = [
  { key: 'speed', label: 'Speed', color: '#3399ff', storeAccessor: s => s.speed_mph, scale: 1, rowAccessor: r => r.speed_mph, unit: 'mph', min: 0, max: 200, precision: 0, defaultEnabled: true },
  { key: 'rpm', label: 'RPM', color: '#ff6b00', storeAccessor: s => s.rpm, scale: 1, rowAccessor: r => r.rpm, unit: 'rpm', min: 0, max: 7000, precision: 0, defaultEnabled: true },
  { key: 'throttle', label: 'Throttle', color: '#00cc66', storeAccessor: s => s.throttle, scale: 100, rowAccessor: r => r.throttle * 100, unit: '%', min: 0, max: 100, precision: 0, defaultEnabled: true },
  { key: 'brake', label: 'Brake', color: '#ff3333', storeAccessor: s => s.brake, scale: 100, rowAccessor: r => r.brake * 100, unit: '%', min: 0, max: 100, precision: 0, defaultEnabled: true },
  { key: 'gforce_lat', label: 'G Lat', color: '#66ccff', storeAccessor: s => s.gforce_lat, scale: 1, rowAccessor: r => r.gforce_lat, unit: 'g', min: -1.5, max: 1.5, precision: 2, defaultEnabled: false },
  { key: 'gforce_lon', label: 'G Lon', color: '#cc66ff', storeAccessor: s => s.gforce_lon, scale: 1, rowAccessor: r => r.gforce_lon, unit: 'g', min: -1.5, max: 1.5, precision: 2, defaultEnabled: false },
  { key: 'steering', label: 'Steering', color: '#ffcc00', storeAccessor: s => s.steering_deg, scale: 1, rowAccessor: r => r.steering_deg, unit: '\u00B0', min: -400, max: 400, precision: 0, defaultEnabled: false },
]

const CHANNELS_STORAGE_KEY = 'pdr-chart-channels'
const LABEL_WIDTH = 80  // px reserved for axis labels on left

// ── Per-channel offscreen data ──

interface ChannelData {
  config: ChartChannel
  values: ArrayLike<number>  // typed array from store (or scaled copy)
  times: Float64Array        // store.time — shared across all channels
  offscreen: HTMLCanvasElement  // use HTMLCanvasElement (not OffscreenCanvas) for broader compat
  ctx: CanvasRenderingContext2D
}

let channelData: ChannelData[] = []
/** Cached scaled arrays, keyed by channel key. Rebuilt only on telemetry load. */
let scaledCache = new Map<string, Float32Array>()
let enabledKeys: Set<string>
let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let container: HTMLDivElement
let chartEmpty: HTMLDivElement
let toolbar: HTMLDivElement
let dpr = 1
let chartScrubActive = false

export function getIsChartScrubbing(): boolean {
  return chartScrubActive
}

// Static cache: holds data traces + lap markers + channel/range labels.
// Rebuilt only on resize or channel toggle (expensive operations are here).
let staticCache: HTMLCanvasElement
let staticCacheCtx: CanvasRenderingContext2D

// Frame cache: static cache + current-value text overlay.
// Rebuilt on row change (cheap — just blit static + draw a few text strings).
let frameCache: HTMLCanvasElement
let frameCacheCtx: CanvasRenderingContext2D

// ── Public API ──

export function initChartPanel(): void {
  canvas = document.getElementById('chart-canvas') as HTMLCanvasElement
  ctx = canvas.getContext('2d')!
  container = document.getElementById('chart-canvas-container') as HTMLDivElement
  chartEmpty = document.getElementById('chart-empty') as HTMLDivElement
  toolbar = document.getElementById('chart-toolbar') as HTMLDivElement
  dpr = window.devicePixelRatio || 1

  // Create offscreen buffers
  staticCache = document.createElement('canvas')
  staticCacheCtx = staticCache.getContext('2d')!
  frameCache = document.createElement('canvas')
  frameCacheCtx = frameCache.getContext('2d')!

  // Load enabled channels
  const saved = localStorage.getItem(CHANNELS_STORAGE_KEY)
  if (saved) {
    try {
      enabledKeys = new Set(JSON.parse(saved))
    } catch {
      enabledKeys = defaultEnabledKeys()
    }
  } else {
    enabledKeys = defaultEnabledKeys()
  }

  buildToolbar()

  // Subscribe to telemetry load
  onTelemetryLoad(() => {
    buildScaledCache()
    rebuildChannelData()
    resizeAndRender()
    chartEmpty.classList.add('hidden')
  })

  // On row change: rebuild frame cache (labels show new current values)
  onRowUpdate(() => { renderFrameCache(); invalidatePlayhead(); drawPlayhead() })

  // On every animation frame: just blit cache + draw playhead (very cheap)
  onFrameTick(() => drawPlayhead())

  // Resize observer
  const ro = new ResizeObserver(() => {
    resizeAndRender()
  })
  ro.observe(container)

  // Click-to-seek + drag-to-scrub
  function seekToPointer(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect()
    const xPct = (e.clientX - rect.left - LABEL_WIDTH) / (rect.width - LABEL_WIDTH)
    if (xPct >= 0 && xPct <= 1 && video.duration && isFinite(video.duration)) {
      video.currentTime = xPct * video.duration
      setCurrentRow(findRowAtTime(video.currentTime))
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    chartScrubActive = true
    canvas.setPointerCapture(e.pointerId)
    seekToPointer(e)
  })

  canvas.addEventListener('pointermove', (e) => {
    if (chartScrubActive) seekToPointer(e)
  })

  canvas.addEventListener('pointerup', () => {
    chartScrubActive = false
  })
}

// ── Internal ──

function defaultEnabledKeys(): Set<string> {
  return new Set(CHANNELS.filter(c => c.defaultEnabled).map(c => c.key))
}

function saveEnabledKeys(): void {
  localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify([...enabledKeys]))
}

function buildToolbar(): void {
  toolbar.innerHTML = ''
  for (const ch of CHANNELS) {
    const btn = document.createElement('button')
    btn.className = 'chart-channel-btn'
    btn.textContent = ch.label
    if (enabledKeys.has(ch.key)) {
      btn.classList.add('active')
      btn.style.color = ch.color
      btn.style.borderColor = ch.color
    }
    btn.addEventListener('click', () => {
      if (enabledKeys.has(ch.key)) {
        enabledKeys.delete(ch.key)
        btn.classList.remove('active')
        btn.style.color = ''
        btn.style.borderColor = ''
      } else {
        enabledKeys.add(ch.key)
        btn.classList.add('active')
        btn.style.color = ch.color
        btn.style.borderColor = ch.color
      }
      saveEnabledKeys()
      rebuildChannelData()
      resizeAndRender()
    })
    toolbar.appendChild(btn)
  }
}

/** Pre-compute scaled arrays for channels with scale !== 1. Called once on telemetry load. */
function buildScaledCache(): void {
  scaledCache.clear()
  const store = telemetryStore
  if (!store || store.length === 0) return
  for (const config of CHANNELS) {
    if (config.scale !== 1) {
      const raw = config.storeAccessor(store)
      const scaled = new Float32Array(store.length)
      for (let i = 0; i < store.length; i++) scaled[i] = raw[i] * config.scale
      scaledCache.set(config.key, scaled)
    }
  }
}

function rebuildChannelData(): void {
  const store = telemetryStore
  if (!store || store.length === 0) {
    channelData = []
    return
  }

  const enabled = CHANNELS.filter(c => enabledKeys.has(c.key))
  const times = store.time  // shared across all channels

  channelData = enabled.map(config => {
    const values = scaledCache.get(config.key) ?? config.storeAccessor(store)
    const offscreen = document.createElement('canvas')
    const offCtx = offscreen.getContext('2d')!
    return { config, values, times, offscreen, ctx: offCtx }
  })
}

function resizeAndRender(): void {
  const w = container.clientWidth
  const h = container.clientHeight
  if (w === 0 || h === 0) return

  // Size visible canvas + caches for high-DPI
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  staticCache.width = w * dpr
  staticCache.height = h * dpr
  frameCache.width = w * dpr
  frameCache.height = h * dpr

  // Render each channel offscreen
  const chartCount = channelData.length || 1
  const chartH = Math.floor((h * dpr) / chartCount)
  const chartW = Math.floor((w - LABEL_WIDTH) * dpr)

  for (const cd of channelData) {
    cd.offscreen.width = chartW
    cd.offscreen.height = chartH
    renderChannelOffscreen(cd, chartW, chartH)
  }

  renderStaticCache()
  renderFrameCache()
  invalidatePlayhead()
  drawPlayhead()
}

function renderChannelOffscreen(cd: ChannelData, w: number, h: number): void {
  const { ctx: offCtx, values, times, config } = cd
  offCtx.clearRect(0, 0, w, h)

  if (values.length < 2 || duration <= 0) return

  const range = config.max - config.min || 1
  const margin = 4 * dpr
  const drawH = h - margin * 2

  offCtx.strokeStyle = config.color
  offCtx.lineWidth = 1.5 * dpr
  offCtx.beginPath()

  const pxPerSample = w / values.length
  if (pxPerSample >= 1) {
    // Enough room: draw every point
    for (let i = 0; i < values.length; i++) {
      const x = (times[i] / duration) * w
      const y = h - margin - ((values[i] - config.min) / range) * drawH
      if (i === 0) offCtx.moveTo(x, y)
      else offCtx.lineTo(x, y)
    }
  } else {
    // More samples than pixels: use min/max bucketing per pixel column
    let sampleIdx = 0
    for (let px = 0; px < w; px++) {
      const tStart = (px / w) * duration
      const tEnd = ((px + 1) / w) * duration
      let bucketMin = Infinity
      let bucketMax = -Infinity
      let count = 0

      while (sampleIdx < values.length && times[sampleIdx] < tEnd) {
        if (times[sampleIdx] >= tStart) {
          const v = values[sampleIdx]
          if (v < bucketMin) bucketMin = v
          if (v > bucketMax) bucketMax = v
          count++
        }
        sampleIdx++
      }

      if (count === 0) continue

      const yMin = h - margin - ((bucketMax - config.min) / range) * drawH
      const yMax = h - margin - ((bucketMin - config.min) / range) * drawH
      if (px === 0 && count > 0) {
        offCtx.moveTo(px, yMin)
      }
      offCtx.lineTo(px, yMin)
      if (yMax !== yMin) offCtx.lineTo(px, yMax)
    }
  }
  offCtx.stroke()

  // Zero line for bipolar channels (g-force, steering)
  if (config.min < 0) {
    const zeroY = h - margin - ((0 - config.min) / range) * drawH
    offCtx.strokeStyle = 'rgba(255,255,255,0.15)'
    offCtx.lineWidth = 1 * dpr
    offCtx.setLineDash([4 * dpr, 4 * dpr])
    offCtx.beginPath()
    offCtx.moveTo(0, zeroY)
    offCtx.lineTo(w, zeroY)
    offCtx.stroke()
    offCtx.setLineDash([])
  }
}

/** Render data traces + lap markers + static labels to the static cache. Called on resize/channel toggle. */
function renderStaticCache(): void {
  const w = staticCache.width
  const h = staticCache.height
  if (w === 0 || h === 0) return

  staticCacheCtx.clearRect(0, 0, w, h)

  const chartCount = channelData.length
  if (chartCount === 0) return

  const chartH = h / chartCount
  const labelW = LABEL_WIDTH * dpr

  for (let i = 0; i < chartCount; i++) {
    const cd = channelData[i]
    const y = i * chartH

    // Draw offscreen data to the right of the label area
    staticCacheCtx.drawImage(cd.offscreen, labelW, y, w - labelW, chartH)

    // Label background
    staticCacheCtx.fillStyle = 'rgba(26,26,26,0.85)'
    staticCacheCtx.fillRect(0, y, labelW, chartH)

    // Channel label (top line)
    staticCacheCtx.fillStyle = cd.config.color
    staticCacheCtx.font = `bold ${11 * dpr}px Consolas, monospace`
    staticCacheCtx.textAlign = 'left'
    staticCacheCtx.textBaseline = 'top'
    staticCacheCtx.fillText(cd.config.label, 4 * dpr, y + 3 * dpr)

    // Min/max range labels (smaller, dimmer)
    staticCacheCtx.fillStyle = 'rgba(255,255,255,0.3)'
    staticCacheCtx.font = `${9 * dpr}px Consolas, monospace`
    staticCacheCtx.textAlign = 'left'
    staticCacheCtx.textBaseline = 'bottom'
    staticCacheCtx.fillText(`${cd.config.min}–${cd.config.max}`, 4 * dpr, y + chartH - 2 * dpr)

    // Separator line
    if (i > 0) {
      staticCacheCtx.strokeStyle = '#333'
      staticCacheCtx.lineWidth = 1 * dpr
      staticCacheCtx.beginPath()
      staticCacheCtx.moveTo(0, y)
      staticCacheCtx.lineTo(w, y)
      staticCacheCtx.stroke()
    }
  }

  // Lap markers — vertical dotted lines spanning all charts
  if (lapData?.hasLapData && duration > 0) {
    staticCacheCtx.strokeStyle = 'rgba(255,255,255,0.25)'
    staticCacheCtx.lineWidth = 1 * dpr
    staticCacheCtx.setLineDash([3 * dpr, 4 * dpr])
    const dataW = w - labelW
    for (const lap of lapData.laps) {
      const x = labelW + (lap.startTime / duration) * dataW
      staticCacheCtx.beginPath()
      staticCacheCtx.moveTo(x, 0)
      staticCacheCtx.lineTo(x, h)
      staticCacheCtx.stroke()
    }
    // End of last lap
    const lastLap = lapData.laps[lapData.laps.length - 1]
    if (lastLap) {
      const x = labelW + (lastLap.endTime / duration) * dataW
      staticCacheCtx.beginPath()
      staticCacheCtx.moveTo(x, 0)
      staticCacheCtx.lineTo(x, h)
      staticCacheCtx.stroke()
    }
    staticCacheCtx.setLineDash([])
  }
}

/** Composite static cache + current-value text into the frame cache. Called on row change. */
function renderFrameCache(): void {
  const w = frameCache.width
  const h = frameCache.height
  if (w === 0 || h === 0) return

  frameCacheCtx.clearRect(0, 0, w, h)

  // Blit static layer
  if (staticCache.width > 0 && staticCache.height > 0) {
    frameCacheCtx.drawImage(staticCache, 0, 0)
  }

  // Overlay current values (the only thing that changes per row)
  const chartCount = channelData.length
  if (chartCount === 0 || !currentRow) return

  const chartH = h / chartCount
  for (let i = 0; i < chartCount; i++) {
    const cd = channelData[i]
    const y = i * chartH
    const val = cd.config.rowAccessor(currentRow)
    frameCacheCtx.fillStyle = '#fff'
    frameCacheCtx.font = `bold ${11 * dpr}px Consolas, monospace`
    frameCacheCtx.textAlign = 'left'
    frameCacheCtx.textBaseline = 'top'
    frameCacheCtx.fillText(`${val.toFixed(cd.config.precision)} ${cd.config.unit}`, 4 * dpr, y + 17 * dpr)
  }
}

let lastPlayheadX = -1
let playheadDirty = true  // force first draw

/** Mark playhead as needing redraw (called on row change / resize). */
function invalidatePlayhead(): void {
  playheadDirty = true
}

/** Blit frame cache + draw playhead. Called every animation frame (very cheap). */
function drawPlayhead(): void {
  const w = canvas.width
  const h = canvas.height
  if (w === 0 || h === 0) return

  // Compute playhead position
  let x = -1
  if (channelData.length > 0 && video.duration > 0 && isFinite(video.duration)) {
    const labelW = LABEL_WIDTH * dpr
    const xPct = video.currentTime / video.duration
    x = Math.round(labelW + xPct * (w - labelW))
  }

  // Skip redraw when paused and playhead hasn't moved
  if (x === lastPlayheadX && !playheadDirty) return
  lastPlayheadX = x
  playheadDirty = false

  // Blit cached frame (one drawImage call)
  ctx.clearRect(0, 0, w, h)
  if (frameCache.width > 0 && frameCache.height > 0) {
    ctx.drawImage(frameCache, 0, 0)
  }

  // Playhead
  if (x >= 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1.5 * dpr
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
}
