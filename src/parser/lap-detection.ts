/**
 * OpenPDR — Lap detection
 *
 * Two strategies:
 *  1. Event-based (preferred): Uses embedded event.lap.start/end timestamps
 *     from the PDR firmware, triggered by the user-set S/F line.
 *  2. GPS density fallback: Finds the densest grid cell and detects crossings.
 *
 * The caller should try detectLapsFromEvents() first and fall back to
 * detectLaps() when no embedded events are available.
 */

import type { TelemetryStore } from '../shared/telemetry-store'
import type { EmbeddedEvent, LapData, LapInfo, TrackLayout } from './types'

// ── Event-based lap detection ────────────────────────────────────────────────

const LAP_START_EVENT = 0   // com.cosworth.event.lap.start
const LAP_END_EVENT = 1     // com.cosworth.event.lap.end

/**
 * Detect laps from embedded event.lap.start timestamps.
 * Returns null if insufficient events — caller should fall back to GPS method.
 */
export function detectLapsFromEvents(
  events: EmbeddedEvent[],
  store: TelemetryStore
): LapData | null {
  const lapStarts = events
    .filter(e => e.eventId === LAP_START_EVENT)
    .sort((a, b) => a.time - b.time)

  if (lapStarts.length < 2) return null

  // Build laps from consecutive start-to-start (standard motorsport timing)
  const laps: LapInfo[] = []
  for (let i = 0; i < lapStarts.length - 1; i++) {
    const startTime = lapStarts[i].time
    const endTime = lapStarts[i + 1].time
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

  // Get S/F location from GPS at the first lap-start event
  const sfIdx = findClosestIndex(store, lapStarts[0].time)
  if (sfIdx < 0 || store.lat[sfIdx] === 0 || store.lon[sfIdx] === 0) return null

  const trackLayout = buildTrackLayout(store, laps, store.lat[sfIdx], store.lon[sfIdx])
  return { laps, trackLayout, hasLapData: true, detectionMethod: 'events' }
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
  // Check neighbours for closest
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
  sfLon: number
): TrackLayout | null {
  const lastLap = laps[laps.length - 1]
  const trackPoints: { lat: number; lon: number }[] = []
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity

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

// ── GPS density fallback ─────────────────────────────────────────────────────

// ~20m grid cell in degrees at US latitudes
const CELL_SIZE = 0.00018

// Zone radius for crossing detection (~30m)
const SF_ZONE_RADIUS = 0.00027

// Must travel this far from S/F before another crossing counts (~200m)
const MIN_AWAY_DIST = 0.0018

// Lap time bounds (seconds)
const MIN_LAP_TIME = 60
const MAX_LAP_TIME = 1200

// Minimum speed (kph) to count a GPS point as valid on-track movement
const MIN_SPEED_KPH = 20

export function detectLaps(store: TelemetryStore): LapData {
  const noLaps: LapData = { laps: [], trackLayout: null, hasLapData: false }

  // Step A: collect indices of valid on-track GPS points
  const validIdx: number[] = []
  for (let i = 0; i < store.length; i++) {
    if (
      store.speed_kph[i] > MIN_SPEED_KPH &&
      store.gps_fix_quality[i] >= 1 &&
      store.lat[i] !== 0 &&
      store.lon[i] !== 0
    ) {
      validIdx.push(i)
    }
  }
  if (validIdx.length < 100) return noLaps

  // Step B: find start/finish centroid via spatial density grid
  const cellCounts = new Map<number, { count: number; lat: number; lon: number }>()
  for (const i of validIdx) {
    const cellLatI = Math.round(store.lat[i] / CELL_SIZE)
    const cellLonI = Math.round(store.lon[i] / CELL_SIZE)
    const key = cellLatI * 1000000 + cellLonI
    const existing = cellCounts.get(key)
    if (existing) {
      existing.count++
    } else {
      cellCounts.set(key, { count: 1, lat: cellLatI * CELL_SIZE, lon: cellLonI * CELL_SIZE })
    }
  }

  let maxCount = 0
  let sfLat = 0
  let sfLon = 0
  for (const v of cellCounts.values()) {
    if (v.count > maxCount) {
      maxCount = v.count
      sfLat = v.lat
      sfLon = v.lon
    }
  }

  // Need the car to have passed at least 3 times for a meaningful detection
  if (maxCount < 3) return noLaps

  // Step C: state machine to detect lap crossings (squared Euclidean distance)
  const SF_ZONE_R2 = SF_ZONE_RADIUS * SF_ZONE_RADIUS
  const MIN_AWAY_D2 = MIN_AWAY_DIST * MIN_AWAY_DIST
  const crossings: number[] = []
  let wasAway = false
  let firstEntry = true
  let maxDist2FromSf = 0
  let inZone = false

  for (const i of validIdx) {
    const dlat = store.lat[i] - sfLat
    const dlon = store.lon[i] - sfLon
    const dist2 = dlat * dlat + dlon * dlon
    const nowInZone = dist2 < SF_ZONE_R2

    if (!inZone && nowInZone) {
      // Entering zone — record crossing if car traveled away, or on first entry
      if (wasAway || firstEntry) {
        crossings.push(store.time[i])
        wasAway = false
        maxDist2FromSf = 0
        firstEntry = false
      }
      inZone = true
    } else if (inZone && !nowInZone) {
      // Leaving zone
      inZone = false
      maxDist2FromSf = 0
    }

    if (!nowInZone) {
      maxDist2FromSf = Math.max(maxDist2FromSf, dist2)
      if (maxDist2FromSf > MIN_AWAY_D2) {
        wasAway = true
      }
    }
  }

  if (crossings.length < 2) return noLaps

  // Step D: build laps from consecutive crossing pairs
  const laps: LapInfo[] = []
  for (let i = 0; i < crossings.length - 1; i++) {
    const startTime = crossings[i]
    const endTime = crossings[i + 1]
    const lapTime = endTime - startTime
    if (lapTime < MIN_LAP_TIME || lapTime > MAX_LAP_TIME) continue
    laps.push({
      lapNumber: laps.length + 1,
      startTime,
      endTime,
      lapTime,
    })
  }

  if (laps.length === 0) return noLaps

  // Step E: extract track layout from the last full lap
  const trackLayout = buildTrackLayout(store, laps, sfLat, sfLon)
  return { laps, trackLayout, hasLapData: true, detectionMethod: 'gps-density' }
}
