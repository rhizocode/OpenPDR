/**
 * OpenPDR — GPS-based lap detection
 *
 * Detects lap boundaries and extracts a track layout from parsed telemetry.
 * Works entirely from GPS lat/lon/speed — no external map data needed.
 *
 * Algorithm overview:
 *  1. Filter to valid GPS points (moving + good fix)
 *  2. Find start/finish centroid via spatial density grid
 *  3. Detect lap crossings via zone proximity + minimum distance traveled
 *  4. Build lap list from crossing pairs (filter unreasonable times)
 *  5. Extract last full lap GPS trace as the track layout
 */

import type { TelemetryRow, LapData, LapInfo, TrackLayout } from './parser/types'

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

  if (trackPoints.length < 10) return { laps, trackLayout: null, hasLapData: true }

  const lats = trackPoints.map((p) => p.lat)
  const lons = trackPoints.map((p) => p.lon)
  const bounds = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  }

  const trackLayout: TrackLayout = {
    points: trackPoints,
    startFinishLat: sfLat,
    startFinishLon: sfLon,
    bounds,
  }

  return { laps, trackLayout, hasLapData: true }
}
