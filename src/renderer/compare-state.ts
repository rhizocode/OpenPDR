/**
 * OpenPDR Viewer — Compare Mode: Central state
 *
 * Parallel to state.ts — holds the two-sided state for compare mode.
 * Modules check isCompareMode() to decide which state to read.
 */

import type { TelemetryRow, LapInfo, LapData } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { createEmptyRow, getRowInto } from '../shared/telemetry-store'
import { avSyncOffset } from './state'
import { buildDistanceArray, benchmarkSync, type SyncData } from './compare-sync'
import { dbg } from './state'

// ── Compare mode flag ──
let compareMode = false
export function isCompareMode(): boolean { return compareMode }

// ── Stores ──
export let storeA: TelemetryStore | null = null
export let storeB: TelemetryStore | null = null

// ── Selected laps ──
export let lapA: LapInfo | null = null
export let lapB: LapInfo | null = null

// ── Lap data for each file ──
export let lapDataA: LapData | null = null
export let lapDataB: LapData | null = null

// ── Video elements ──
export let videoA: HTMLVideoElement | null = null
export let videoB: HTMLVideoElement | null = null

// ── File paths ──
export let filePathA = ''
export let filePathB = ''
export let fileNameA = ''
export let fileNameB = ''

// ── Master track position (0..1) ──
export let trackPosition = 0

export function setTrackPosition(pos: number): void {
  trackPosition = Math.max(0, Math.min(1, pos))
}

// ── Current rows ──
export let currentRowA: TelemetryRow | null = null
export let currentRowB: TelemetryRow | null = null

// ── Interpolation state for both sides ──
export let interpPrevA: TelemetryRow | null = null
export let interpNextA: TelemetryRow | null = null
export let interpAlphaA = 0

export let interpPrevB: TelemetryRow | null = null
export let interpNextB: TelemetryRow | null = null
export let interpAlphaB = 0

// ── Sync data (distance arrays) ──
export let syncDataA: SyncData | null = null
export let syncDataB: SyncData | null = null

// ── Event bus ──
type Callback = () => void
type Unsubscribe = () => void
const compareEnterListeners: Callback[] = []
const compareExitListeners: Callback[] = []
const compareLapChangeListeners: Callback[] = []

function subscribe(list: Callback[], fn: Callback): Unsubscribe {
  list.push(fn)
  return () => {
    const idx = list.indexOf(fn)
    if (idx >= 0) list.splice(idx, 1)
  }
}

export function onCompareEnter(fn: Callback): Unsubscribe { return subscribe(compareEnterListeners, fn) }
export function onCompareExit(fn: Callback): Unsubscribe { return subscribe(compareExitListeners, fn) }
export function onCompareLapChange(fn: Callback): Unsubscribe { return subscribe(compareLapChangeListeners, fn) }

// ── Scratch rows for row lookups ──
const _findRowA = createEmptyRow()
const _findRowB = createEmptyRow()
const _interpPrevARow = createEmptyRow()
const _interpNextARow = createEmptyRow()
const _interpPrevBRow = createEmptyRow()
const _interpNextBRow = createEmptyRow()

/** Find the row in a store closest to a given telemetry time. */
export function findRowInStore(store: TelemetryStore, telTime: number, scratch: TelemetryRow): TelemetryRow | null {
  if (!store || store.length === 0) return null
  const times = store.time
  let lo = 0
  let hi = store.length - 1

  if (telTime <= times[0]) return getRowInto(store, 0, scratch)
  if (telTime >= times[hi]) return getRowInto(store, hi, scratch)

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < telTime) lo = mid + 1
    else if (times[mid] > telTime) hi = mid - 1
    else return getRowInto(store, mid, scratch)
  }

  if (lo >= store.length) return getRowInto(store, hi, scratch)
  if (hi < 0) return getRowInto(store, lo, scratch)
  const idx = (telTime - times[hi]) <= (times[lo] - telTime) ? hi : lo
  return getRowInto(store, idx, scratch)
}

export function setCurrentRowA(row: TelemetryRow | null): void { currentRowA = row }
export function setCurrentRowB(row: TelemetryRow | null): void { currentRowB = row }

