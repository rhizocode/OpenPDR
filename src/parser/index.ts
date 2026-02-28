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
import { readInt32BE } from '../shared/binary-reader'
import { readMoovBox, scanForBox } from './mp4-boxes'
import { findAdcoTrack, parseAdvi, parseAdop, parseAdeg } from './adco-track'
import { parseSampleTable, getSampleOffsets } from './sample-table'
import { decodePacket, type CachedOffsets } from './telemetry-decoder'
import { findGpsInPacket } from './gps-discovery'
import { DEG_SCALE } from './constants'
import { extractEvents } from './event-extractor'
import { createTelemetryStore, writeRow, trimStore } from '../shared/telemetry-store'
import type { TelemetryStore } from '../shared/telemetry-store'
import { detectLaps, detectLapsFromEvents } from './lap-detection'
import type { ParseResult, TelemetryRow, EmbeddedEvent, GpsRefRange, ProgressCallback } from './types'

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

  // Step 3: Parse sample table
  const sampleTable = parseSampleTable(moovBuf, trackInfo.trakData, trackInfo.trakEnd)
  if (!sampleTable) {
    throw new Error('Could not parse sample table')
  }
  const sampleOffsets = getSampleOffsets(sampleTable)

  onProgress?.('Parsing metadata...', 5)

  // Step 4: Parse metadata sub-boxes (advi, adop)
  const adviBox = scanForBox(moovBuf, 'advi')
  const adviInfo = adviBox
    ? parseAdvi(moovBuf.subarray(adviBox[2], adviBox[0] + adviBox[1]))
    : undefined

  // Determine 100Hz frame size from dominant packet size.
  // MMP version alone isn't reliable across generations (gen1 MMP v8 uses old format).
  // Packet size is the direct indicator: ~4050 = MMP v4+ format, ~3247 = legacy format.
  const dominantPktSize = mostCommonValue(sampleTable.sampleSizes)
  const hz100Size = dominantPktSize > 3500 ? 25 : 17

  const adopBox = scanForBox(moovBuf, 'adop')
  let refLatRange: GpsRefRange | undefined
  let refLocation: { lat: number; lon: number } | undefined

  if (adopBox) {
    const props = parseAdop(moovBuf.subarray(adopBox[2], adopBox[0] + adopBox[1]))
    if (props.lat !== undefined && props.lon !== undefined) {
      refLocation = { lat: props.lat, lon: props.lon }
      refLatRange = {
        latMin: props.lat - 1.0,
        latMax: props.lat + 1.0,
        lonMin: props.lon - 1.0,
        lonMax: props.lon + 1.0,
      }
    }
  }

  // Step 4c: Parse event definitions (adeg)
  const adegBox = scanForBox(moovBuf, 'adeg')
  const eventDefs = adegBox
    ? parseAdeg(moovBuf.subarray(adegBox[2], adegBox[0] + adegBox[1]))
    : []

  // Step 4b: If no ref from adop, find it from a middle packet
  if (!refLatRange && sampleOffsets.length > 0) {
    const midIdx = Math.floor(sampleOffsets.length / 2)
    const searchEnd = Math.min(midIdx + 50, sampleOffsets.length)

    for (let tryIdx = midIdx; tryIdx < searchEnd; tryIdx++) {
      const off = sampleOffsets[tryIdx]
      const sz = sampleTable.sampleSizes[tryIdx]
      if (sz <= 100) continue

      const packetBuf = await source.read(off, sz)

      const gps = findGpsInPacket(packetBuf)
      if (gps.length >= 5) {
        const latRaw = readInt32BE(packetBuf, gps[0])
        const lonRaw = readInt32BE(packetBuf, gps[0] + 4)
        const lat = latRaw * DEG_SCALE
        const lon = lonRaw * DEG_SCALE
        refLocation = { lat, lon }
        refLatRange = {
          latMin: lat - 1.0,
          latMax: lat + 1.0,
          lonMin: lon - 1.0,
          lonMax: lon + 1.0,
        }
        break
      }
    }
  }

  // Step 5: Decode all packets into columnar store + extract embedded events
  onProgress?.('Decoding telemetry...', 10)
  const estimatedRows = sampleTable.sampleCount * 10  // ~10 rows per packet at 10 Hz
  const store = createTelemetryStore(estimatedRows)
  const allEvents: EmbeddedEvent[] = []

  let cachedOffsets: CachedOffsets | undefined
  for (let i = 0; i < sampleOffsets.length; i++) {
    const offset = sampleOffsets[i]
    const size = sampleTable.sampleSizes[i]

    if (size < 100) continue // skip init packet

    const packet = await source.read(offset, size)

    const result = decodePacket(packet, i, refLatRange, hz100Size, cachedOffsets)
    cachedOffsets = result.offsets
    for (const row of result.rows) {
      writeRow(store, store.length, row)
      store.length++
    }

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
      refLocation,
      maxSpeed_kph: maxSpeed,
      maxRpm: maxRpm,
      lapData,
    },
  }
}
