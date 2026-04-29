/**
 * OpenPDR Telemetry Parser — Public API
 *
 * Parses PDR MP4 files and extracts telemetry data from the embedded
 * data track. Automatically detects the format (AliveDrive or Marlin)
 * and routes to the appropriate parser. Both produce identical
 * TelemetryStore output — callers are format-agnostic.
 *
 * Platform-agnostic: reads data through the PdrFileSource interface
 * instead of Node.js fs directly.
 *
 * Performance strategy:
 * - Read only the moov box (~100KB) into memory for box traversal
 * - Read each telemetry packet individually via seek+read
 * - Never load the full 700MB+ file into memory
 */

import type { PdrFileSource } from '../shared/file-source'
import { readMoovBox, findBox, readBoxHeader, scanForBox, parseMvhdTimescale } from './mp4-boxes'
import { findAdcoTrack, parseAdvi, parseAdop, parseAdeg } from './adco-track'
import { parseSampleTable, getSampleOffsets, parseTrackTiming } from './sample-table'
import { decodePacket } from './telemetry-decoder'
import { extractEvents } from './event-extractor'
import { createTelemetryStore, writeRow, trimStore, interpolateGps } from '../shared/telemetry-store'
import type { TelemetryStore } from '../shared/telemetry-store'
import { detectLapsFromEvents, detectLapsFromCrossings } from './lap-detection'
import { detectFormat } from './format-detect'
import { parseMarlSubBoxes } from './marlin/marlin-track'
import { decodeMarlinSamples } from './marlin/marlin-decoder'
import type { ParseResult, SessionInfo, TelemetryRow, EmbeddedEvent, ProgressCallback, TrackInfo } from './types'

export type { TelemetryRow, ParseResult, ProgressCallback }
export type { TelemetryStore }

/** Return the most frequently occurring value in an array. */
function mostCommonValue(arr: number[]): number {
  const counts = new Map<number, number>()
  for (const v of arr) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c }
  }
  return best
}

export async function parsePdrFile(
  source: PdrFileSource,
  fileName: string,
  onProgress?: ProgressCallback
): Promise<ParseResult> {
  onProgress?.('Reading MP4 structure...', 0)

  // Step 1: Read moov box (handles both moov-at-start and moov-at-end)
  const moovBuf = await readMoovBox(source)

  // Step 2: Detect format
  const detection = detectFormat(moovBuf)
  if (!detection) {
    throw new Error('No PDR data track found (checked for AliveDrive adrv/adco and Marlin ctbx/marl)')
  }

  console.log(`[parser] Detected format: ${detection.format}`)

  // Step 3: Route to format-specific parser
  switch (detection.format) {
    case 'alivedrive':
      return parseAliveDrive(source, moovBuf, detection.trackInfo, fileName, onProgress)
    case 'marlin':
      return parseMarlin(source, moovBuf, detection.trackInfo, fileName, onProgress)
  }
}

// =============================================================================
// AliveDrive Parser (existing logic, extracted unchanged)
// =============================================================================

