/**
 * OpenPDR — GoPro Telemetry Decoder
 *
 * Converts GPMF payloads into TelemetryStore rows at 10 Hz.
 * Follows the same pattern as marlin/marlin-decoder.ts.
 *
 * Per-sample processing:
 *   1. Read raw bytes via source.read(offset, size)
 *   2. parseGpmfPayload() to extract GPS5, ACCL, GYRO streams
 *   3. Apply SCAL divisors to get physical units
 *   4. ACCL axis remap ZXY → vehicle frame, convert to g
 *   5. GYRO axis remap ZXY, extract yaw → deg/s
 *   6. Resample to 10 Hz grid (GPS ~9 Hz, IMU ~198 Hz → 10 rows per sample)
 *   7. Compute heading from consecutive GPS positions
 *
 * GPS5 components: [lat, lon, alt_m, speed2d_m/s, speed3d_m/s]
 * Default SCAL: [10000000, 10000000, 1000, 1000, 100]
 *
 * Hero10 ACCL/GYRO axis order: [Z, X, Y]
 *   Vehicle frame: lateral=Y(raw[2]), longitudinal=X(raw[1]), vertical=Z(raw[0])
 */

import type { PdrFileSource } from '../../shared/file-source'
import type { SampleTable, TrackTiming, ProgressCallback, SessionInfo } from '../types'
import type { TelemetryStore } from '../../shared/telemetry-store'
import { getSampleOffsets } from '../sample-table'
import { parseGpmfPayload, readInt16Array, readInt32Array, readFloat32Array } from './gpmf-decoder'
import type { GpmfStream, GpmfPayload } from './gpmf-decoder'

const G = 9.80665   // m/s^2 per g
const DEG = 180 / Math.PI

/** Session info extracted from GPMF metadata. */
export interface GoProSessionInfo {
  deviceName?: string
  timestamp?: string  // ISO 8601
  sessionInfo: SessionInfo
}

/**
 * Decode all GoPro GPMF samples and write telemetry into the store at 10 Hz.
 */
