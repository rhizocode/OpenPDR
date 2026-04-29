/**
 * OpenPDR — Lap detection
 *
 * Builds laps from S/F crossing timestamps reported by the device:
 *   - AliveDrive: com.cosworth.event.lap.start (event id 0)
 *   - Marlin:     "Beacon" channel transitions
 *
 * The driver configures the S/F line in the device, so these timestamps
 * are authoritative.
 */
import type { TelemetryStore } from '../shared/telemetry-store'
import type { EmbeddedEvent, LapData, LapInfo, TrackLayout } from './types'

const LAP_START_EVENT = 0   // com.cosworth.event.lap.start

/**
 * Build laps from S/F crossing timestamps. Each consecutive pair of
 * crossings is one lap; the S/F coordinate is the GPS fix at the first
 * crossing. Returns null if fewer than 2 crossings.
 */
export function detectLapsFromCrossings(
  crossingTimes: number[],
  store: TelemetryStore,
  detectionMethod: 'events' | 'beacon',
): LapData | null {
  const sorted = [...crossingTimes].sort((a, b) => a - b)
  if (sorted.length < 2) return null

  const laps: LapInfo[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const startTime = sorted[i]
    const endTime = sorted[i + 1]
    const lapTime = endTime - startTime
    if (lapTime < 30 || lapTime > 1200) continue
    laps.push({
      lapNumber: laps.length + 1,
      startTime,
      endTime,
      lapTime,
    })
  }
  if (laps.length === 0) return null

  const sfIdx = findClosestIndex(store, sorted[0])
  if (sfIdx < 0 || store.lat[sfIdx] === 0 || store.lon[sfIdx] === 0) return null

  const trackLayout = buildTrackLayout(store, laps, store.lat[sfIdx], store.lon[sfIdx])
  return { laps, trackLayout, hasLapData: true, detectionMethod }
}

/**
 * AliveDrive convenience: extract lap.start events from an embedded event
 * stream and call detectLapsFromCrossings.
 */
export function detectLapsFromEvents(
  events: EmbeddedEvent[],
  store: TelemetryStore,
): LapData | null {
  const times = events.filter(e => e.eventId === LAP_START_EVENT).map(e => e.time)
  return detectLapsFromCrossings(times, store, 'events')
}

/** Binary search for the store index closest to a given time. Returns -1 if store is empty. */
function findClosestIndex(store: TelemetryStore, time: number): number {
  if (store.length === 0) return -1
  let lo = 0
  let hi = store.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (store.time[mid] < time) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(store.time[lo - 1] - time) < Math.abs(store.time[lo] - time)) {
    return lo - 1
  }
  return lo
}

/** Extract track layout from the last full lap's GPS trace. */
function buildTrackLayout(
  store: TelemetryStore,
  laps: LapInfo[],
  sfLat: number,
  sfLon: number,
): TrackLayout | null {
  const lastLap = laps[laps.length - 1]
  const trackPoints: { lat: number; lon: number }[] = []
  let minLat = Infinity, maxLat = -Infinity
  let minLon = Infinity, maxLon = -Infinity

  const startIdx = findClosestIndex(store, lastLap.startTime)
  for (let i = startIdx; i < store.length; i++) {
    const t = store.time[i]
    if (t > lastLap.endTime) break
    if (store.gps_fix_quality[i] < 1 || store.lat[i] === 0 || store.lon[i] === 0) continue
    const lat = store.lat[i]
    const lon = store.lon[i]
    trackPoints.push({ lat, lon })
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }

  if (trackPoints.length < 10) return null

  return {
    points: trackPoints,
    startFinishLat: sfLat,
    startFinishLon: sfLon,
    bounds: { minLat, maxLat, minLon, maxLon },
  }
}