/** Update interpolation state for side A at a given telemetry time. */
export function updateInterpolationA(telTime: number): void {
  if (!storeA || storeA.length === 0) {
    interpPrevA = interpNextA = null; interpAlphaA = 0; return
  }
  _updateInterp(storeA, telTime, _interpPrevARow, _interpNextARow,
    (p, n, a) => { interpPrevA = p; interpNextA = n; interpAlphaA = a })
}

/** Update interpolation state for side B at a given telemetry time. */
export function updateInterpolationB(telTime: number): void {
  if (!storeB || storeB.length === 0) {
    interpPrevB = interpNextB = null; interpAlphaB = 0; return
  }
  _updateInterp(storeB, telTime, _interpPrevBRow, _interpNextBRow,
    (p, n, a) => { interpPrevB = p; interpNextB = n; interpAlphaB = a })
}

function _updateInterp(
  store: TelemetryStore,
  t: number,
  prevRow: TelemetryRow,
  nextRow: TelemetryRow,
  set: (prev: TelemetryRow, next: TelemetryRow, alpha: number) => void,
): void {
  const times = store.time
  if (t <= times[0]) {
    getRowInto(store, 0, prevRow)
    set(prevRow, prevRow, 0)
    return
  }
  const last = store.length - 1
  if (t >= times[last]) {
    getRowInto(store, last, prevRow)
    set(prevRow, prevRow, 0)
    return
  }

  let lo = 0, hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (times[mid] <= t) lo = mid
    else hi = mid
  }

  getRowInto(store, lo, prevRow)
  getRowInto(store, hi, nextRow)
  const span = nextRow.time - prevRow.time
  const alpha = span > 0 ? (t - prevRow.time) / span : 0
  set(prevRow, nextRow, alpha)
}

// ── Rebuild sync data when laps change ──
function rebuildSync(): void {
  if (storeA && lapA) {
    syncDataA = buildDistanceArray(storeA, lapA)
  } else {
    syncDataA = null
  }
  if (storeB && lapB) {
    syncDataB = buildDistanceArray(storeB, lapB)
  } else {
    syncDataB = null
  }
  if (syncDataA && syncDataB && storeA && storeB) {
    benchmarkSync(syncDataA, syncDataB, storeA, storeB, dbg)
  }
}

// ── Config for entering compare mode ──
export interface CompareConfig {
  storeA: TelemetryStore
  storeB: TelemetryStore
  lapDataA: LapData
  lapDataB: LapData
  lapA: LapInfo
  lapB: LapInfo
  videoA: HTMLVideoElement
  videoB: HTMLVideoElement
  filePathA: string
  filePathB: string
  fileNameA: string
  fileNameB: string
}

export function enterCompareMode(config: CompareConfig): void {
  compareMode = true
  storeA = config.storeA
  storeB = config.storeB
  lapDataA = config.lapDataA
  lapDataB = config.lapDataB
  lapA = config.lapA
  lapB = config.lapB
  videoA = config.videoA
  videoB = config.videoB
  filePathA = config.filePathA
  filePathB = config.filePathB
  fileNameA = config.fileNameA
  fileNameB = config.fileNameB
  trackPosition = 0

  rebuildSync()

  for (const fn of compareEnterListeners) fn()
}

export function exitCompareMode(): void {
  compareMode = false
  storeA = storeB = null
  lapA = lapB = null
  lapDataA = lapDataB = null
  videoA = videoB = null
  syncDataA = syncDataB = null
  currentRowA = currentRowB = null
  interpPrevA = interpNextA = null
  interpPrevB = interpNextB = null
  trackPosition = 0

  for (const fn of compareExitListeners) fn()
}

export function setCompareLapA(idx: number): void {
  if (!lapDataA?.laps[idx]) return
  lapA = lapDataA.laps[idx]
  rebuildSync()
  for (const fn of compareLapChangeListeners) fn()
}

export function setCompareLapB(idx: number): void {
  if (!lapDataB?.laps[idx]) return
  lapB = lapDataB.laps[idx]
  rebuildSync()
  for (const fn of compareLapChangeListeners) fn()
}