async function parseAliveDrive(
  source: PdrFileSource,
  moovBuf: Uint8Array,
  trackInfo: TrackInfo,
  fileName: string,
  onProgress?: ProgressCallback,
): Promise<ParseResult> {
  // Parse sample table and track timing
  const sampleTable = parseSampleTable(moovBuf, trackInfo.trakData, trackInfo.trakEnd)
  if (!sampleTable) {
    throw new Error('Could not parse sample table')
  }
  const sampleOffsets = getSampleOffsets(sampleTable)

  const mvhdTimescale = parseMvhdTimescale(moovBuf)
  const trackTiming = parseTrackTiming(
    moovBuf, trackInfo.trakData, trackInfo.trakEnd,
    mvhdTimescale, sampleTable.sampleCount,
  )

  if (trackTiming) {
    console.log(`[sync] Data track: elstDelay=${trackTiming.elstDelay.toFixed(3)}s, ` +
      `mediaStart=${trackTiming.mediaStartTime.toFixed(3)}s, ` +
      `sample0=${trackTiming.sampleTimes[0]?.toFixed(3)}s, sample1=${trackTiming.sampleTimes[1]?.toFixed(3)}s`)
  }

  onProgress?.('Parsing metadata...', 5)

  // Parse metadata sub-boxes (advi, adop)
  const moovHdr = readBoxHeader(moovBuf, 0)
  const moovDataStart = moovHdr?.dataStart ?? 8
  const findMetaBox = (tag: string) =>
    findBox(moovBuf, tag, moovDataStart) ?? scanForBox(moovBuf, tag)

  const adviBox = findMetaBox('advi')
  const adviInfo = adviBox
    ? parseAdvi(moovBuf.subarray(adviBox[2], adviBox[0] + adviBox[1]))
    : undefined

  // Determine 100Hz frame size from dominant packet size
  const dominantPktSize = mostCommonValue(sampleTable.sampleSizes)
  const hz100Size = dominantPktSize > 3500 ? 25 : 17

  const adopBox = findMetaBox('adop')
  let refLocation: { lat: number; lon: number } | undefined
  let sessionInfo: SessionInfo | undefined

  if (adopBox) {
    const adopData = moovBuf.subarray(adopBox[2], adopBox[0] + adopBox[1])
    const props = parseAdop(adopData)
    if (props.lat !== undefined && props.lon !== undefined) {
      refLocation = { lat: props.lat, lon: props.lon }
    }
    const p = props.properties
    sessionInfo = {
      vehicle: p.get('vehicle.make'),
      model: p.get('vehicle.model') ?? p.get('carname'),
      engine: p.get('vehicle.enginetype'),
      year: p.get('vehicle.modelyear'),
      timestamp: p.get('timestamp'),
      generation: adviInfo?.generation,
      mmpVersion: adviInfo?.mmpVersion,
    }
  } else if (adviInfo) {
    sessionInfo = {
      generation: adviInfo.generation,
      mmpVersion: adviInfo.mmpVersion,
    }
  }

  // Parse event definitions (adeg)
  const adegBox = findMetaBox('adeg')
  const eventDefs = adegBox
    ? parseAdeg(moovBuf.subarray(adegBox[2], adegBox[0] + adegBox[1]))
    : []

  // Decode all packets into columnar store + extract embedded events
  onProgress?.('Decoding telemetry...', 10)
  const estimatedRows = sampleTable.sampleCount * 10
  const store = createTelemetryStore(estimatedRows)
  const allEvents: EmbeddedEvent[] = []

  let timeBase = 0

  for (let i = 0; i < sampleOffsets.length; i++) {
    const offset = sampleOffsets[i]
    const size = sampleTable.sampleSizes[i]

    if (size < 100) continue

    const packet = await source.read(offset, size)

    const rawBaseTime = trackTiming ? trackTiming.sampleTimes[i] : i
    if (!timeBase && rawBaseTime > 0) timeBase = rawBaseTime
    const baseTime = rawBaseTime - timeBase

    const rows = decodePacket(packet, baseTime, i, hz100Size)
    let storeFull = false
    for (const row of rows) {
      if (store.length >= store.time.length) { storeFull = true; break }
      writeRow(store, store.length, row)
      store.length++
    }
    if (storeFull) break

    const events = extractEvents(packet, dominantPktSize, eventDefs)
    for (const evt of events) allEvents.push(evt)

    if (i % 10 === 0) {
      const pct = 10 + Math.round((i / sampleOffsets.length) * 85)
      onProgress?.('Decoding telemetry...', pct)
    }
  }

  onProgress?.('Complete', 100)

  const trimmedStore = trimStore(store)
  interpolateGps(trimmedStore)

  if (!refLocation && trimmedStore.length > 0) {
    const lat = trimmedStore.lat[0]
    const lon = trimmedStore.lon[0]
    if (Math.abs(lat) > 1 && Math.abs(lon) > 1) {
      refLocation = { lat, lon }
    }
  }

  let maxSpeed = 0
  let maxRpm = 0
  for (let i = 0; i < trimmedStore.length; i++) {
    if (trimmedStore.speed_kph[i] > maxSpeed) maxSpeed = trimmedStore.speed_kph[i]
    if (trimmedStore.rpm[i] > maxRpm) maxRpm = trimmedStore.rpm[i]
  }

  const duration = trimmedStore.length > 0
    ? trimmedStore.time[trimmedStore.length - 1] - trimmedStore.time[0]
    : 0

  const lapData = detectLapsFromEvents(allEvents, trimmedStore)
    ?? { laps: [], trackLayout: null, hasLapData: false }

  return {
    store: trimmedStore,
    metadata: {
      fileName,
      fileSize: source.size,
      sampleCount: sampleTable.sampleCount,
      duration,
      adviInfo,
      sessionInfo,
      refLocation,
      maxSpeed_kph: maxSpeed,
      maxRpm: maxRpm,
      lapData,
    },
  }
}

// =============================================================================
// Marlin Parser
// =============================================================================

