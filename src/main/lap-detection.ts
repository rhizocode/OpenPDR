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

import type { TelemetryRow, EmbeddedEvent, LapData, LapInfo, TrackLayout } from './parser/types'

// ── Event-based lap detection ────────────────────────────────────────────────

const LAP_START_EVENT = 0   // com.cosworth.event.lap.start
const LAP_END_EVENT = 1     // com.cosworth.event.lap.end

/**
 * Detect laps from embedded event.lap.start timestamps.
 * Returns null if insufficient events — caller should fall back to GPS method.
 */
export function detectLapsFromEvents(
  events: EmbeddedEvent[],
  rows: TelemetryRow[]
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
  const sfRow = findClosestRow(rows, lapStarts[0].time)
  if (!sfRow || sfRow.lat === 0 || sfRow.lon === 0) return null

  const trackLayout = buildTrackLayout(rows, laps, sfRow.lat, sfRow.lon)
  return { laps, trackLayout, hasLapData: true, detectionMethod: 'events' }
}

/** Binary search for the telemetry row closest to a given time. */
function findClosestRow(rows: TelemetryRow[], time: number): TelemetryRow | null {
  if (rows.length === 0) return null
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rows[mid].time < time) lo = mid + 1
    else hi = mid
  }
  // Check neighbours for closest
  if (lo > 0 && Math.abs(rows[lo - 1].time - time) < Math.abs(rows[lo].time - time)) {
    return rows[lo - 1]
  }
  return rows[lo]
}

/** Extract track layout from the last full lap's GPS trace. */
function buildTrackLayout(
  rows: TelemetryRow[],
  laps: LapInfo[],
  sfLat: number,
  sfLon: number
): TrackLayout | null {
  const lastLap = laps[laps.length - 1]
  const trackPoints = rows
    .filter(
      (r) =>
        r.time >= lastLap.startTime &&
        r.time <= lastLap.endTime &&
        r.gps_fix_quality >= 1 &&
        r.lat !== 0 &&
        r.lon !== 0
    )
    .map((r) => ({ lat: r.lat, lon: r.lon }))

  if (trackPoints.length < 10) return null

  const lats = trackPoints.map((p) => p.lat)
  const lons = trackPoints.map((p) => p.lon)

  return {
    points: trackPoints,
    startFinishLat: sfLat,
    startFinishLon: sfLon,
    bounds: {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    },
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

export function detectLaps(rows: TelemetryRow[]): LapData {
  const noLaps: LapData = { laps: [], trackLayout: null, hasLapData: false }

  // Step A: filter to valid on-track GPS points
  const valid = rows.filter(
    (r) => r.speed_kph > MIN_SPEED_KPH && r.gps_fix_quality >= 1 && r.lat !== 0 && r.lon !== 0
  )
  if (valid.length < 100) return noLaps

  // Step B: find start/finish centroid via spatial density grid
  const cellCounts = new Map<string, { count: number; lat: number; lon: number }>()
  for (const r of valid) {
    const cellLat = Math.round(r.lat / CELL_SIZE) * CELL_SIZE
    const cellLon = Math.round(r.lon / CELL_SIZE) * CELL_SIZE
    const key = `${cellLat.toFixed(6)},${cellLon.toFixed(6)}`
    const existing = cellCounts.get(key)
    if (existing) {
      existing.count++
    } else {
      cellCounts.set(key, { count: 1, lat: cellLat, lon: cellLon })
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

  // Step C: state machine to detect lap crossings
  const crossings: number[] = []
  let wasAway = false
  let maxDistFromSf = 0
  let inZone = false
  let zoneEntryTime = 0

  for (const r of valid) {
    const dist = Math.abs(r.lat - sfLat) + Math.abs(r.lon - sfLon)
    const nowInZone = dist < SF_ZONE_RADIUS

    if (!inZone && nowInZone) {
      // Entering zone
      if (wasAway) {
        // Valid crossing — record it
        zoneEntryTime = r.time
        crossings.push(r.time)
        wasAway = false
        maxDistFromSf = 0
      }
      inZone = true
    } else if (inZone && !nowInZone) {
      // Leaving zone
      inZone = false
      maxDistFromSf = 0
    }

    if (!nowInZone) {
      maxDistFromSf = Math.max(maxDistFromSf, dist)
      if (maxDistFromSf > MIN_AWAY_DIST) {
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
  const trackLayout = buildTrackLayout(rows, laps, sfLat, sfLon)
  return { laps, trackLayout, hasLapData: true, detectionMethod: 'gps-density' }
}
