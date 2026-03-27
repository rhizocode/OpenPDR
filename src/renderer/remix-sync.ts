/**
 * OpenPDR Viewer — Remix Mode: GPS time-domain cross-correlation
 *
 * Computes the time offset to align a GoPro recording with a PDR recording.
 * pdrTelemetryTime = goProVideoTime + offset
 *
 * Three-stage algorithm:
 * 1. Timestamp coarse alignment (narrows search window)
 * 2. Heading derivative cross-correlation (sub-second)
 * 3. GPS position refinement (0.1s precision)
 */

import type { TelemetryStore } from '../shared/telemetry-store'

export interface RemixSyncResult {
  /** Seconds: pdrTelemetryTime = goProVideoTime + offset */
  offset: number
  /** 0-1 correlation quality */
  confidence: number
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
 * Resample a store's heading to a uniform time grid (1 Hz).
 * Returns { headings, times } where headings[i] corresponds to times[i].
 * Heading is computed from consecutive GPS positions.
 */
function resampleHeading(
  store: TelemetryStore,
  startTime: number,
  endTime: number,
  stepSize: number,
): { headings: Float64Array; times: Float64Array } {
  const n = Math.floor((endTime - startTime) / stepSize) + 1
  if (n <= 0) return { headings: new Float64Array(0), times: new Float64Array(0) }

  const headings = new Float64Array(n)
  const times = new Float64Array(n)
  const storeTimes = store.time
  const len = store.length

  let searchIdx = 0

  for (let i = 0; i < n; i++) {
    const t = startTime + i * stepSize
    times[i] = t

    // Find closest row via linear scan (times are sorted, search advances)
    while (searchIdx < len - 1 && storeTimes[searchIdx + 1] <= t) searchIdx++

    // Use store's heading_deg if available and non-zero
    if (store.heading_deg[searchIdx] !== 0) {
      headings[i] = store.heading_deg[searchIdx]
    } else {
      // Compute heading from GPS
      const idx = searchIdx
      const nextIdx = Math.min(idx + 1, len - 1)
      if (idx !== nextIdx) {
        const dlat = store.lat[nextIdx] - store.lat[idx]
        const dlon = store.lon[nextIdx] - store.lon[idx]
        const cosLat = Math.cos(store.lat[idx] * (Math.PI / 180))
        headings[i] = Math.atan2(dlon * cosLat, dlat) * (180 / Math.PI)
        if (headings[i] < 0) headings[i] += 360
      }
    }
  }

  return { headings, times }
}

/** Unwrap heading to remove 359 -> 1 discontinuities. Mutates in place. */
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
 * Cross-correlate two signals. Signal `b` is shifted by `lag` samples.
 * Searches lag range [-maxLag, +maxLag] and returns the best lag
 * (fractional via parabolic interpolation) and correlation value.
 */
function crossCorrelate(
  a: Float64Array,
  b: Float64Array,
  maxLag: number,
): { lag: number; value: number } {
  const na = a.length
  const nb = b.length
  let bestLag = 0
  let bestVal = -Infinity

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = 0; i < na; i++) {
      const j = i + lag
      if (j >= 0 && j < nb) {
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
      for (let i = 0; i < na; i++) {
        const j = i + lag
        if (j >= 0 && j < nb) { sum += a[i] * b[j]; count++ }
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

  // Normalize confidence: peak correlation relative to mean
  let meanCorr = 0
  let count = 0
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0, c = 0
    for (let i = 0; i < na; i++) {
      const j = i + lag
      if (j >= 0 && j < nb) { sum += a[i] * b[j]; c++ }
    }
    if (c > 0) { meanCorr += sum / c; count++ }
  }
  meanCorr = count > 0 ? meanCorr / count : 0

  const confidence = meanCorr > 0 ? Math.min(1, bestVal / meanCorr - 1) : 0

  return { lag: bestLag, value: confidence }
}

/**
 * Find the row index closest to a given time in a store.
 */
function findClosest(storeTimes: Float64Array, t: number, len: number): number {
  let lo = 0, hi = len - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (storeTimes[mid] < t) lo = mid + 1
    else hi = mid
  }
  // Check neighbors
  if (lo > 0 && Math.abs(storeTimes[lo - 1] - t) < Math.abs(storeTimes[lo] - t)) {
    return lo - 1
  }
  return lo
}

/**
 * Compute the time offset to align GoPro and PDR recordings.
 *
 * The offset is such that: pdrTelemetryTime = goProTelemetryTime + offset
 * So when displaying PDR data on GoPro video:
 *   avSyncOffset = offset (applied as: telTime = videoTime + avSyncOffset)
 */
export function computeRemixSync(
  goProStore: TelemetryStore,
  pdrStore: TelemetryStore,
  goProTimestamp?: string,
  pdrTimestamp?: string,
): RemixSyncResult {
  const goLen = goProStore.length
  const pdrLen = pdrStore.length
  if (goLen < 10 || pdrLen < 10) {
    return { offset: 0, confidence: 0 }
  }

  const goStart = goProStore.time[0]
  const goEnd = goProStore.time[goLen - 1]
  const goDuration = goEnd - goStart

  const pdrStart = pdrStore.time[0]
  const pdrEnd = pdrStore.time[pdrLen - 1]

  // ── Stage 1: Timestamp coarse alignment ──
  let coarseOffset = 0
  let searchWindow = 60 // default: ±60s if no timestamps
  let hasTimestamps = false

  if (goProTimestamp && pdrTimestamp) {
    const goEpoch = new Date(goProTimestamp).getTime() / 1000
    const pdrEpoch = new Date(pdrTimestamp).getTime() / 1000
    if (!isNaN(goEpoch) && !isNaN(pdrEpoch)) {
      // GoPro timestamp is absolute (GPSU from first sample)
      // PDR timestamp is also absolute
      // goProStore.time[0] corresponds to goEpoch
      // pdrStore.time[0] corresponds to pdrEpoch
      // At goProTime t, the wall-clock is goEpoch + (t - goStart)
      // We want pdrTime such that pdrEpoch + (pdrTime - pdrStart) == goEpoch + (goProTime - goStart)
      // pdrTime = goProTime + (goEpoch - pdrEpoch) + (pdrStart - goStart)
      coarseOffset = (goEpoch - pdrEpoch) + (pdrStart - goStart)
      searchWindow = 30
      hasTimestamps = true
    }
  }

  // If no timestamps, try to estimate based on GPS proximity
  if (!hasTimestamps) {
    // Find the PDR time where GPS is closest to GoPro's first valid GPS point
    let goFirstLat = 0, goFirstLon = 0
    for (let i = 0; i < goLen; i++) {
      if (goProStore.lat[i] !== 0 && goProStore.lon[i] !== 0) {
        goFirstLat = goProStore.lat[i]
        goFirstLon = goProStore.lon[i]
        break
      }
    }
    if (goFirstLat !== 0) {
      let bestDist = Infinity
      let bestPdrTime = pdrStart
      // Sample PDR at 1 Hz
      for (let t = pdrStart; t <= pdrEnd; t += 1) {
        const idx = findClosest(pdrStore.time, t, pdrLen)
        const d = haversineM(goFirstLat, goFirstLon, pdrStore.lat[idx], pdrStore.lon[idx])
        if (d < bestDist) {
          bestDist = d
          bestPdrTime = t
        }
      }
      // Coarse offset: goStart maps to bestPdrTime
      coarseOffset = bestPdrTime - goStart
      searchWindow = Math.max(60, goDuration)
    }
  }

  // ── Stage 2: Heading derivative cross-correlation ──
  // Resample both traces to 1 Hz within the search window
  const goHeading = resampleHeading(goProStore, goStart, goEnd, 1.0)

  // PDR window: where the GoPro data would map with coarse offset ± searchWindow
  const pdrSearchStart = Math.max(pdrStart, goStart + coarseOffset - searchWindow)
  const pdrSearchEnd = Math.min(pdrEnd, goEnd + coarseOffset + searchWindow)
  const pdrHeading = resampleHeading(pdrStore, pdrSearchStart, pdrSearchEnd, 1.0)

  if (goHeading.headings.length < 5 || pdrHeading.headings.length < 5) {
    return { offset: coarseOffset, confidence: 0 }
  }

  unwrapHeading(goHeading.headings)
  unwrapHeading(pdrHeading.headings)
  const dhGo = derivative(goHeading.headings)
  const dhPdr = derivative(pdrHeading.headings)

  // Max lag = searchWindow (since we resampled at 1 Hz)
  const maxLag = Math.min(searchWindow, Math.floor(pdrHeading.headings.length / 2))
  const xcorr = crossCorrelate(dhGo, dhPdr, maxLag)

  // The xcorr lag tells us: pdrHeading sample at index (i + lag) matches goHeading sample at index i
  // goHeading.times[i] = goStart + i
  // pdrHeading.times[i + lag] = pdrSearchStart + (i + lag)
  // So: pdrTime = goTime + (pdrSearchStart - goStart) + lag
  const stage2Offset = (pdrSearchStart - goStart) + xcorr.lag

  // ── Stage 3: GPS position refinement (0.1s precision) ──
  let bestOffset = stage2Offset
  let bestMeanDist = Infinity

  for (let delta = -3; delta <= 3; delta += 0.1) {
    const candidateOffset = stage2Offset + delta
    let totalDist = 0
    let count = 0

    // Sample at 1 Hz through the GoPro duration
    for (let t = goStart; t <= goEnd; t += 1) {
      const goIdx = findClosest(goProStore.time, t, goLen)
      if (goProStore.lat[goIdx] === 0 && goProStore.lon[goIdx] === 0) continue

      const pdrTime = t + candidateOffset
      if (pdrTime < pdrStart || pdrTime > pdrEnd) continue

      const pdrIdx = findClosest(pdrStore.time, pdrTime, pdrLen)
      if (pdrStore.lat[pdrIdx] === 0 && pdrStore.lon[pdrIdx] === 0) continue

      totalDist += haversineM(
        goProStore.lat[goIdx], goProStore.lon[goIdx],
        pdrStore.lat[pdrIdx], pdrStore.lon[pdrIdx],
      )
      count++
    }

    if (count > 0) {
      const mean = totalDist / count
      if (mean < bestMeanDist) {
        bestMeanDist = mean
        bestOffset = candidateOffset
      }
    }
  }

  return {
    offset: bestOffset,
    confidence: Math.max(0, Math.min(1, xcorr.value)),
  }
}