export async function decodeGoProSamples(
  source: PdrFileSource,
  sampleTable: SampleTable,
  sampleOffsets: number[],
  trackTiming: TrackTiming | null,
  store: TelemetryStore,
  onProgress?: ProgressCallback,
): Promise<GoProSessionInfo> {
  const totalSamples = Math.min(sampleOffsets.length, sampleTable.sampleSizes.length)
  let deviceName: string | undefined
  let gpsuTimestamp: string | undefined

  // Track previous GPS position for heading computation
  let prevLat = 0
  let prevLon = 0
  let prevHeading = 0

  for (let i = 0; i < totalSamples; i++) {
    const offset = sampleOffsets[i]
    const size = sampleTable.sampleSizes[i]
    if (size < 16) continue

    const raw = await source.read(offset, size)
    if (raw.length < size) break

    const payload = parseGpmfPayload(raw)

    // Capture metadata from first sample
    if (!deviceName && payload.dvnm) deviceName = payload.dvnm
    if (!gpsuTimestamp && payload.gpsu) gpsuTimestamp = payload.gpsu

    // Determine sample base time from track timing or index
    const sampleTime = trackTiming ? trackTiming.sampleTimes[i] : i

    // Extract and decode streams
    const gps5 = findStream(payload, 'GPS5')
    const accl = findStream(payload, 'ACCL')
    const gyro = findStream(payload, 'GYRO')

    // Decode GPS5 → [lat, lon, alt, speed2d, speed3d] per row
    const gpsRows = gps5 ? decodeGps5(gps5) : null
    const gpsCount = gpsRows ? gpsRows.length : 0

    // Decode ACCL → [z, x, y] per row (raw sensor order)
    const acclRows = accl ? decodeImu(accl) : null
    const acclCount = acclRows ? acclRows.length : 0

    // Decode GYRO → [z, x, y] per row (raw sensor order)
    const gyroRows = gyro ? decodeImu(gyro) : null
    const gyroCount = gyroRows ? gyroRows.length : 0

    const gpsFix = payload.gpsf ?? 0

    // Resample to 10 output rows per ~1s sample
    const outputCount = 10
    for (let r = 0; r < outputCount; r++) {
      const idx = store.length
      if (idx >= store.time.length) break

      const t = sampleTime + r * 0.1
      store.time[idx] = t
      store.packetIdx[idx] = i
      store.frameIdx[idx] = r

      // GPS: nearest-neighbor from ~9 Hz grid
      // Skip samples with no fix (fix=0) — leave lat/lon at 0 so
      // interpolateGps() can fill the gap from surrounding good data.
      if (gpsRows && gpsCount > 0 && gpsFix >= 2) {
        const gi = Math.min(Math.round(r * (gpsCount - 1) / (outputCount - 1)), gpsCount - 1)
        const gps = gpsRows[gi]
        store.lat[idx] = gps.lat
        store.lon[idx] = gps.lon
        store.altitude_m[idx] = gps.alt
        store.speed_mps[idx] = gps.speed2d
        store.speed_kph[idx] = gps.speed2d * 3.6
        store.speed_mph[idx] = gps.speed2d * 2.23694

        // Compute heading from consecutive GPS positions
        if (prevLat !== 0 && prevLon !== 0) {
          const dlat = gps.lat - prevLat
          const dlon = gps.lon - prevLon
          if (Math.abs(dlat) > 1e-8 || Math.abs(dlon) > 1e-8) {
            const cosLat = Math.cos(gps.lat * Math.PI / 180)
            let heading = Math.atan2(dlon * cosLat, dlat) * DEG
            if (heading < 0) heading += 360
            prevHeading = heading
          }
        }
        store.heading_deg[idx] = prevHeading

        prevLat = gps.lat
        prevLon = gps.lon

        store.gps_fix_quality[idx] = gpsFix
      }

      // ACCL: average IMU samples in this 0.1s bin
      if (acclRows && acclCount > 0) {
        const binStart = Math.floor(r * acclCount / outputCount)
        const binEnd = Math.floor((r + 1) * acclCount / outputCount)
        const count = Math.max(binEnd - binStart, 1)
        let sumZ = 0, sumX = 0, sumY = 0
        for (let j = binStart; j < binEnd && j < acclCount; j++) {
          sumZ += acclRows[j].z
          sumX += acclRows[j].x
          sumY += acclRows[j].y
        }
        // Axis remap: raw [Z, X, Y] → vehicle [lat=Y, lon=X, vert=Z]
        store.gforce_lat[idx] = (sumY / count) / G
        store.gforce_lon[idx] = (sumX / count) / G
        store.gforce_vert[idx] = (sumZ / count) / G
      }

      // GYRO: average and extract yaw
      if (gyroRows && gyroCount > 0) {
        const binStart = Math.floor(r * gyroCount / outputCount)
        const binEnd = Math.floor((r + 1) * gyroCount / outputCount)
        const count = Math.max(binEnd - binStart, 1)
        let sumZ = 0
        for (let j = binStart; j < binEnd && j < gyroCount; j++) {
          sumZ += gyroRows[j].z
        }
        // Yaw rate = Z axis rotation in deg/s
        store.gyro_yaw_deg_s[idx] = (sumZ / count) * DEG
      }

      store.length++
    }

    if (onProgress && (i % 10 === 0 || i === totalSamples - 1)) {
      const pct = 10 + Math.round((i / totalSamples) * 85)
      onProgress('Decoding GoPro telemetry...', pct)
    }
  }

  // Build session info
  const timestamp = gpsuTimestamp ? parseGpsuTimestamp(gpsuTimestamp) : undefined
  const sessionInfo: SessionInfo = {
    camera: deviceName,
    timestamp,
  }

  return { deviceName, timestamp, sessionInfo }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findStream(payload: GpmfPayload, fourcc: string): GpmfStream | undefined {
  return payload.streams.find(s => s.fourcc === fourcc)
}

interface Gps5Row {
  lat: number
  lon: number
  alt: number
  speed2d: number
  speed3d: number
}

/** Decode GPS5 stream: apply SCAL to get physical units. */
function decodeGps5(stream: GpmfStream): Gps5Row[] {
  const scale = stream.scale ?? [10000000, 10000000, 1000, 1000, 100]
  const rows: Gps5Row[] = []

  // GPS5 can be int32 or float32 depending on firmware
  let raw: number[]
  if (stream.type === 0x6C) { // 'l' = int32
    raw = readInt32Array(stream)
  } else if (stream.type === 0x66) { // 'f' = float32
    raw = readFloat32Array(stream)
  } else {
    return rows
  }

  const componentsPerRow = stream.structSize / 4
  if (componentsPerRow < 5) return rows

  for (let i = 0; i < stream.repeat; i++) {
    const base = i * componentsPerRow
    rows.push({
      lat: raw[base] / (scale[0] ?? 1),
      lon: raw[base + 1] / (scale[1] ?? 1),
      alt: raw[base + 2] / (scale[2] ?? 1),
      speed2d: raw[base + 3] / (scale[3] ?? 1),
      speed3d: raw[base + 4] / (scale[4] ?? 1),
    })
  }
  return rows
}

interface ImuRow {
  z: number
  x: number
  y: number
}

/** Decode ACCL or GYRO stream: apply SCAL, keep raw axis order [Z, X, Y]. */
function decodeImu(stream: GpmfStream): ImuRow[] {
  // SCAL for ACCL is typically [417] or similar single value
  // SCAL for GYRO is typically [939] or similar single value
  const scaleArr = stream.scale ?? [1]
  const scale = scaleArr[0] ?? 1

  const rows: ImuRow[] = []

  let raw: number[]
  if (stream.type === 0x73) { // 's' = int16
    raw = readInt16Array(stream)
  } else if (stream.type === 0x66) { // 'f' = float32
    raw = readFloat32Array(stream)
  } else {
    return rows
  }

  const componentsPerRow = stream.type === 0x73 ? stream.structSize / 2 : stream.structSize / 4
  if (componentsPerRow < 3) return rows

  for (let i = 0; i < stream.repeat; i++) {
    const base = i * componentsPerRow
    rows.push({
      z: raw[base] / scale,
      x: raw[base + 1] / scale,
      y: raw[base + 2] / scale,
    })
  }
  return rows
}

/**
 * Parse GPSU timestamp string (format: YYMMDDHHMMSS.SSS) to ISO 8601.
 * Example: "231115093045.123" → "2023-11-15T09:30:45.123Z"
 */
function parseGpsuTimestamp(gpsu: string): string | undefined {
  if (gpsu.length < 12) return undefined
  const yy = parseInt(gpsu.substring(0, 2), 10)
  const mm = parseInt(gpsu.substring(2, 4), 10)
  const dd = parseInt(gpsu.substring(4, 6), 10)
  const hh = parseInt(gpsu.substring(6, 8), 10)
  const mi = parseInt(gpsu.substring(8, 10), 10)
  const ss = parseInt(gpsu.substring(10, 12), 10)
  const frac = gpsu.length > 13 ? gpsu.substring(12) : ''

  if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return undefined

  const year = 2000 + yy
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${year}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(ss)}${frac}Z`
}