async function parseMarlin(
  source: PdrFileSource,
  moovBuf: Uint8Array,
  trackInfo: TrackInfo,
  fileName: string,
  onProgress?: ProgressCallback,
): Promise<ParseResult> {
  onProgress?.('Parsing Marlin metadata...', 5)

  // Parse stsd → marl sub-boxes (mrlh, mrlv, mrld)
  const { version, metadata: marlMeta, channels } = parseMarlSubBoxes(
    moovBuf, trackInfo.trakData, trackInfo.trakEnd,
  )

  if (channels.size === 0) {
    throw new Error('No channel definitions found in Marlin mrld box')
  }

  console.log(`[marlin] Version: 0x${version.toString(16).padStart(8, '0')}, ` +
    `Channels: ${channels.size}`)
  if (marlMeta.trackName) console.log(`[marlin] Track: ${marlMeta.trackName}`)
  if (marlMeta.startDate) console.log(`[marlin] Date: ${marlMeta.startDate} ${marlMeta.startTime}`)
  if (marlMeta.softwareVersion) console.log(`[marlin] Software: ${marlMeta.softwareVersion}`)

  // Parse sample table (reuse generic MP4 sample table parser)
  const sampleTable = parseSampleTable(moovBuf, trackInfo.trakData, trackInfo.trakEnd)
  if (!sampleTable) {
    throw new Error('Could not parse Marlin sample table')
  }

  console.log(`[marlin] Samples: ${sampleTable.sampleCount}`)

  // Estimate duration from mdhd for capacity calculation
  // Marlin timescale is 1000 (ms), so duration / 1000 = seconds
  const mvhdTimescale = parseMvhdTimescale(moovBuf)
  const trackTiming = parseTrackTiming(
    moovBuf, trackInfo.trakData, trackInfo.trakEnd,
    mvhdTimescale, sampleTable.sampleCount,
  )
  const durationEstimate = trackTiming
    ? (trackTiming.duration / trackTiming.timescale)
    : sampleTable.sampleCount  // fallback: ~1 second per sample

  // Allocate store: 10 rows per second + 20% headroom
  const estimatedRows = Math.ceil(durationEstimate * 10 * 1.2)
  const store = createTelemetryStore(Math.max(estimatedRows, 1000))

  // Decode all samples and resample to 10 Hz; also collect S/F beacon
  // crossings for lap detection.
  const { totalRecords, beaconTimes } = await decodeMarlinSamples(
    source, sampleTable, channels, store, onProgress,
  )

  console.log(`[marlin] Decoded ${totalRecords} records → ${store.length} rows at 10 Hz, ` +
    `${beaconTimes.length} beacon crossing(s)`)

  onProgress?.('Finalizing...', 95)

  // Trim store, find reference GPS *before* interpolation (to avoid
  // picking up interpolated ramp values from 0,0 to first real fix)
  const trimmedStore = trimStore(store)

  let refLocation: { lat: number; lon: number } | undefined
  if (trimmedStore.length > 0) {
    for (let i = 0; i < trimmedStore.length; i++) {
      const lat = trimmedStore.lat[i]
      const lon = trimmedStore.lon[i]
      if (Math.abs(lat) > 1 && Math.abs(lon) > 1) {
        refLocation = { lat, lon }
        break
      }
    }
  }

  interpolateGps(trimmedStore)

  // Build session info from Marlin metadata
  let timestamp: string | undefined
  if (marlMeta.startTimestampTicks > 0) {
    const unixMs = (marlMeta.startTimestampTicks / 10_000_000) * 1000
    timestamp = new Date(unixMs).toISOString()
  } else if (marlMeta.startDate) {
    timestamp = `${marlMeta.startDate}T${marlMeta.startTime || '00:00:00'}`
  }

  const sessionInfo: SessionInfo = { timestamp }

  // Compute max stats
  let maxSpeed = 0
  let maxRpm = 0
  for (let i = 0; i < trimmedStore.length; i++) {
    if (trimmedStore.speed_kph[i] > maxSpeed) maxSpeed = trimmedStore.speed_kph[i]
    if (trimmedStore.rpm[i] > maxRpm) maxRpm = trimmedStore.rpm[i]
  }

  const duration = trimmedStore.length > 0
    ? trimmedStore.time[trimmedStore.length - 1] - trimmedStore.time[0]
    : 0

  // Lap detection — Marlin "Beacon" channel transitions (driver-set S/F line)
  const lapData = detectLapsFromCrossings(beaconTimes, trimmedStore, 'beacon')
    ?? { laps: [], trackLayout: null, hasLapData: false }

  onProgress?.('Complete', 100)

  return {
    store: trimmedStore,
    metadata: {
      fileName,
      fileSize: source.size,
      sampleCount: sampleTable.sampleCount,
      duration,
      sessionInfo,
      refLocation,
      maxSpeed_kph: maxSpeed,
      maxRpm: maxRpm,
      lapData,
    },
  }
}
