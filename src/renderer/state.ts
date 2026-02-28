/**
 * OpenPDR Viewer — Shared application state + event bus
 *
 * Central state that all renderer modules read from. Modules subscribe
 * to updates via onRowUpdate() and onTelemetryLoad(). The animation
 * loop in main.ts drives updates by calling setCurrentRow().
 */

import type { TelemetryRow, LapData } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { getRow } from '../shared/telemetry-store'

// ── State ──
export let telemetryStore: TelemetryStore | null = null
export let currentRow: TelemetryRow | null = null
export let duration = 0
export let lapData: LapData | null = null

// ── Interpolation state ──
// Exposed so modules (track-map, hud) can interpolate between bracketing rows.
// Updated every animation frame by the animation loop in main.ts.
export let interpPrev: TelemetryRow | null = null
export let interpNext: TelemetryRow | null = null
export let interpAlpha = 0  // 0..1 fraction between prev and next

export function setLapData(data: LapData | null): void {
  lapData = data
}

// ── Audio-to-video sync offset ──
// HTML5 video decoders often buffer audio ahead of the decoded video frame.
// video.currentTime reflects the video frame position, but the user hears audio
// that corresponds to a slightly later point in time. This offset (in seconds)
// is added to the telemetry lookup time so HUD indicators lead the video frame
// to match the audio timing.  Positive = telemetry leads video (compensates for
// audio being ahead).
const AV_SYNC_KEY = 'pdr-av-sync-offset'
export let avSyncOffset = loadAvSyncOffset()

function loadAvSyncOffset(): number {
  const saved = localStorage.getItem(AV_SYNC_KEY)
  if (saved) {
    const v = parseFloat(saved)
    if (!Number.isNaN(v)) return v
  }
  return 0.15  // default 150ms — typical browser audio lead
}

export function setAvSyncOffset(seconds: number): void {
  avSyncOffset = seconds
  localStorage.setItem(AV_SYNC_KEY, seconds.toFixed(3))
}

// ── DOM refs (shared across modules) ──
export const video = document.getElementById('video') as HTMLVideoElement

// ── Event bus ──
type Callback = () => void
type Unsubscribe = () => void
const rowListeners: Callback[] = []
const telemetryLoadListeners: Callback[] = []
const frameTickListeners: Callback[] = []
const editModeListeners: Callback[] = []

function subscribe(list: Callback[], fn: Callback): Unsubscribe {
  list.push(fn)
  return () => {
    const idx = list.indexOf(fn)
    if (idx >= 0) list.splice(idx, 1)
  }
}

// ── Edit mode ──
let editMode = false

export function getEditMode(): boolean { return editMode }

export function setEditMode(on: boolean): void {
  if (on === editMode) return
  editMode = on
  for (const fn of editModeListeners) fn()
}

export function onEditModeChange(fn: Callback): Unsubscribe {
  return subscribe(editModeListeners, fn)
}

export function onRowUpdate(fn: Callback): Unsubscribe {
  return subscribe(rowListeners, fn)
}

export function onTelemetryLoad(fn: Callback): Unsubscribe {
  return subscribe(telemetryLoadListeners, fn)
}

/** Subscribe to every animation frame (for playhead animation, etc.) */
export function onFrameTick(fn: Callback): Unsubscribe {
  return subscribe(frameTickListeners, fn)
}

/** Fire frame tick — called by the animation loop every active frame */
export function fireFrameTick(): void {
  for (const fn of frameTickListeners) fn()
}

export function setCurrentRow(row: TelemetryRow | null): void {
  if (row === currentRow) return  // Skip if same row — avoids redundant HUD/chart redraws
  currentRow = row
  for (const fn of rowListeners) fn()
}

export function setTelemetry(store: TelemetryStore, dur: number): void {
  telemetryStore = store
  duration = dur
  for (const fn of telemetryLoadListeners) fn()
}

// ── Binary search: find the telemetry row closest to a given time ──
export function findRowAtTime(t: number): TelemetryRow | null {
  const store = telemetryStore
  if (!store || store.length === 0) return null

  const times = store.time
  let lo = 0
  let hi = store.length - 1

  if (t <= times[0]) return getRow(store, 0)
  if (t >= times[hi]) return getRow(store, hi)

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < t) {
      lo = mid + 1
    } else if (times[mid] > t) {
      hi = mid - 1
    } else {
      return getRow(store, mid)
    }
  }

  if (lo >= store.length) return getRow(store, hi)
  if (hi < 0) return getRow(store, lo)
  const idx = (t - times[hi]) <= (times[lo] - t) ? hi : lo
  return getRow(store, idx)
}

/**
 * Update interpolation state for a given time.
 * Finds the two bracketing telemetry rows and computes a 0..1 alpha between them.
 * Called every animation frame from main.ts.
 */
export function updateInterpolation(t: number): void {
  const store = telemetryStore
  if (!store || store.length === 0) {
    interpPrev = interpNext = null
    interpAlpha = 0
    return
  }

  const times = store.time
  let lo = 0
  let hi = store.length - 1

  if (t <= times[0]) {
    interpPrev = interpNext = getRow(store, 0)
    interpAlpha = 0
    return
  }
  if (t >= times[hi]) {
    interpPrev = interpNext = getRow(store, hi)
    interpAlpha = 0
    return
  }

  // Binary search for the insertion point: find last row with time <= t
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (times[mid] <= t) lo = mid
    else hi = mid
  }

  interpPrev = getRow(store, lo)
  interpNext = getRow(store, hi)

  const span = interpNext.time - interpPrev.time
  interpAlpha = span > 0 ? (t - interpPrev.time) / span : 0
}

// ── Format time as M:SS.d ──
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const sStr = s < 10 ? '0' + s.toFixed(1) : s.toFixed(1)
  return `${m}:${sStr}`
}

// ── Debug logging ──
const debugPanel = document.getElementById('debug-panel') as HTMLDivElement
const fpsCounter = document.getElementById('fps-counter') as HTMLSpanElement
let debugVisible = false

export function dbg(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  debugPanel.textContent = (debugPanel.textContent || '') + line + '\n'
  debugPanel.scrollTop = debugPanel.scrollHeight
}

export function isDebugVisible(): boolean {
  return debugVisible
}

export function toggleDebugPanel(): void {
  debugVisible = !debugVisible
  debugPanel.classList.toggle('visible', debugVisible)
  fpsCounter.style.display = debugVisible ? 'inline' : 'none'
}
