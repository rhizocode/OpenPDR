/**
 * OpenPDR Viewer — Shared application state + event bus
 *
 * Central state that all renderer modules read from. Modules subscribe
 * to updates via onRowUpdate() and onTelemetryLoad(). The animation
 * loop in main.ts drives updates by calling setCurrentRow().
 */

import type { TelemetryRow } from './types'

// ── State ──
export let telemetry: TelemetryRow[] = []
export let currentRow: TelemetryRow | null = null
export let duration = 0

// ── DOM refs (shared across modules) ──
export const video = document.getElementById('video') as HTMLVideoElement

// ── Event bus ──
type Callback = () => void
const rowListeners: Callback[] = []
const telemetryLoadListeners: Callback[] = []
const frameTickListeners: Callback[] = []
const editModeListeners: Callback[] = []

// ── Edit mode ──
let editMode = false

export function getEditMode(): boolean { return editMode }

export function setEditMode(on: boolean): void {
  if (on === editMode) return
  editMode = on
  for (const fn of editModeListeners) fn()
}

export function onEditModeChange(fn: Callback): void {
  editModeListeners.push(fn)
}

export function onRowUpdate(fn: Callback): void {
  rowListeners.push(fn)
}

export function onTelemetryLoad(fn: Callback): void {
  telemetryLoadListeners.push(fn)
}

/** Subscribe to every animation frame (for playhead animation, etc.) */
export function onFrameTick(fn: Callback): void {
  frameTickListeners.push(fn)
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

export function setTelemetry(rows: TelemetryRow[], dur: number): void {
  telemetry = rows
  duration = dur
  for (const fn of telemetryLoadListeners) fn()
}

// ── Binary search: find the telemetry row closest to a given time ──
export function findRowAtTime(t: number): TelemetryRow | null {
  if (telemetry.length === 0) return null

  let lo = 0
  let hi = telemetry.length - 1

  if (t <= telemetry[0].time) return telemetry[0]
  if (t >= telemetry[hi].time) return telemetry[hi]

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (telemetry[mid].time < t) {
      lo = mid + 1
    } else if (telemetry[mid].time > t) {
      hi = mid - 1
    } else {
      return telemetry[mid]
    }
  }

  if (lo >= telemetry.length) return telemetry[hi]
  if (hi < 0) return telemetry[lo]
  return (t - telemetry[hi].time) <= (telemetry[lo].time - t)
    ? telemetry[hi]
    : telemetry[lo]
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
