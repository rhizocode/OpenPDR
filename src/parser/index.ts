/**
 * OpenPDR Telemetry Parser — Public API
 *
 * Parses PDR MP4 files and extracts telemetry data directly from the
 * AliveDrive adco data track. No JSON sidecar needed.
 *
 * Platform-agnostic: reads data through the PdrFileSource interface
 * instead of Node.js fs directly.
 *
 * Performance strategy:
 * - Read only the moov box (~100KB) into memory for box traversal
 * - Read each telemetry packet (~3247 bytes) individually via seek+read
 * - Never load the full 700MB file into memory
 */

import type { PdrFileSource } from '../shared/file-source'
import { readMoovBox, findBox, readBoxHeader, scanForBox, parseMvhdTimescale } from './mp4-boxes'
import { findAdcoTrack, parseAdvi, parseAdop, parseAdeg } from './adco-track'
import { parseSampleTable, getSampleOffsets, parseTrackTiming } from './sample-table'
import { decodePacket } from './telemetry-decoder'
import { extractEvents } from './event-extractor'
import { createTelemetryStore, writeRow, trimStore, interpolateGps } from '../shared/telemetry-store'
import type { TelemetryStore } from '../shared/telemetry-store'
import { detectLaps, detectLapsFromEvents } from './lap-detection'
import type { ParseResult, SessionInfo, TelemetryRow, EmbeddedEvent, ProgressCallback } from './types'

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

  // Step 1: Read and parse moov box
  const moovBuf = await readMoovBox(source)

  // Step 2: Find the ADCO data track
  const trackInfo = findAdcoTrack(moovBuf)
  if (!trackInfo) {
    throw new Error('Could not find AliveDrive data track (adrv/adco)')
  }

  // Step 3: Parse sample table and track timing
  const sampleTable = parseSampleTable(moovBuf, trackInfo.trakData, trackInfo.trakEnd)
  if (!sampleTable) {
    throw new Error('Could not parse sample table')
  }
  const sampleOffsets = getSampleOffsets(sampleTable)

  // Parse mvhd timescale (needed for edts/elst conversion)
  const mvhdTimescale = parseMvhdTimescale(moovBuf)

  // Parse track timing: mdhd timescale, stts durations, edts/elst delay
  // This gives us per-sample presentation times for proper video sync
  const trackTiming = parseTrackTiming(
    moovBuf, trackInfo.trakData, trackInfo.trakEnd,
    mvhdTimescale, sampleTable.sampleCount,
  )

  onProgress?.('Parsing metadata...', 5)

  // Step 4: Parse metadata sub-boxes (advi, adop)
  // Prefer structured findBox within moov (O(n) walk), fall back to brute-force scanForBox
  const moovHdr = readBoxHeader(moovBuf, 0)
  const moovDataStart = moovHdr?.dataStart ?? 8
  const findMetaBox = (tag: string) =>
    findBox(moovBuf, tag, moovDataStart) ?? scanForBox(moovBuf, tag)

  const adviBox = findMetaBox('advi')
  const adviInfo = adviBox
    ? parseAdvi(moovBuf.subarray(adviBox[2], adviBox[0] + adviBox[1]))
    : undefined

  // Determine 100Hz frame size from dominant packet size.
  // MMP version alone isn't reliable across generations (gen1 MMP v8 uses old format).
  // Packet size is the direct indicator: ~4050 = MMP v4+ format, ~3247 = legacy format.
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
    // Build session info from decoded adop properties + advi fields
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

  // Step 4c: Parse event definitions (adeg)
  const adegBox = findMetaBox('adeg')
  const eventDefs = adegBox
    ? parseAdeg(moovBuf.subarray(adegBox[2], adegBox[0] + adegBox[1]))
    : []

  // Step 5: Decode all packets into columnar store + extract embedded events
  onProgress?.('Decoding telemetry...', 10)
  const estimatedRows = sampleTable.sampleCount * 10  // ~10 rows per packet at 10 Hz
  const store = createTelemetryStore(estimatedRows)
  const allEvents: EmbeddedEvent[] = []

  // The first sample in the data track is typically a small init/config packet
  // that we skip (size < 100). However it still occupies time in the MP4
  // timeline (usually 1 second via stts), pushing all real telemetry timestamps
  // forward. We subtract the first real packet's sampleTime so telemetry time 0
  // aligns with video time 0.
  let timeBase = 0

  for (let i = 0; i < sampleOffsets.length; i++) {
    const offset = sampleOffsets[i]
    const size = sampleTable.sampleSizes[i]

    if (size < 100) continue // skip init packet

    const packet = await source.read(offset, size)

    // Use MP4 presentation time from stts/elst when available,
    // fall back to packet index (assumes 1 second per packet)
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

    // Extract embedded events from oversized packets
    const events = extractEvents(packet, dominantPktSize, eventDefs)
    for (const evt of events) allEvents.push(evt)

    // Report progress every 10 packets
    if (i % 10 === 0) {
      const pct = 10 + Math.round((i / sampleOffsets.length) * 85)
      onProgress?.('Decoding telemetry...', pct)
    }
  }

  onProgress?.('Complete', 100)

  // Trim store to actual size (capacity was estimated)
  const trimmedStore = trimStore(store)

  // Interpolate GPS between genuine fixes to eliminate duplicate-coordinate stutter
  interpolateGps(trimmedStore)

  // If no refLocation from adop, derive it from the first decoded GPS position
  if (!refLocation && trimmedStore.length > 0) {
    const lat = trimmedStore.lat[0]
    const lon = trimmedStore.lon[0]
    if (Math.abs(lat) > 1 && Math.abs(lon) > 1) {
      refLocation = { lat, lon }
    }
  }

  // Build metadata from typed arrays (no row objects needed)
  let maxSpeed = 0
  let maxRpm = 0
  for (let i = 0; i < trimmedStore.length; i++) {
    if (trimmedStore.speed_kph[i] > maxSpeed) maxSpeed = trimmedStore.speed_kph[i]
    if (trimmedStore.rpm[i] > maxRpm) maxRpm = trimmedStore.rpm[i]
  }

  const duration = trimmedStore.length > 0
    ? trimmedStore.time[trimmedStore.length - 1] - trimmedStore.time[0]
    : 0

  // Try event-based lap detection first, fall back to GPS density heuristic
  const lapData = detectLapsFromEvents(allEvents, trimmedStore) ?? detectLaps(trimmedStore)

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
