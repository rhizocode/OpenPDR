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
  /** Total un-normalized distance in meters */
  totalDist: number
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
    return { dist: new Float64Array(0), times: new Float64Array(0), startIdx, endIdx, totalDist: 0 }
  }

  const dist = new Float64Array(n)
  const tArr = new Float64Array(n)

  dist[0] = 0
  tArr[0] = times[startIdx]

  // Use speed integration (GPS Doppler-derived) instead of haversine chaining.
  // Speed is much cleaner than position — avoids cumulative noise inflation.
  // Fall back to haversine only if speed data is missing.
  let nonZero = 0
  for (let i = 0; i < Math.min(n, 100); i += 10) {
    if (store.speed_mps[startIdx + i] !== 0) nonZero++
  }
  const useSpeed = nonZero >= 5

  for (let i = 1; i < n; i++) {
    const gi = startIdx + i
    if (useSpeed) {
      const dt = times[gi] - times[gi - 1]
      dist[i] = dist[i - 1] + store.speed_mps[gi] * dt
    } else {
      dist[i] = dist[i - 1] + haversineM(lats[gi - 1], lons[gi - 1], lats[gi], lons[gi])
    }
    tArr[i] = times[gi]
  }

  // Normalize to 0..1
  const totalDist = dist[n - 1]
  if (totalDist > 0) {
    for (let i = 0; i < n; i++) {
      dist[i] /= totalDist
    }
  }

  return { dist, times: tArr, startIdx, endIdx, totalDist }
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

/**
 * Sample heading_deg from a store at evenly-spaced track positions.
 * Returns array of [heading[], lat[], lon[]] each of length N.
 */
function sampleChannels(
  sync: SyncData,
  store: TelemetryStore,
  N: number,
): { headings: Float64Array; lats: Float64Array; lons: Float64Array } {
  const headings = new Float64Array(N)
  const lats = new Float64Array(N)
  const lons = new Float64Array(N)
  const times = store.time

  for (let i = 0; i < N; i++) {
    const pos = i / (N - 1)
    const t = trackPositionToTime(sync, pos)

    // Binary search for closest row
    let lo = sync.startIdx, hi = sync.endIdx - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (times[mid] < t) lo = mid + 1
      else hi = mid
    }
    headings[i] = store.heading_deg[lo]
    lats[i] = store.lat[lo]
    lons[i] = store.lon[lo]
  }
  return { headings, lats, lons }
}

/** Unwrap heading to remove 359°→1° discontinuities. Mutates in place. */
function unwrapHeading(h: Float64Array): void {
  for (let i = 1; i < h.length; i++) {
    let delta = h[i] - h[i - 1]
    if (delta > 180) delta -= 360
    else if (delta < -180) delta += 360
    h[i] = h[i - 1] + delta
  }
}

/** Compute finite-difference derivative. Returns array of length N-1. */
function derivative(h: Float64Array): Float64Array {
  const d = new Float64Array(h.length - 1)
  for (let i = 0; i < d.length; i++) {
    d[i] = h[i + 1] - h[i]
  }
  return d
}

/**
 * Cross-correlate two signals over a lag range [-maxLag, +maxLag].
 * Returns the lag (fractional, via parabolic interpolation) with maximum correlation.
 */
function crossCorrelate(a: Float64Array, b: Float64Array, maxLag: number): number {
  const n = Math.min(a.length, b.length)
  let bestLag = 0
  let bestVal = -Infinity

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = 0; i < n; i++) {
      const j = i + lag
      if (j >= 0 && j < n) {
        sum += a[i] * b[j]
        count++
      }
    }
    if (count > 0) sum /= count
    if (sum > bestVal) {
      bestVal = sum
      bestLag = lag
    }
  }

  // Parabolic interpolation for sub-sample accuracy
  if (bestLag > -maxLag && bestLag < maxLag) {
    const computeCorr = (lag: number): number => {
      let sum = 0, count = 0
      for (let i = 0; i < n; i++) {
        const j = i + lag
        if (j >= 0 && j < n) { sum += a[i] * b[j]; count++ }
      }
      return count > 0 ? sum / count : 0
    }
    const yL = computeCorr(bestLag - 1)
    const yC = bestVal
    const yR = computeCorr(bestLag + 1)
    const denom = yL - 2 * yC + yR
    if (denom !== 0) {
      bestLag += (yL - yR) / (2 * denom)
    }
  }

  return bestLag
}

/**
 * Compute the heading cross-correlation offset between two laps.
 * Returns the offset in normalized (0..1) track-position units.
 * Positive means B is ahead of A; negative means B is behind.
 * Capped at ±2% of lap distance.
 */
