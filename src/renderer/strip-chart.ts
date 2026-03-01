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
 *
 * Compare mode:
 *   - X-axis = normalized track position (distance-based, 0..1)
 *   - Dual traces: A = cyan, B = magenta
 *   - Delta-time virtual channel at the bottom
 *   - Playhead = trackPosition (0..1), not time-based
 *   - Click-to-seek converts x-fraction → track position → timeA via sync inverse lookup
 */

import type { TelemetryRow } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { telemetryStore, video, avSyncOffset, onRowUpdate, onFrameTick, onTelemetryLoad, currentRow, setCurrentRow, findRowAtTime, lapData, seekToTelemetryTime, getSyncedTime, viewRange, getViewDuration, viewFraction, viewFractionToTime, selectedLapIdx, onViewRangeChange } from './state'
import {
  isCompareMode,
  storeA, storeB,
  currentRowA, currentRowB,
  syncDataA, syncDataB,
  trackPosition,
  videoA,
  onCompareEnter,
  onCompareExit,
  onCompareLapChange,
} from './compare-state'
import { buildDeltaTime, trackPositionToTime } from './compare-sync'

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

// Unit conversion constants
const NM_TO_LBFT = 0.7376
const KW_TO_HP = 1.341
const KPA_TO_PSI = 0.145038
const C_TO_F_SCALE = 1.8
const C_TO_F_OFFSET = 32

const CHANNELS: ChartChannel[] = [
  { key: 'speed', label: 'Speed', color: '#3399ff', storeAccessor: s => s.speed_mph, scale: 1, rowAccessor: r => r.speed_mph, unit: 'mph', min: 0, max: 200, precision: 0, defaultEnabled: true },
  { key: 'rpm', label: 'RPM', color: '#ff6b00', storeAccessor: s => s.rpm, scale: 1, rowAccessor: r => r.rpm, unit: 'rpm', min: 0, max: 7000, precision: 0, defaultEnabled: true },
  { key: 'throttle', label: 'Throttle', color: '#00cc66', storeAccessor: s => s.throttle, scale: 100, rowAccessor: r => r.throttle * 100, unit: '%', min: 0, max: 100, precision: 0, defaultEnabled: true },
  { key: 'brake', label: 'Brake', color: '#ff3333', storeAccessor: s => s.brake, scale: 100, rowAccessor: r => r.brake * 100, unit: '%', min: 0, max: 100, precision: 0, defaultEnabled: true },
  { key: 'gear', label: 'Gear', color: '#88cc00', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: r => { const g = r.gear_raw; return (g !== undefined && g >= 1 && g <= 10) ? g : 0 }, unit: '', min: 0, max: 10, precision: 0, defaultEnabled: false },
  { key: 'gforce_lat', label: 'G Lat', color: '#66ccff', storeAccessor: s => s.gforce_lat, scale: 1, rowAccessor: r => r.gforce_lat, unit: 'g', min: -1.5, max: 1.5, precision: 2, defaultEnabled: false },
  { key: 'gforce_lon', label: 'G Lon', color: '#cc66ff', storeAccessor: s => s.gforce_lon, scale: 1, rowAccessor: r => r.gforce_lon, unit: 'g', min: -1.5, max: 1.5, precision: 2, defaultEnabled: false },
  { key: 'steering', label: 'Steering', color: '#ffcc00', storeAccessor: s => s.steering_deg, scale: 1, rowAccessor: r => r.steering_deg, unit: '\u00B0', min: -400, max: 400, precision: 0, defaultEnabled: false },
  // ── Engine / drivetrain (dense) ──
  { key: 'torque', label: 'Torque', color: '#e06030', storeAccessor: s => s.engine_torque_nm, scale: NM_TO_LBFT, rowAccessor: r => r.engine_torque_nm * NM_TO_LBFT, unit: 'lb-ft', min: -200, max: 800, precision: 0, defaultEnabled: false },
  { key: 'power', label: 'Power', color: '#d040d0', storeAccessor: s => s.engine_power_kw, scale: KW_TO_HP, rowAccessor: r => r.engine_power_kw * KW_TO_HP, unit: 'hp', min: 0, max: 700, precision: 0, defaultEnabled: false },
  { key: 'boost', label: 'Boost', color: '#40b0e0', storeAccessor: s => s.boost_pressure_kpa, scale: KPA_TO_PSI, rowAccessor: r => r.boost_pressure_kpa * KPA_TO_PSI, unit: 'psi', min: 0, max: 30, precision: 1, defaultEnabled: false },
  // ── Temperatures & pressures (sparse — forward-filled via scaledCache) ──
  { key: 'coolant_temp', label: 'Coolant', color: '#ff5050', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: sparseRowAccessor(r => r.engine_temp_coolant_c, C_TO_F_SCALE, C_TO_F_OFFSET), unit: '\u00B0F', min: 100, max: 280, precision: 0, defaultEnabled: false },
  { key: 'oil_temp', label: 'Oil Temp', color: '#e0a030', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: sparseRowAccessor(r => r.engine_temp_oil_c, C_TO_F_SCALE, C_TO_F_OFFSET), unit: '\u00B0F', min: 100, max: 320, precision: 0, defaultEnabled: false },
  { key: 'oil_press', label: 'Oil Press', color: '#c08040', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: sparseRowAccessor(r => r.oil_pressure_kpa, KPA_TO_PSI), unit: 'psi', min: 0, max: 120, precision: 0, defaultEnabled: false },
  { key: 'intake_temp', label: 'Intake', color: '#50c0c0', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: sparseRowAccessor(r => r.engine_temp_airintake_c, C_TO_F_SCALE, C_TO_F_OFFSET), unit: '\u00B0F', min: 30, max: 200, precision: 0, defaultEnabled: false },
  { key: 'trans_temp', label: 'Trans', color: '#a060c0', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: sparseRowAccessor(r => r.trans_oil_temp_c, C_TO_F_SCALE, C_TO_F_OFFSET), unit: '\u00B0F', min: 100, max: 320, precision: 0, defaultEnabled: false },
  { key: 'tire_temp_avg', label: 'Tire Avg', color: '#80d040', storeAccessor: () => new Float32Array(0), scale: 1, rowAccessor: (() => { let lastFL = 0, lastFR = 0, lastRL = 0, lastRR = 0; return (r: TelemetryRow) => { if (r.tire_temp_fl_c != null) lastFL = r.tire_temp_fl_c; if (r.tire_temp_fr_c != null) lastFR = r.tire_temp_fr_c; if (r.tire_temp_rl_c != null) lastRL = r.tire_temp_rl_c; if (r.tire_temp_rr_c != null) lastRR = r.tire_temp_rr_c; return ((lastFL + lastFR + lastRL + lastRR) / 4) * C_TO_F_SCALE + C_TO_F_OFFSET } })(), unit: '\u00B0F', min: 50, max: 250, precision: 0, defaultEnabled: false },
]

