/**
 * OpenPDR — Marlin Telemetry Record Decoder
 *
 * Decodes event-driven telemetry records (full + diff) from marl data
 * samples and resamples to a uniform 10 Hz grid using carry-forward
 * interpolation.
 *
 * Each MP4 sample contains many individual measurement records with
 * fine-grained timestamps. We preserve every record's timestamp so
 * the 10 Hz grid reflects the true update rate of each channel
 * (100 Hz RPM, 50 Hz accel, 10 Hz GPS, etc.).
 *
 * Ported from protocol/marlin_parser.py (decode_and_resample).
 *
 * Reference: protocol/MARLIN_FORMAT.md §6
 */

import type { PdrFileSource } from '../../shared/file-source'
import type { SampleTable, MarlinChannel, ProgressCallback } from '../types'
import type { TelemetryStore } from '../../shared/telemetry-store'
import { getSampleOffsets } from '../sample-table'
import { readUint32BE, dataViewFor } from '../../shared/binary-reader'
import { convertRaw, getChannelWriter } from './marlin-constants'

const TICKS_PER_SECOND = 10_000_000
const INTERVAL_TICKS = TICKS_PER_SECOND / 10  // 0.1s = 10 Hz

/** A single decoded measurement with absolute raw value and timestamp. */
interface DecodedRecord {
  /** Timestamp in 100 ns ticks from recording start */
  timestamp: number
  /** Channel ID */
  channelId: number
  /** Absolute raw value (diffs already resolved) */
  rawValue: number
}

/**
 * Decode a single marl data sample into individual measurement records
 * with resolved absolute raw values.
 *
 * Full records (16 bytes, 0xC0) provide absolute values and timestamps.
 * Diff records (8 bytes, 0x40) are accumulated onto the previous value
 * for each channel within the sample. Timestamps progress via delta
 * addition. Sentinel timestamps (tsHigh === 0xFFFFFFFF) reuse the last
 * valid timestamp.
 *
 * Returns records in chronological order with absolute raw values.
 */
function decodeSample(data: Uint8Array): DecodedRecord[] {
  let channel = 0
  let timestamp = 0
  const records: DecodedRecord[] = []
  const channelState = new Map<number, number>()  // accumulated raw per channel
  let pos = 0
  const dv = dataViewFor(data)

  while (pos + 8 <= data.length) {
    const word0 = readUint32BE(data, pos, dv)
    const highByte = word0 >>> 24

    if (highByte === 0xFF) break  // end marker

    if ((highByte & 0xC0) === 0xC0) {
      // Full record (16 bytes): absolute channel + value + timestamp
      channel = word0 & 0x0FFFFFFF

      // Signed 32-bit raw value
      const word1 = readUint32BE(data, pos + 4, dv)
      const rawValue = word1 >= 0x80000000 ? word1 - 0x100000000 : word1

      if (pos + 16 > data.length) break

      const tsHigh = readUint32BE(data, pos + 8, dv)
      const tsLow = readUint32BE(data, pos + 12, dv)
      const ts = tsHigh * 0x100000000 + tsLow

      // Sentinel timestamps mean "same time as previous"
      if (tsHigh !== 0xFFFFFFFF && ts > 0) {
        timestamp = ts
      }

      channelState.set(channel, rawValue)
      records.push({ timestamp, channelId: channel, rawValue })
      pos += 16
    } else if ((highByte & 0xC0) === 0x40) {
      // Diff record (8 bytes): channel delta + value delta + time delta
      let chanDiff = highByte & 0x3F
      if (chanDiff & 0x20) chanDiff -= 0x40  // sign-extend 6-bit

      let valDiff = word0 & 0x00FFFFFF
      if (valDiff & 0x800000) valDiff -= 0x1000000  // sign-extend 24-bit

      channel += chanDiff

      const tsDelta = readUint32BE(data, pos + 4, dv)
      timestamp += tsDelta

      // Accumulate delta onto previous value for this channel
      const prev = channelState.get(channel) ?? 0
      const rawValue = prev + valDiff
      channelState.set(channel, rawValue)

      records.push({ timestamp, channelId: channel, rawValue })
      pos += 8
    } else {
      // Unknown record type — skip
      pos += 8
    }
  }

  return records
}

