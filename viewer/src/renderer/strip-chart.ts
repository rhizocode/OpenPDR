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
import { telemetry, duration, video, onRowUpdate, onFrameTick, onTelemetryLoad, currentRow, setCurrentRow, findRowAtTime } from './state'

// ── Channel configuration ──

interface ChartChannel {
  key: string
  label: string
  color: string
  accessor: (row: TelemetryRow) => number
  unit: string
  min: number
  max: number
  precision: number  // decimal places for display (0 = whole numbers)
  defaultEnabled: boolean
}

const CHANNELS: ChartChannel[] = [
  { key: 'speed', label: 'Speed', color: '#3399ff', accessor: r => r.speed_mph, unit: 'mph', min: 0, max: 200, precision: 0, defaultEnabled: true },
  { key: 'rpm', label: 'RPM', color: '#ff6b00', accessor: r => r.rpm, unit: 'rpm', min: 0, max: 7000, precision: 0, defaultEnabled: true },
  { key: 'throttle', label: 'Throttle', color: '#00cc66', accessor: r => r.throttle * 100, unit: '%', min: 0, max: 100, precision: 0, defaultEnabled: true },
  { key: 'brake', label: 'Brake', color: '#ff3333', accessor: r => r.brake * 100, unit: '%', min: 0, max: 100, precision: 0, defaultEnabled: true },
  { key: 'gforce_lat', label: 'G Lat', color: '#66ccff', accessor: r => r.gforce_lat, unit: 'g', min: -1.5, max: 1.5, precision: 2, defaultEnabled: false },
  { key: 'gforce_lon', label: 'G Lon', color: '#cc66ff', accessor: r => r.gforce_lon, unit: 'g', min: -1.5, max: 1.5, precision: 2, defaultEnabled: false },
  { key: 'steering', label: 'Steering', color: '#ffcc00', accessor: r => r.steering_deg, unit: '\u00B0', min: -400, max: 400, precision: 0, defaultEnabled: false },
]

const CHANNELS_STORAGE_KEY = 'pdr-chart-channels'
const LABEL_WIDTH = 80  // px reserved for axis labels on left

// ── Per-channel offscreen data ──

interface ChannelData {
  config: ChartChannel
  values: number[]
  times: number[]
  offscreen: HTMLCanvasElement  // use HTMLCanvasElement (not OffscreenCanvas) for broader compat
  ctx: CanvasRenderingContext2D
}

let channelData: ChannelData[] = []
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

// Frame cache: holds composited data traces + labels (everything except playhead).
// Rebuilt only on row change or resize. Per-frame work is just blit + playhead line.
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

  // Create frame cache canvas (offscreen buffer for data + labels)
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
    rebuildChannelData()
    resizeAndRender()
    chartEmpty.classList.add('hidden')
  })

  // On row change: rebuild frame cache (labels show new current values)
  onRowUpdate(() => { renderFrameCache(); drawPlayhead() })

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

function rebuildChannelData(): void {
  const rows = telemetry
  const dur = duration
  if (rows.length === 0) {
    channelData = []
    return
  }

  const enabled = CHANNELS.filter(c => enabledKeys.has(c.key))
  channelData = enabled.map(config => {
    const values = rows.map(config.accessor)
    const times = rows.map(r => r.time)
    const offscreen = document.createElement('canvas')
    const offCtx = offscreen.getContext('2d')!
    return { config, values, times, offscreen, ctx: offCtx }
  })
}

function resizeAndRender(): void {
  const w = container.clientWidth
  const h = container.clientHeight
  if (w === 0 || h === 0) return

  // Size visible canvas + frame cache for high-DPI
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
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

  renderFrameCache()
  drawPlayhead()
}