/** Convert sparse gear_raw to a dense numeric array with forward-fill. */
function buildDenseGear(sparseGear: (number | undefined)[], length: number): Float32Array {
  const dense = new Float32Array(length)
  let last = 0
  for (let i = 0; i < length; i++) {
    const raw = sparseGear[i]
    if (raw !== undefined) {
      last = (raw >= 1 && raw <= 10) ? raw : 0
    }
    dense[i] = last
  }
  return dense
}

/** Forward-fill a sparse (number | undefined | null)[] channel into a dense Float32Array with affine transform. */
function buildDenseSparse(
  sparse: (number | undefined | null)[], length: number,
  scale = 1, offset = 0,
): Float32Array {
  const dense = new Float32Array(length)
  let last = offset
  for (let i = 0; i < length; i++) {
    const v = sparse[i]
    if (v != null) last = v * scale + offset
    dense[i] = last
  }
  return dense
}

/** Build dense average tire temp from 4 sparse corner channels, output in °F. */
function buildDenseAvgTireTemp(
  fl: (number | undefined)[], fr: (number | undefined)[],
  rl: (number | undefined)[], rr: (number | undefined)[],
  length: number,
): Float32Array {
  const dense = new Float32Array(length)
  let lastFL = 0, lastFR = 0, lastRL = 0, lastRR = 0
  for (let i = 0; i < length; i++) {
    if (fl[i] !== undefined) lastFL = fl[i]!
    if (fr[i] !== undefined) lastFR = fr[i]!
    if (rl[i] !== undefined) lastRL = rl[i]!
    if (rr[i] !== undefined) lastRR = rr[i]!
    const avgC = (lastFL + lastFR + lastRL + lastRR) / 4
    dense[i] = avgC * 1.8 + 32
  }
  return dense
}

/** Create a stateful rowAccessor for sparse channels — remembers last defined value to prevent HUD flicker. */
function sparseRowAccessor(
  getter: (r: TelemetryRow) => number | undefined | null,
  scale = 1, offset = 0,
): (r: TelemetryRow) => number {
  let last = 0
  return (r) => {
    const v = getter(r)
    if (v != null) last = v * scale + offset
    return last
  }
}