/**
 * Decode all Marlin telemetry samples and resample to a 10 Hz grid.
 *
 * Writes directly into the pre-allocated TelemetryStore. Returns the
 * number of raw measurement records decoded (for diagnostics).
 */
export async function decodeMarlinSamples(
  source: PdrFileSource,
  sampleTable: SampleTable,
  channels: Map<number, MarlinChannel>,
  store: TelemetryStore,
  onProgress?: ProgressCallback,
): Promise<number> {
  const sampleOffsets = getSampleOffsets(sampleTable)
  const totalSamples = Math.min(sampleOffsets.length, sampleTable.sampleSizes.length)

  // Phase 1: Decode all samples into individual timestamped records.
  // Records within each sample are already chronological, and samples
  // are ordered, so the combined list is in timestamp order.
  const allRecords: DecodedRecord[] = []
  let totalRecords = 0

  for (let i = 0; i < totalSamples; i++) {
    const offset = sampleOffsets[i]
    const size = sampleTable.sampleSizes[i]

    if (size < 8) continue  // skip tiny/empty samples

    const data = await source.read(offset, size)
    if (data.length < size) break

    const sampleRecords = decodeSample(data)
    totalRecords += sampleRecords.length

    for (const rec of sampleRecords) {
      if (rec.timestamp > 0) {
        allRecords.push(rec)
      }
    }

    if (onProgress && (i % 100 === 0 || i === totalSamples - 1)) {
      const pct = 10 + Math.round((i / totalSamples) * 60)
      onProgress('Decoding telemetry...', pct)
    }
  }

  if (allRecords.length === 0) return totalRecords

  // Phase 2: Build 10 Hz time grid with carry-forward interpolation.
  // Records are in chronological order. We walk the grid, absorbing
  // every record whose timestamp falls at or before each grid point.

  const lastTs = allRecords[allRecords.length - 1].timestamp
  if (lastTs <= 0) return totalRecords

  const numSteps = Math.floor(lastTs / INTERVAL_TICKS) + 1

  // Pre-build channel writers for all known channels
  const writerCache = new Map<number, { ch: MarlinChannel; writer: ReturnType<typeof getChannelWriter> }>()
  for (const [chId, ch] of channels) {
    const writer = getChannelWriter(ch.name)
    if (writer) {
      writerCache.set(chId, { ch, writer })
    }
  }

  // Walk the 10 Hz grid, applying records as we pass their timestamps
  const currentRaw = new Map<number, number>()
  let recIdx = 0

  onProgress?.('Resampling to 10 Hz...', 80)

  for (let step = 0; step < numSteps; step++) {
    const gridTs = step * INTERVAL_TICKS

    // Apply all records up to this grid point
    while (recIdx < allRecords.length && allRecords[recIdx].timestamp <= gridTs) {
      const rec = allRecords[recIdx]
      currentRaw.set(rec.channelId, rec.rawValue)
      recIdx++
    }

    // Ensure we don't exceed store capacity
    const idx = store.length
    if (idx >= store.time.length) break

    // Write time
    store.time[idx] = gridTs / TICKS_PER_SECOND
    store.packetIdx[idx] = step
    store.frameIdx[idx] = 0

    // Convert and write all current channel values
    for (const [chId, rawVal] of currentRaw) {
      const entry = writerCache.get(chId)
      if (entry) {
        const displayValue = convertRaw(rawVal, entry.ch)
        entry.writer!(store, idx, displayValue)
      }
    }

    store.length++

    if (onProgress && step % 2000 === 0) {
      const pct = 80 + Math.round((step / numSteps) * 15)
      onProgress('Resampling to 10 Hz...', pct)
    }
  }

  return totalRecords
}
