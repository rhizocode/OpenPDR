/**
 * OpenPDR Viewer — Shared application state + event bus
 *
 * Central state that all renderer modules read from. Modules subscribe
 * to updates via onRowUpdate() and onTelemetryLoad(). The animation
 * loop in main.ts drives updates by calling setCurrentRow().
 */

import type { TelemetryRow, LapData, SessionInfo } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { getRow, getRowInto, createEmptyRow, findClosestTimeIndex } from '../shared/telemetry-store'
import { createBus } from './event-bus'
import { STORAGE_KEYS } from './storage-keys'

// ── State ──
export let telemetryStore: TelemetryStore | null = null
export let currentRow: TelemetryRow | null = null
export let duration = 0
export let lapData: LapData | null = null
export let sessionInfo: SessionInfo | null = null

// ── View range (lap view mode) ──
export interface ViewRange {
  startTime: number
  endTime: number
}

export let viewRange: ViewRange = { startTime: 0, endTime: 0 }
export let selectedLapIdx: number | null = null  // null = full recording

export function getViewDuration(): number {
  return viewRange.endTime - viewRange.startTime
}

/** Map absolute telemetry time to 0..1 fraction within the current view range */
export function viewFraction(telTime: number): number {
  const d = getViewDuration()
  if (d <= 0) return 0
  return (telTime - viewRange.startTime) / d
}

/** Map a 0..1 fraction within the current view range to absolute telemetry time */
export function viewFractionToTime(frac: number): number {
  return viewRange.startTime + frac * getViewDuration()
}

// ── Interpolation state ──
// Exposed so modules (track-map, hud) can interpolate between bracketing rows.
// Updated every animation frame by the animation loop in main.ts.
export let interpPrev: TelemetryRow | null = null
export let interpNext: TelemetryRow | null = null
export let interpAlpha = 0  // 0..1 fraction between prev and next

export function setInterpState(prev: TelemetryRow | null, next: TelemetryRow | null, alpha: number): void {
  interpPrev = prev
  interpNext = next
  interpAlpha = alpha
}

export function setLapData(data: LapData | null): void {
  lapData = data
}

export function setSessionInfo(info: SessionInfo | null): void {
  sessionInfo = info
}

// ── Audio-to-video sync offset ──
// Fine-tuning offset between telemetry and video playback (in seconds).
// The parser now uses MP4 timing metadata (stts/elst) for proper sync,
// so this offset is purely for user-adjustable fine-tuning.
// Positive = telemetry leads video.
const AV_SYNC_KEY = STORAGE_KEYS.avSync
export let avSyncOffset = loadAvSyncOffset()

function loadAvSyncOffset(): number {
  const saved = localStorage.getItem(AV_SYNC_KEY)
  if (saved) {
    const v = parseFloat(saved)
    if (!Number.isNaN(v)) return v
  }
  return 0  // default 0 — parser handles sync via MP4 stts/elst timing
}

export function setAvSyncOffset(seconds: number): void {
  avSyncOffset = seconds
  localStorage.setItem(AV_SYNC_KEY, seconds.toFixed(3))
}

// ── DOM refs (shared across modules) ──
export const video = document.getElementById('video') as HTMLVideoElement

// ── Event bus ──
const rowBus = createBus()
const telemetryLoadBus = createBus()
const frameTickBus = createBus()
const editModeBus = createBus()
const viewRangeBus = createBus()

// ── Edit mode ──
let editMode = false

export function getEditMode(): boolean { return editMode }

export function setEditMode(on: boolean): void {
  if (on === editMode) return
  editMode = on
  editModeBus.fire()
}

export function onEditModeChange(fn: () => void) { return editModeBus.on(fn) }
export function onViewRangeChange(fn: () => void) { return viewRangeBus.on(fn) }
export function onRowUpdate(fn: () => void) { return rowBus.on(fn) }
export function onTelemetryLoad(fn: () => void) { return telemetryLoadBus.on(fn) }

/** Subscribe to every animation frame (for playhead animation, etc.) */
export function onFrameTick(fn: () => void) { return frameTickBus.on(fn) }

/** Fire frame tick — called by the animation loop every active frame */
export function fireFrameTick(): void { frameTickBus.fire() }

// Track the last row's time separately — findRowAtTime() reuses a singleton
// scratch object, so by the time setCurrentRow is called the object has already
// been mutated and field comparisons against currentRow see the new values.
let lastRowTime = -1

export function setCurrentRow(row: TelemetryRow | null): void {
  if (row && row.time === lastRowTime) return
  lastRowTime = row ? row.time : -1
  currentRow = row
  rowBus.fire()
}

export function setTelemetry(store: TelemetryStore, dur: number): void {
  telemetryStore = store
  duration = dur
  viewRange = { startTime: 0, endTime: dur }
  selectedLapIdx = null
  telemetryLoadBus.fire()
}

export function setViewRange(range: ViewRange, lapIdx: number | null): void {
  viewRange = range
  selectedLapIdx = lapIdx
  viewRangeBus.fire()
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
  const idx = findClosestTimeIndex(store.time, t, store.length)
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
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`
  console.log(line.trimEnd())
  debugPanel.appendChild(document.createTextNode(line))
  // Cap at ~500 lines to prevent unbounded memory growth
  while (debugPanel.childNodes.length > 500) debugPanel.removeChild(debugPanel.firstChild!)
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