const CHANNELS_STORAGE_KEY = 'pdr-chart-channels'
const DELTA_KEY = 'delta'           // toggle key for delta-time chart (compare mode only)
const DELTA_COLOR = '#ffaa00'       // toolbar button color
const LABEL_WIDTH = 80  // px reserved for axis labels on left

const COLOR_A = '#00e5ff'   // cyan
const COLOR_B = '#ff40ff'   // magenta
const ALPHA_A = 1.0
const ALPHA_B = 0.7

// ── Per-channel offscreen data ──

interface ChannelData {
  config: ChartChannel
  values: ArrayLike<number>  // typed array from store (or scaled copy)
  times: Float64Array        // store.time — shared across all channels
  offscreen: HTMLCanvasElement  // use HTMLCanvasElement (not OffscreenCanvas) for broader compat
  ctx: CanvasRenderingContext2D
}

// Compare mode per-channel offscreen: holds both A and B traces on one canvas
interface CompareChannelData {
  config: ChartChannel
  valuesA: ArrayLike<number>
  valuesB: ArrayLike<number>
  syncDistA: Float64Array   // dist[] from syncDataA (indexed per-lap)
  syncDistB: Float64Array   // dist[] from syncDataB
  offscreen: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

// Delta time channel (compare mode only)
interface DeltaChannelData {
  delta: Float32Array  // buildDeltaTime() output, length = DELTA_SAMPLES
  offscreen: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

const DELTA_SAMPLES = 200

let channelData: ChannelData[] = []
let compareChannelData: CompareChannelData[] = []
let deltaChannelData: DeltaChannelData | null = null

/** Cached scaled arrays, keyed by channel key. Rebuilt only on telemetry load. */
let scaledCache = new Map<string, Float32Array>()
/** Cached scaled arrays for storeA and storeB in compare mode. */
let scaledCacheA = new Map<string, Float32Array>()
let scaledCacheB = new Map<string, Float32Array>()

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

  // Subscribe to telemetry load (single-file mode)
  onTelemetryLoad(() => {
    if (isCompareMode()) return
    buildScaledCache()
    rebuildChannelData()
    resizeAndRender()
    chartEmpty.classList.add('hidden')
  })

  // On row change: rebuild frame cache (labels show new current values)
  onRowUpdate(() => { renderFrameCache(); invalidatePlayhead(); drawPlayhead() })

  // On every animation frame: just blit cache + draw playhead (very cheap)
  onFrameTick(() => drawPlayhead())

  // On view range change: re-render charts with new time range
  onViewRangeChange(() => { if (!isCompareMode()) resizeAndRender() })

  // Compare mode lifecycle
  onCompareEnter(() => {
    buildToolbar()  // show delta toggle button
    buildScaledCacheCompare()
    rebuildCompareChannelData()
    resizeAndRender()
    chartEmpty.classList.add('hidden')
  })
  onCompareExit(() => {
    compareChannelData = []
    deltaChannelData = null
    scaledCacheA.clear()
    scaledCacheB.clear()
    buildToolbar()  // remove delta toggle button
    // Restore single-file mode
    buildScaledCache()
    rebuildChannelData()
    resizeAndRender()
  })
  onCompareLapChange(() => {
    // Rebuild sync-dependent data (scaled caches are already correct, dist arrays change)
    rebuildCompareChannelData()
    resizeAndRender()
  })

  // Resize observer
  const ro = new ResizeObserver(() => {
    resizeAndRender()
  })
  ro.observe(container)

  // Click-to-seek + drag-to-scrub
  function seekToPointer(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect()
    const xPct = (e.clientX - rect.left - LABEL_WIDTH) / (rect.width - LABEL_WIDTH)
    if (xPct < 0 || xPct > 1) return

    if (isCompareMode()) {
      // xPct = track position (0..1); convert to time via syncDataA, then seek videoA
      const sd = syncDataA
      const va = videoA
      if (!sd || !va) return
      const telTime = trackPositionToTime(sd, xPct)
      va.currentTime = telTime - avSyncOffset
    } else {
      if (getViewDuration() > 0) {
        seekToTelemetryTime(viewFractionToTime(xPct))
        setCurrentRow(findRowAtTime(video.currentTime))
      }
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
  const keys = new Set(CHANNELS.filter(c => c.defaultEnabled).map(c => c.key))
  keys.add(DELTA_KEY)
  return keys
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
      if (isCompareMode()) {
        rebuildCompareChannelData()
      } else {
        rebuildChannelData()
      }
      resizeAndRender()
    })
    toolbar.appendChild(btn)
  }