export function computeHeadingOffset(
  syncA: SyncData,
  syncB: SyncData,
  storeA: TelemetryStore,
  storeB: TelemetryStore,
): number {
  if (syncA.dist.length === 0 || syncB.dist.length === 0) return 0

  const N = 500
  const maxLag = 10 // ±2% of lap

  const chA = sampleChannels(syncA, storeA, N)
  const chB = sampleChannels(syncB, storeB, N)
  unwrapHeading(chA.headings)
  unwrapHeading(chB.headings)
  const dhA = derivative(chA.headings)
  const dhB = derivative(chB.headings)

  const lagSamples = crossCorrelate(dhA, dhB, maxLag)
  const offsetNorm = lagSamples / N

  // Cap at ±2% (0.02 normalized)
  return Math.max(-0.02, Math.min(0.02, offsetNorm))
}

/**
 * Shift a sync data's normalized distance array by a constant offset.
 * Clamps values to [0, 1].
 */
export function applyOffset(sync: SyncData, offset: number): void {
  const n = sync.dist.length
  if (n === 0 || offset === 0) return
  for (let i = 0; i < n; i++) {
    sync.dist[i] = Math.max(0, Math.min(1, sync.dist[i] + offset))
  }
}

/**
 * Benchmark sync quality between two laps. Logs results via the provided
 * debug function. Call after buildDistanceArray() for both laps.
 */
export function benchmarkSync(
  syncA: SyncData,
  syncB: SyncData,
  storeA: TelemetryStore,
  storeB: TelemetryStore,
  log: (msg: string) => void,
): void {
  if (syncA.dist.length === 0 || syncB.dist.length === 0) return

  const N = 500
  const maxLag = 10 // ±2% of lap

  // Sample heading and GPS at evenly-spaced track positions
  const chA = sampleChannels(syncA, storeA, N)
  const chB = sampleChannels(syncB, storeB, N)

  // Unwrap and differentiate heading
  unwrapHeading(chA.headings)
  unwrapHeading(chB.headings)
  const dhA = derivative(chA.headings)
  const dhB = derivative(chB.headings)

  // Cross-correlate heading derivatives
  const lagSamples = crossCorrelate(dhA, dhB, maxLag)
  const offsetNorm = lagSamples / N
  const avgTotalDist = (syncA.totalDist + syncB.totalDist) / 2
  const offsetM = offsetNorm * avgTotalDist
  const offsetFt = offsetM * 3.281

  // GPS separation at each position
  const gpsDist = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    gpsDist[i] = haversineM(chA.lats[i], chA.lons[i], chB.lats[i], chB.lons[i])
  }

  // Statistics
  let sum = 0, max = 0
  for (let i = 0; i < N; i++) {
    sum += gpsDist[i]
    if (gpsDist[i] > max) max = gpsDist[i]
  }
  const mean = sum / N

  const sorted = Array.from(gpsDist).sort((a, b) => a - b)
  const median = N % 2 === 0
    ? (sorted[N / 2 - 1] + sorted[N / 2]) / 2
    : sorted[Math.floor(N / 2)]

  let variance = 0
  for (let i = 0; i < N; i++) {
    variance += (gpsDist[i] - mean) ** 2
  }
  const std = Math.sqrt(variance / N)

  // Linear regression for distance trend (slope over lap)
  const xMean = (N - 1) / 2
  let num = 0, den = 0
  for (let i = 0; i < N; i++) {
    const dx = i - xMean
    num += dx * gpsDist[i]
    den += dx * dx
  }
  const slope = den > 0 ? num / den : 0
  const trendTotal = slope * (N - 1) // total change over the lap
  const trendLabel = Math.abs(trendTotal) < 0.5 ? 'flat' : trendTotal > 0 ? 'growing' : 'shrinking'

  const sign = offsetM >= 0 ? '+' : ''
  log(`[Sync Benchmark]`)
  log(`  Heading xcorr offset: ${sign}${offsetNorm.toFixed(4)} (~${Math.abs(offsetM).toFixed(1)}m / ${Math.abs(offsetFt).toFixed(1)}ft)`)
  log(`  GPS separation — mean: ${mean.toFixed(1)}m  median: ${median.toFixed(1)}m  max: ${max.toFixed(1)}m  std: ${std.toFixed(1)}m`)
  log(`  Distance trend: ${trendTotal >= 0 ? '+' : ''}${trendTotal.toFixed(1)}m over lap (${trendLabel})`)
}
