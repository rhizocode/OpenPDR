/**
 * OpenPDR Viewer — Compare Mode: Distance-based synchronization
 *
 * Pure computation module. Builds cumulative Haversine distance arrays
 * from GPS points within a lap, then provides lookup functions to convert
 * between track position (0..1) and telemetry time.
 */

import type { TelemetryStore } from '../shared/telemetry-store'
import type { LapInfo } from './types'

export interface SyncData {
  /** Cumulative distance, normalized 0..1 */
  dist: Float64Array
  /** Corresponding telemetry timestamps */
  times: Float64Array
  /** First row index (inclusive) */
  startIdx: number
  /** Last row index (exclusive) */
  endIdx: number
}

/** Haversine distance in meters between two lat/lon points. */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const dLat = (lat2 - lat1) * (Math.PI / 180)
  const dLon = (lon2 - lon1) * (Math.PI / 180)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Binary-search for the last index where arr[i] <= value.
 * Returns -1 if value < arr[0].
 */
function lowerBound(arr: Float64Array, value: number, len: number): number {
  let lo = 0
  let hi = len - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] <= value) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * Build a cumulative distance array for a lap within a telemetry store.
 * Distances are normalized to 0..1.
 */
export function buildDistanceArray(store: TelemetryStore, lap: LapInfo): SyncData {
  const times = store.time
  const lats = store.lat
  const lons = store.lon

  // Find row range via binary search
  let startIdx = 0
  let endIdx = store.length
  {
    let lo = 0, hi = store.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (times[mid] < lap.startTime) lo = mid + 1
      else hi = mid - 1
    }
    startIdx = lo
  }
  {
    let lo = 0, hi = store.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (times[mid] <= lap.endTime) lo = mid + 1
      else hi = mid - 1
    }
    endIdx = lo
  }

  const n = endIdx - startIdx
  if (n <= 0) {
    return { dist: new Float64Array(0), times: new Float64Array(0), startIdx, endIdx }
  }

  const dist = new Float64Array(n)
  const tArr = new Float64Array(n)

  dist[0] = 0
  tArr[0] = times[startIdx]

  for (let i = 1; i < n; i++) {
    const gi = startIdx + i
    const d = haversineM(lats[gi - 1], lons[gi - 1], lats[gi], lons[gi])
    dist[i] = dist[i - 1] + d
    tArr[i] = times[gi]
  }

  // Normalize to 0..1
  const totalDist = dist[n - 1]
  if (totalDist > 0) {
    for (let i = 0; i < n; i++) {
      dist[i] /= totalDist
    }
  }

  return { dist, times: tArr, startIdx, endIdx }
}

/**
 * Convert a telemetry time within a lap to a track position (0..1).
 * Uses time → distance lookup with linear interpolation.
 */
export function timeToTrackPosition(sync: SyncData, telTime: number): number {
  const { dist, times } = sync
  const n = dist.length
  if (n === 0) return 0

  if (telTime <= times[0]) return 0
  if (telTime >= times[n - 1]) return 1

  const i = lowerBound(times, telTime, n)
  if (i < 0) return 0
  if (i >= n - 1) return dist[n - 1]

  const span = times[i + 1] - times[i]
  const alpha = span > 0 ? (telTime - times[i]) / span : 0
  return dist[i] + alpha * (dist[i + 1] - dist[i])
}

/**
 * Convert a track position (0..1) to telemetry time.
 * Inverse of timeToTrackPosition.
 */
export function trackPositionToTime(sync: SyncData, position: number): number {
  const { dist, times } = sync
  const n = dist.length
  if (n === 0) return 0

  if (position <= 0) return times[0]
  if (position >= 1) return times[n - 1]

  const i = lowerBound(dist, position, n)
  if (i < 0) return times[0]
  if (i >= n - 1) return times[n - 1]

  const span = dist[i + 1] - dist[i]
  const alpha = span > 0 ? (position - dist[i]) / span : 0
  return times[i] + alpha * (times[i + 1] - times[i])
}

/**
 * Build a delta-time array: timeA(pos) - timeB(pos) at evenly-spaced positions.
 * Positive values mean A is slower at that point on track.
 */
export function buildDeltaTime(
  syncA: SyncData,
  syncB: SyncData,
  numSamples: number = 200,
): Float32Array {
  const delta = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    const pos = i / (numSamples - 1)
    const tA = trackPositionToTime(syncA, pos)
    const tB = trackPositionToTime(syncB, pos)
    // Normalize to elapsed time within each lap
    const elapsedA = tA - syncA.times[0]
    const elapsedB = tB - syncB.times[0]
    delta[i] = elapsedA - elapsedB
  }
  return delta
}