  // In compare mode, add a delta-time toggle button
  if (isCompareMode()) {
    const btn = document.createElement('button')
    btn.className = 'chart-channel-btn'
    btn.textContent = '\u0394 Time'
    if (enabledKeys.has(DELTA_KEY)) {
      btn.classList.add('active')
      btn.style.color = DELTA_COLOR
      btn.style.borderColor = DELTA_COLOR
    }
    btn.addEventListener('click', () => {
      if (enabledKeys.has(DELTA_KEY)) {
        enabledKeys.delete(DELTA_KEY)
        btn.classList.remove('active')
        btn.style.color = ''
        btn.style.borderColor = ''
      } else {
        enabledKeys.add(DELTA_KEY)
        btn.classList.add('active')
        btn.style.color = DELTA_COLOR
        btn.style.borderColor = DELTA_COLOR
      }
      saveEnabledKeys()
      rebuildCompareChannelData()
      resizeAndRender()
    })
    toolbar.appendChild(btn)
  }
}

/** Pre-compute scaled arrays for channels with scale !== 1, plus dense gear. Called once on telemetry load. */
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
  // Gear: build dense array from sparse gear_raw with forward-fill
  scaledCache.set('gear', buildDenseGear(store.gear_raw, store.length))
  // Sparse numeric channels: forward-fill + unit conversion
  scaledCache.set('coolant_temp', buildDenseSparse(store.engine_temp_coolant_c, store.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCache.set('oil_temp', buildDenseSparse(store.engine_temp_oil_c, store.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCache.set('oil_press', buildDenseSparse(store.oil_pressure_kpa, store.length, KPA_TO_PSI))
  scaledCache.set('intake_temp', buildDenseSparse(store.engine_temp_airintake_c, store.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCache.set('trans_temp', buildDenseSparse(store.trans_oil_temp_c, store.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCache.set('tire_temp_avg', buildDenseAvgTireTemp(store.tire_temp_fl_c, store.tire_temp_fr_c, store.tire_temp_rl_c, store.tire_temp_rr_c, store.length))
}

function buildScaledCacheCompare(): void {
  scaledCacheA.clear()
  scaledCacheB.clear()
  const sa = storeA
  const sb = storeB
  if (!sa || !sb) return
  for (const config of CHANNELS) {
    if (config.scale !== 1) {
      const rawA = config.storeAccessor(sa)
      const scaledA = new Float32Array(sa.length)
      for (let i = 0; i < sa.length; i++) scaledA[i] = rawA[i] * config.scale
      scaledCacheA.set(config.key, scaledA)

      const rawB = config.storeAccessor(sb)
      const scaledB = new Float32Array(sb.length)
      for (let i = 0; i < sb.length; i++) scaledB[i] = rawB[i] * config.scale
      scaledCacheB.set(config.key, scaledB)
    }
  }
  // Gear: build dense arrays for A and B
  scaledCacheA.set('gear', buildDenseGear(sa.gear_raw, sa.length))
  scaledCacheB.set('gear', buildDenseGear(sb.gear_raw, sb.length))
  // Sparse numeric channels for A
  scaledCacheA.set('coolant_temp', buildDenseSparse(sa.engine_temp_coolant_c, sa.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheA.set('oil_temp', buildDenseSparse(sa.engine_temp_oil_c, sa.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheA.set('oil_press', buildDenseSparse(sa.oil_pressure_kpa, sa.length, KPA_TO_PSI))
  scaledCacheA.set('intake_temp', buildDenseSparse(sa.engine_temp_airintake_c, sa.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheA.set('trans_temp', buildDenseSparse(sa.trans_oil_temp_c, sa.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheA.set('tire_temp_avg', buildDenseAvgTireTemp(sa.tire_temp_fl_c, sa.tire_temp_fr_c, sa.tire_temp_rl_c, sa.tire_temp_rr_c, sa.length))
  // Sparse numeric channels for B
  scaledCacheB.set('coolant_temp', buildDenseSparse(sb.engine_temp_coolant_c, sb.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheB.set('oil_temp', buildDenseSparse(sb.engine_temp_oil_c, sb.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheB.set('oil_press', buildDenseSparse(sb.oil_pressure_kpa, sb.length, KPA_TO_PSI))
  scaledCacheB.set('intake_temp', buildDenseSparse(sb.engine_temp_airintake_c, sb.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheB.set('trans_temp', buildDenseSparse(sb.trans_oil_temp_c, sb.length, C_TO_F_SCALE, C_TO_F_OFFSET))
  scaledCacheB.set('tire_temp_avg', buildDenseAvgTireTemp(sb.tire_temp_fl_c, sb.tire_temp_fr_c, sb.tire_temp_rl_c, sb.tire_temp_rr_c, sb.length))
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

function rebuildCompareChannelData(): void {
  const sa = storeA
  const sb = storeB
  const sda = syncDataA
  const sdb = syncDataB
  if (!sa || !sb || !sda || !sdb) {
    compareChannelData = []
    deltaChannelData = null
    return
  }

  const enabled = CHANNELS.filter(c => enabledKeys.has(c.key))

  compareChannelData = enabled.map(config => {
    const valuesA = scaledCacheA.get(config.key) ?? config.storeAccessor(sa)
    const valuesB = scaledCacheB.get(config.key) ?? config.storeAccessor(sb)
    const offscreen = document.createElement('canvas')
    const offCtx = offscreen.getContext('2d')!
    return {
      config,
      valuesA,
      valuesB,
      syncDistA: sda.dist,
      syncDistB: sdb.dist,
      offscreen,
      ctx: offCtx,
    }
  })

  // Build delta-time channel (only if toggled on)
  if (enabledKeys.has(DELTA_KEY)) {
    const delta = buildDeltaTime(sda, sdb, DELTA_SAMPLES)
    const offscreen = document.createElement('canvas')
    const offCtx = offscreen.getContext('2d')!
    deltaChannelData = { delta, offscreen, ctx: offCtx }
  } else {
    deltaChannelData = null
  }
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

  if (isCompareMode()) {
    const totalCharts = compareChannelData.length + (deltaChannelData ? 1 : 0)
    const chartCount = totalCharts || 1
    const chartH = Math.floor((h * dpr) / chartCount)
    const chartW = Math.floor((w - LABEL_WIDTH) * dpr)

    for (const cd of compareChannelData) {
      cd.offscreen.width = chartW
      cd.offscreen.height = chartH
      renderCompareChannelOffscreen(cd, chartW, chartH)
    }

    if (deltaChannelData) {
      deltaChannelData.offscreen.width = chartW
      deltaChannelData.offscreen.height = chartH
      renderDeltaOffscreen(deltaChannelData, chartW, chartH)
    }
  } else {
    // Render each channel offscreen
    const chartCount = channelData.length || 1
    const chartH = Math.floor((h * dpr) / chartCount)
    const chartW = Math.floor((w - LABEL_WIDTH) * dpr)

    for (const cd of channelData) {
      cd.offscreen.width = chartW
      cd.offscreen.height = chartH
      renderChannelOffscreen(cd, chartW, chartH)
    }
  }

  renderStaticCache()
  renderFrameCache()
  invalidatePlayhead()
  drawPlayhead()
}

/** Binary search: find first index where times[i] >= target */
function lowerBound(times: Float64Array, len: number, target: number): number {
  let lo = 0, hi = len
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Binary search: find last index where times[i] <= target */
function upperBound(times: Float64Array, len: number, target: number): number {
  let lo = 0, hi = len - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (times[mid] > target) hi = mid - 1
    else lo = mid
  }
  return lo
}

function renderChannelOffscreen(cd: ChannelData, w: number, h: number): void {
  const { ctx: offCtx, values, times, config } = cd
  offCtx.clearRect(0, 0, w, h)

  const vd = getViewDuration()
  if (values.length < 2 || vd <= 0) return

  const vStart = viewRange.startTime
  const vEnd = viewRange.endTime

  // Find sample index range within the view window
  const iStart = Math.max(0, lowerBound(times, values.length, vStart) - 1)
  const iEnd = Math.min(values.length - 1, upperBound(times, values.length, vEnd) + 1)

  const range = config.max - config.min || 1
  const margin = 4 * dpr
  const drawH = h - margin * 2

  offCtx.strokeStyle = config.color
  offCtx.lineWidth = 1.5 * dpr
  offCtx.beginPath()

  const visibleCount = iEnd - iStart + 1
  const pxPerSample = w / visibleCount
  if (pxPerSample >= 1) {
    // Enough room: draw every visible point
    let first = true
    for (let i = iStart; i <= iEnd; i++) {
      const x = viewFraction(times[i]) * w
      const y = h - margin - ((values[i] - config.min) / range) * drawH
      if (first) { offCtx.moveTo(x, y); first = false }
      else offCtx.lineTo(x, y)
    }
  } else {
    // More samples than pixels: use min/max bucketing per pixel column
    let sampleIdx = iStart
    for (let px = 0; px < w; px++) {
      const tStart = viewFractionToTime(px / w)
      const tEnd = viewFractionToTime((px + 1) / w)
      let bucketMin = Infinity
      let bucketMax = -Infinity
      let count = 0

      while (sampleIdx <= iEnd && times[sampleIdx] < tEnd) {
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

/**
 * Render a single trace onto an existing offscreen canvas for compare mode.
 * dist[] is the normalized distance array for the lap (same length as values within startIdx..endIdx).
 * values is the full-store array; startIdx/endIdx bound the lap.
 */
function renderCompareSingleTrace(
  offCtx: CanvasRenderingContext2D,
  values: ArrayLike<number>,
  dist: Float64Array,
  startIdx: number,
  config: ChartChannel,
  w: number,
  h: number,
  color: string,
  alpha: number,
): void {
  const n = dist.length
  if (n < 2) return

  const range = config.max - config.min || 1
  const margin = 4 * dpr
  const drawH = h - margin * 2

  offCtx.globalAlpha = alpha
  offCtx.strokeStyle = color
  offCtx.lineWidth = 1.5 * dpr
  offCtx.beginPath()

  let first = true
  for (let i = 0; i < n; i++) {
    const x = dist[i] * w
    const v = values[startIdx + i]
    const y = h - margin - ((v - config.min) / range) * drawH
    if (first) { offCtx.moveTo(x, y); first = false }
    else offCtx.lineTo(x, y)
  }
  offCtx.stroke()
  offCtx.globalAlpha = 1.0
}

function renderCompareChannelOffscreen(cd: CompareChannelData, w: number, h: number): void {
  const { ctx: offCtx, valuesA, valuesB, syncDistA, syncDistB, config } = cd
  offCtx.clearRect(0, 0, w, h)

  const sda = syncDataA
  const sdb = syncDataB
  if (!sda || !sdb) return

  // Zero line for bipolar channels
  if (config.min < 0) {
    const range = config.max - config.min || 1
    const margin = 4 * dpr
    const drawH = h - margin * 2
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

  // Draw B first (lower alpha, below A)
  renderCompareSingleTrace(offCtx, valuesB, syncDistB, sdb.startIdx, config, w, h, COLOR_B, ALPHA_B)
  // Draw A on top
  renderCompareSingleTrace(offCtx, valuesA, syncDistA, sda.startIdx, config, w, h, COLOR_A, ALPHA_A)
}

function renderDeltaOffscreen(dd: DeltaChannelData, w: number, h: number): void {
  const { ctx: offCtx, delta } = dd
  offCtx.clearRect(0, 0, w, h)

  const n = delta.length
  if (n < 2) return

  const margin = 4 * dpr
  const drawH = h - margin * 2

  // Auto-range: find max absolute value
  let maxAbs = 0.5
  for (let i = 0; i < n; i++) {
    const a = Math.abs(delta[i])
    if (a > maxAbs) maxAbs = a
  }
  maxAbs = Math.ceil(maxAbs * 10) / 10  // round up to nearest 0.1s

  const zeroY = h - margin - (drawH / 2)

  // Zero reference line
  offCtx.strokeStyle = 'rgba(255,255,255,0.2)'
  offCtx.lineWidth = 1 * dpr
  offCtx.setLineDash([3 * dpr, 4 * dpr])
  offCtx.beginPath()
  offCtx.moveTo(0, zeroY)
  offCtx.lineTo(w, zeroY)
  offCtx.stroke()
  offCtx.setLineDash([])

  // Draw filled area chart: two passes (one for positive, one for negative)
  // delta[i] > 0 → A is slower → red (B is faster)
  // delta[i] < 0 → A is faster → green

  // Build polygon points
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < n; i++) {
    const pos = i / (n - 1)
    xs.push(pos * w)
    const v = Math.max(-maxAbs, Math.min(maxAbs, delta[i]))
    ys.push(h - margin - ((v + maxAbs) / (2 * maxAbs)) * drawH)
  }

  // Positive area (A is slower, delta > 0, above zero → red)
  offCtx.beginPath()
  offCtx.moveTo(xs[0], zeroY)
  for (let i = 0; i < n; i++) {
    const clampedY = Math.min(ys[i], zeroY)  // only above zero line (delta > 0 maps to lower y)
    offCtx.lineTo(xs[i], clampedY)
  }
  offCtx.lineTo(xs[n - 1], zeroY)
  offCtx.closePath()
  offCtx.fillStyle = 'rgba(255,60,60,0.4)'
  offCtx.fill()

  // Negative area (A is faster, delta < 0, below zero → green)
  offCtx.beginPath()
  offCtx.moveTo(xs[0], zeroY)
  for (let i = 0; i < n; i++) {
    const clampedY = Math.max(ys[i], zeroY)  // only below zero line (delta < 0 maps to higher y)
    offCtx.lineTo(xs[i], clampedY)
  }
  offCtx.lineTo(xs[n - 1], zeroY)
  offCtx.closePath()
  offCtx.fillStyle = 'rgba(60,220,60,0.4)'
  offCtx.fill()

  // Outline trace
  offCtx.strokeStyle = 'rgba(255,255,255,0.5)'
  offCtx.lineWidth = 1 * dpr
  offCtx.beginPath()
  offCtx.moveTo(xs[0], ys[0])
  for (let i = 1; i < n; i++) offCtx.lineTo(xs[i], ys[i])
  offCtx.stroke()
}

/** Render data traces + lap markers + static labels to the static cache. Called on resize/channel toggle. */
function renderStaticCache(): void {
  const w = staticCache.width
  const h = staticCache.height
  if (w === 0 || h === 0) return

  staticCacheCtx.clearRect(0, 0, w, h)
  const labelW = LABEL_WIDTH * dpr

  if (isCompareMode()) {
    const totalCharts = compareChannelData.length + (deltaChannelData ? 1 : 0)
    if (totalCharts === 0) return

    const chartH = h / totalCharts

    for (let i = 0; i < compareChannelData.length; i++) {
      const cd = compareChannelData[i]
      const y = i * chartH

      staticCacheCtx.drawImage(cd.offscreen, labelW, y, w - labelW, chartH)

      // Label background
      staticCacheCtx.fillStyle = 'rgba(26,26,26,0.85)'
      staticCacheCtx.fillRect(0, y, labelW, chartH)

      // Channel label (top line) — in default color
      staticCacheCtx.fillStyle = cd.config.color
      staticCacheCtx.font = `bold ${11 * dpr}px Consolas, monospace`
      staticCacheCtx.textAlign = 'left'
      staticCacheCtx.textBaseline = 'top'
      staticCacheCtx.fillText(cd.config.label, 4 * dpr, y + 3 * dpr)

      // Min/max range labels
      staticCacheCtx.fillStyle = 'rgba(255,255,255,0.3)'
      staticCacheCtx.font = `${9 * dpr}px Consolas, monospace`
      staticCacheCtx.textAlign = 'left'
      staticCacheCtx.textBaseline = 'bottom'
      staticCacheCtx.fillText(`${cd.config.min}–${cd.config.max}`, 4 * dpr, y + chartH - 2 * dpr)

      if (i > 0) {
        staticCacheCtx.strokeStyle = '#333'
        staticCacheCtx.lineWidth = 1 * dpr
        staticCacheCtx.beginPath()
        staticCacheCtx.moveTo(0, y)
        staticCacheCtx.lineTo(w, y)
        staticCacheCtx.stroke()
      }
    }

    // Delta time channel
    if (deltaChannelData) {
      const i = compareChannelData.length
      const y = i * chartH

      staticCacheCtx.drawImage(deltaChannelData.offscreen, labelW, y, w - labelW, chartH)

      staticCacheCtx.fillStyle = 'rgba(26,26,26,0.85)'
      staticCacheCtx.fillRect(0, y, labelW, chartH)

      staticCacheCtx.fillStyle = 'rgba(255,255,255,0.7)'
      staticCacheCtx.font = `bold ${11 * dpr}px Consolas, monospace`
      staticCacheCtx.textAlign = 'left'
      staticCacheCtx.textBaseline = 'top'
      staticCacheCtx.fillText('\u0394 Time', 4 * dpr, y + 3 * dpr)

      staticCacheCtx.fillStyle = 'rgba(255,255,255,0.3)'
      staticCacheCtx.font = `${9 * dpr}px Consolas, monospace`
      staticCacheCtx.textBaseline = 'bottom'
      staticCacheCtx.fillText('sec', 4 * dpr, y + chartH - 2 * dpr)

      staticCacheCtx.strokeStyle = '#333'
      staticCacheCtx.lineWidth = 1 * dpr
      staticCacheCtx.beginPath()
      staticCacheCtx.moveTo(0, y)
      staticCacheCtx.lineTo(w, y)
      staticCacheCtx.stroke()
    }

    return
  }

  // Single-file mode
  const chartCount = channelData.length
  if (chartCount === 0) return

  const chartH = h / chartCount

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

  // Lap markers — skip when viewing a single lap (entire view IS one lap)
  if (lapData?.hasLapData && getViewDuration() > 0 && selectedLapIdx === null) {
    staticCacheCtx.strokeStyle = 'rgba(255,255,255,0.25)'
    staticCacheCtx.lineWidth = 1 * dpr
    staticCacheCtx.setLineDash([3 * dpr, 4 * dpr])
    const dataW = w - labelW
    for (const lap of lapData.laps) {
      const frac = viewFraction(lap.startTime)
      if (frac < 0 || frac > 1) continue
      const x = labelW + frac * dataW
      staticCacheCtx.beginPath()
      staticCacheCtx.moveTo(x, 0)
      staticCacheCtx.lineTo(x, h)
      staticCacheCtx.stroke()
    }
    // End of last lap
    const lastLap = lapData.laps[lapData.laps.length - 1]
    if (lastLap) {
      const frac = viewFraction(lastLap.endTime)
      if (frac >= 0 && frac <= 1) {
        const x = labelW + frac * dataW
        staticCacheCtx.beginPath()
        staticCacheCtx.moveTo(x, 0)
        staticCacheCtx.lineTo(x, h)
        staticCacheCtx.stroke()
      }
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

  if (isCompareMode()) {
    renderFrameCacheCompare(w, h)
    return
  }

  // Single-file: overlay current values
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

function renderFrameCacheCompare(_w: number, h: number): void {
  const totalCharts = compareChannelData.length + (deltaChannelData ? 1 : 0)
  if (totalCharts === 0) return

  const chartH = h / totalCharts

  for (let i = 0; i < compareChannelData.length; i++) {
    const cd = compareChannelData[i]
    const y = i * chartH

    const rowA = currentRowA
    const rowB = currentRowB

    const valA = rowA ? cd.config.rowAccessor(rowA) : null
    const valB = rowB ? cd.config.rowAccessor(rowB) : null

    frameCacheCtx.font = `bold ${10 * dpr}px Consolas, monospace`
    frameCacheCtx.textAlign = 'left'
    frameCacheCtx.textBaseline = 'top'

    // "A: value"  "B: value" stacked
    if (valA !== null) {
      frameCacheCtx.fillStyle = COLOR_A
      frameCacheCtx.fillText(`A: ${valA.toFixed(cd.config.precision)}`, 4 * dpr, y + 16 * dpr)
    }
    if (valB !== null) {
      frameCacheCtx.fillStyle = COLOR_B
      frameCacheCtx.fillText(`B: ${valB.toFixed(cd.config.precision)}`, 4 * dpr, y + 28 * dpr)
    }
  }

  // Delta time label
  if (deltaChannelData) {
    const i = compareChannelData.length
    const y = i * chartH
    const sda = syncDataA
    const sdb = syncDataB
    if (sda && sdb) {
      const tp = trackPosition
      // Interpolate delta at current track position
      const idx = Math.round(tp * (DELTA_SAMPLES - 1))
      const clampedIdx = Math.max(0, Math.min(DELTA_SAMPLES - 1, idx))
      const dVal = deltaChannelData.delta[clampedIdx]

      frameCacheCtx.font = `bold ${10 * dpr}px Consolas, monospace`
      frameCacheCtx.textAlign = 'left'
      frameCacheCtx.textBaseline = 'top'

      if (dVal < 0) {
        // A is faster
        frameCacheCtx.fillStyle = '#3cdc3c'
        frameCacheCtx.fillText(`A +${Math.abs(dVal).toFixed(3)}s`, 4 * dpr, y + 16 * dpr)
      } else if (dVal > 0) {
        // B is faster
        frameCacheCtx.fillStyle = '#ff3c3c'
        frameCacheCtx.fillText(`B +${dVal.toFixed(3)}s`, 4 * dpr, y + 16 * dpr)
      } else {
        frameCacheCtx.fillStyle = '#fff'
        frameCacheCtx.fillText('0.000s', 4 * dpr, y + 16 * dpr)
      }
    }
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
  if (isCompareMode()) {
    const totalCharts = compareChannelData.length + (deltaChannelData ? 1 : 0)
    if (totalCharts > 0) {
      const labelW = LABEL_WIDTH * dpr
      x = Math.round(labelW + trackPosition * (w - labelW))
    }
  } else {
    if (channelData.length > 0 && getViewDuration() > 0) {
      const labelW = LABEL_WIDTH * dpr
      const xPct = viewFraction(getSyncedTime())
      x = Math.round(labelW + xPct * (w - labelW))
    }
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
