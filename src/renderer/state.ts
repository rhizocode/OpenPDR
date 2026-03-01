/**
 * OpenPDR Viewer — Shared application state + event bus
 *
 * Central state that all renderer modules read from. Modules subscribe
 * to updates via onRowUpdate() and onTelemetryLoad(). The animation
 * loop in main.ts drives updates by calling setCurrentRow().
 */

import type { TelemetryRow, LapData, SessionInfo } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { getRow, getRowInto, createEmptyRow } from '../shared/telemetry-store'

// ── State ──
export let telemetryStore: TelemetryStore | null = null
export let currentRow: TelemetryRow | null = null
export let duration = 0
export let lapData: LapData | null = null
export let sessionInfo: SessionInfo | null = null

// ── Interpolation state ──
// Exposed so modules (track-map, hud) can interpolate between bracketing rows.
// Updated every animation frame by the animation loop in main.ts.
export let interpPrev: TelemetryRow | null = null
export let interpNext: TelemetryRow | null = null
export let interpAlpha = 0  // 0..1 fraction between prev and next

export function setLapData(data: LapData | null): void {
  lapData = data
}

export function setSessionInfo(info: SessionInfo | null): void {
  sessionInfo = info
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

// Track the last row's time separately — findRowAtTime() reuses a singleton
// scratch object, so by the time setCurrentRow is called the object has already
// been mutated and field comparisons against currentRow see the new values.
let lastRowTime = -1

export function setCurrentRow(row: TelemetryRow | null): void {
  if (row && row.time === lastRowTime) return
  lastRowTime = row ? row.time : -1
  currentRow = row
  for (const fn of rowListeners) fn()
}

export function setTelemetry(store: TelemetryStore, dur: number): void {
  telemetryStore = store
  duration = dur
  for (const fn of telemetryLoadListeners) fn()
}

// ── Seeking: convert telemetry time ↔ video time ──

/**
 * Seek the video to show a specific telemetry time.
 * Applies A/V sync offset so the HUD lands on the requested telemetry position.
 */
export function seekToTelemetryTime(telTime: number): void {
  video.currentTime = telTime - avSyncOffset
}

/**
 * Get the current telemetry-side time (video time + A/V sync offset).
 * Use this instead of reading video.currentTime when you need the telemetry position.
 */
export function getSyncedTime(): number {
  return video.currentTime + avSyncOffset
}

// ── Binary search: find the telemetry row closest to the current synced time ──
// Pre-allocated scratch row — reused every frame, never hold a reference across frames.
const _findRow = createEmptyRow()

/**
 * Find the telemetry row closest to a video time.
 * Automatically applies A/V sync offset so callers never need to handle it.
 */
export function findRowAtTime(videoTime: number): TelemetryRow | null {
  return findRowAtRawTime(videoTime + avSyncOffset)
}

/** Find the telemetry row closest to an exact telemetry timestamp (no offset applied). */
function findRowAtRawTime(t: number): TelemetryRow | null {
  const store = telemetryStore
  if (!store || store.length === 0) return null

  const times = store.time
  let lo = 0
  let hi = store.length - 1

  if (t <= times[0]) return getRowInto(store, 0, _findRow)
  if (t >= times[hi]) return getRowInto(store, hi, _findRow)

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < t) {
      lo = mid + 1
    } else if (times[mid] > t) {
      hi = mid - 1
    } else {
      return getRowInto(store, mid, _findRow)
    }
  }

  if (lo >= store.length) return getRowInto(store, hi, _findRow)
  if (hi < 0) return getRowInto(store, lo, _findRow)
  const idx = (t - times[hi]) <= (times[lo] - t) ? hi : lo
  return getRowInto(store, idx, _findRow)
}

/**
 * Update interpolation state for a given video time.
 * Finds the two bracketing telemetry rows and computes a 0..1 alpha between them.
 * Automatically applies A/V sync offset.
 * Called every animation frame from main.ts.
 */
// Pre-allocated interp scratch rows — reused every frame.
const _interpPrevRow = createEmptyRow()
const _interpNextRow = createEmptyRow()

export function updateInterpolation(videoTime: number): void {
  const t = videoTime + avSyncOffset
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
    getRowInto(store, 0, _interpPrevRow)
    interpPrev = interpNext = _interpPrevRow
    interpAlpha = 0
    return
  }
  if (t >= times[hi]) {
    getRowInto(store, hi, _interpPrevRow)
    interpPrev = interpNext = _interpPrevRow
    interpAlpha = 0
    return
  }

  // Binary search for the insertion point: find last row with time <= t
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (times[mid] <= t) lo = mid
    else hi = mid
  }

  interpPrev = getRowInto(store, lo, _interpPrevRow)
  interpNext = getRowInto(store, hi, _interpNextRow)

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
