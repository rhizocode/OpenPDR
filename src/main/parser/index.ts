/**
 * OpenPDR Telemetry Parser — Public API
 *
 * Parses PDR MP4 files and extracts telemetry data directly from the
 * AliveDrive adco data track. No JSON sidecar needed.
 *
 * Performance strategy:
 * - Read only the moov box (~100KB) into memory for box traversal
 * - Read each telemetry packet (~3247 bytes) individually via seek+read
 * - Never load the full 700MB file into memory
 */

import { open, stat } from 'fs/promises'
import { readMoovBox, scanForBox } from './mp4-boxes'
import { findAdcoTrack, parseAdvi, parseAdop } from './adco-track'
import { parseSampleTable, getSampleOffsets } from './sample-table'
import { decodePacket } from './telemetry-decoder'
import { findGpsInPacket } from './gps-discovery'
import { DEG_SCALE } from './constants'
import { detectLaps } from '../lap-detection'
import type { ParseResult, TelemetryRow, GpsRefRange, ProgressCallback } from './types'

export type { TelemetryRow, ParseResult, ProgressCallback }

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
  filePath: string,
  onProgress?: ProgressCallback
): Promise<ParseResult> {
  const fileInfo = await stat(filePath)
  const fileSize = fileInfo.size
  const fh = await open(filePath, 'r')

  try {
    onProgress?.('Reading MP4 structure...', 0)

    // Step 1: Read and parse moov box
    const moovBuf = await readMoovBox(fh, fileSize)

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

    // Step 4b: If no ref from adop, find it from a middle packet
    if (!refLatRange && sampleOffsets.length > 0) {
      const midIdx = Math.floor(sampleOffsets.length / 2)
      const searchEnd = Math.min(midIdx + 50, sampleOffsets.length)

      for (let tryIdx = midIdx; tryIdx < searchEnd; tryIdx++) {
        const off = sampleOffsets[tryIdx]
        const sz = sampleTable.sampleSizes[tryIdx]
        if (sz <= 100) continue

        const packetBuf = Buffer.alloc(sz)
        await fh.read(packetBuf, 0, sz, off)

        const gps = findGpsInPacket(packetBuf)
        if (gps.length >= 5) {
          const latRaw = packetBuf.readInt32BE(gps[0])
          const lonRaw = packetBuf.readInt32BE(gps[0] + 4)
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

    // Step 5: Decode all packets
    onProgress?.('Decoding telemetry...', 10)
    const allRows: TelemetryRow[] = []
    const maxPacketSize = Math.max(...sampleTable.sampleSizes, 8192)
    const packetBuf = Buffer.alloc(maxPacketSize)

    for (let i = 0; i < sampleOffsets.length; i++) {
      const offset = sampleOffsets[i]
      const size = sampleTable.sampleSizes[i]

      if (size < 100) continue // skip init packet

      await fh.read(packetBuf, 0, size, offset)
      const packet = packetBuf.subarray(0, size)

      const rows = decodePacket(packet, i, refLatRange, hz100Size)
      for (const row of rows) {
        allRows.push(row)
      }

      // Report progress every 10 packets
      if (i % 10 === 0) {
        const pct = 10 + Math.round((i / sampleOffsets.length) * 85)
        onProgress?.('Decoding telemetry...', pct)
      }
    }

    onProgress?.('Complete', 100)

    // Build metadata
    let maxSpeed = 0
    let maxRpm = 0
    for (const row of allRows) {
      if (row.speed_kph > maxSpeed) maxSpeed = row.speed_kph
      if (row.rpm > maxRpm) maxRpm = row.rpm
    }

    const duration = allRows.length > 0
      ? allRows[allRows.length - 1].time - allRows[0].time
      : 0

    const lapData = detectLaps(allRows)

    return {
      rows: allRows,
      metadata: {
        fileName: filePath.replace(/\\/g, '/').split('/').pop() ?? '',
        fileSize,
        sampleCount: sampleTable.sampleCount,
        duration,
        adviInfo,
        refLocation,
        maxSpeed_kph: maxSpeed,
        maxRpm: maxRpm,
        lapData,
      },
    }
  } finally {
    await fh.close()
  }
}