function renderChannelOffscreen(cd: ChannelData, w: number, h: number): void {
  const { ctx: offCtx, values, times, config } = cd
  offCtx.clearRect(0, 0, w, h)

  if (values.length < 2 || duration <= 0) return

  const range = config.max - config.min || 1
  const margin = 4 * dpr

  offCtx.strokeStyle = config.color
  offCtx.lineWidth = 1.5 * dpr
  offCtx.beginPath()

  for (let i = 0; i < values.length; i++) {
    const x = (times[i] / duration) * w
    const y = h - margin - ((values[i] - config.min) / range) * (h - margin * 2)
    if (i === 0) offCtx.moveTo(x, y)
    else offCtx.lineTo(x, y)
  }
  offCtx.stroke()

  // Zero line for bipolar channels (g-force, steering)
  if (config.min < 0) {
    const zeroY = h - margin - ((0 - config.min) / range) * (h - margin * 2)
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

/** Render data traces + labels to the frame cache. Called on row change, resize, channel toggle. */
function renderFrameCache(): void {
  const w = frameCache.width
  const h = frameCache.height
  if (w === 0 || h === 0) return

  frameCacheCtx.clearRect(0, 0, w, h)

  const chartCount = channelData.length
  if (chartCount === 0) return

  const chartH = h / chartCount
  const labelW = LABEL_WIDTH * dpr

  for (let i = 0; i < chartCount; i++) {
    const cd = channelData[i]
    const y = i * chartH

    // Draw offscreen data to the right of the label area
    frameCacheCtx.drawImage(cd.offscreen, labelW, y, w - labelW, chartH)

    // Label background
    frameCacheCtx.fillStyle = 'rgba(26,26,26,0.85)'
    frameCacheCtx.fillRect(0, y, labelW, chartH)

    // Channel label (top line)
    frameCacheCtx.fillStyle = cd.config.color
    frameCacheCtx.font = `bold ${11 * dpr}px Consolas, monospace`
    frameCacheCtx.textAlign = 'left'
    frameCacheCtx.textBaseline = 'top'
    frameCacheCtx.fillText(cd.config.label, 4 * dpr, y + 3 * dpr)

    // Current value (second line, below label)
    if (currentRow) {
      const val = cd.config.accessor(currentRow)
      frameCacheCtx.fillStyle = '#fff'
      frameCacheCtx.font = `bold ${11 * dpr}px Consolas, monospace`
      frameCacheCtx.textAlign = 'left'
      frameCacheCtx.textBaseline = 'top'
      frameCacheCtx.fillText(`${val.toFixed(cd.config.precision)} ${cd.config.unit}`, 4 * dpr, y + 17 * dpr)
    }

    // Min/max range labels (smaller, dimmer)
    frameCacheCtx.fillStyle = 'rgba(255,255,255,0.3)'
    frameCacheCtx.font = `${9 * dpr}px Consolas, monospace`
    frameCacheCtx.textAlign = 'left'
    frameCacheCtx.textBaseline = 'bottom'
    frameCacheCtx.fillText(`${cd.config.min}–${cd.config.max}`, 4 * dpr, y + chartH - 2 * dpr)

    // Separator line
    if (i > 0) {
      frameCacheCtx.strokeStyle = '#333'
      frameCacheCtx.lineWidth = 1 * dpr
      frameCacheCtx.beginPath()
      frameCacheCtx.moveTo(0, y)
      frameCacheCtx.lineTo(w, y)
      frameCacheCtx.stroke()
    }
  }
}

/** Blit frame cache + draw playhead. Called every animation frame (very cheap). */
function drawPlayhead(): void {
  const w = canvas.width
  const h = canvas.height
  if (w === 0 || h === 0) return

  // Blit cached frame (one drawImage call)
  ctx.clearRect(0, 0, w, h)
  if (frameCache.width > 0 && frameCache.height > 0) {
    ctx.drawImage(frameCache, 0, 0)
  }

  // Playhead
  if (channelData.length > 0 && video.duration > 0 && isFinite(video.duration)) {
    const labelW = LABEL_WIDTH * dpr
    const xPct = video.currentTime / video.duration
    const x = labelW + xPct * (w - labelW)

    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.lineWidth = 1.5 * dpr
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
}
