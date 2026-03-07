/**
 * OpenPDR Telemetry Parser — Sample Table Parsing
 * Parses stsz, stco/co64, stsc, stts, mdhd, and edts/elst boxes
 * to compute sample file offsets and presentation times.
 */

import { findBox } from './mp4-boxes'
import { readUint32BE, readInt32BE, readBigUint64BE, dataViewFor } from '../shared/binary-reader'
import type { SampleTable, TrackTiming, SttsEntry } from './types'

/** Maximum allowed sample size (1 MB). Telemetry packets are ~3-4 KB;
 *  anything larger is either corrupt or crafted to cause OOM. */
const MAX_SAMPLE_SIZE = 1_048_576

/**
 * Parse the sample table (stsz, stco/co64, stsc) from within a trak box.
 * All offsets are relative to moovBuf.
 */
export function parseSampleTable(
  moovBuf: Uint8Array,
  trakData: number,
  trakEnd: number
): SampleTable | null {
  // Find stbl (sample table box)
  let stbl = findBox(moovBuf, 'stbl', trakData, trakEnd)
  if (!stbl) {
    // Try deeper path: mdia/minf/stbl
    const mdia = findBox(moovBuf, 'mdia', trakData, trakEnd)
    if (mdia) {
      const minf = findBox(moovBuf, 'minf', mdia[2], mdia[0] + mdia[1])
      if (minf) {
        stbl = findBox(moovBuf, 'stbl', minf[2], minf[0] + minf[1])
      }
    }
  }

  if (!stbl) return null

  const [stblOffset, stblSize, stblData] = stbl
  const stblEnd = stblOffset + stblSize
  const dv = dataViewFor(moovBuf)

  // ── Parse stsz (sample sizes) ──
  const stsz = findBox(moovBuf, 'stsz', stblData, stblEnd)
  if (!stsz) return null

  const [stszOffset, stszSize, stszData] = stsz
  const stszEnd = Math.min(stszOffset + stszSize, moovBuf.length)
  // stsz: version(4) + sample_size(4) + count(4) + [sizes...]
  if (stszData + 12 > stszEnd) return null
  const defaultSize = readUint32BE(moovBuf, stszData + 4, dv)
  const sampleCount = readUint32BE(moovBuf, stszData + 8, dv)

  let sampleSizes: number[]
  if (defaultSize !== 0) {
    sampleSizes = new Array(sampleCount).fill(Math.min(defaultSize, MAX_SAMPLE_SIZE))
  } else {
    const maxSizes = Math.floor((stszEnd - (stszData + 12)) / 4)
    const safeCount = Math.min(sampleCount, maxSizes)
    sampleSizes = []
    for (let i = 0; i < safeCount; i++) {
      const sz = readUint32BE(moovBuf, stszData + 12 + i * 4, dv)
      sampleSizes.push(Math.min(sz, MAX_SAMPLE_SIZE))
    }
  }

  // ── Parse stco or co64 (chunk offsets) ──
  const stco = findBox(moovBuf, 'stco', stblData, stblEnd)
  const co64 = findBox(moovBuf, 'co64', stblData, stblEnd)

  const chunkOffsets: number[] = []
  if (co64) {
    const [co64Offset, co64Size, coData] = co64
    const co64End = Math.min(co64Offset + co64Size, moovBuf.length)
    if (coData + 8 <= co64End) {
      const coCount = readUint32BE(moovBuf, coData + 4, dv)
      const maxEntries = Math.floor((co64End - (coData + 8)) / 8)
      const safeCount = Math.min(coCount, maxEntries)
      for (let i = 0; i < safeCount; i++) {
        const off = Number(readBigUint64BE(moovBuf, coData + 8 + i * 8, dv))
        if (!Number.isSafeInteger(off)) continue
        chunkOffsets.push(off)
      }
    }
  } else if (stco) {
    const [stcoOffset, stcoSize, coData] = stco
    const stcoEnd = Math.min(stcoOffset + stcoSize, moovBuf.length)
    if (coData + 8 <= stcoEnd) {
      const coCount = readUint32BE(moovBuf, coData + 4, dv)
      const maxEntries = Math.floor((stcoEnd - (coData + 8)) / 4)
      const safeCount = Math.min(coCount, maxEntries)
      for (let i = 0; i < safeCount; i++) {
        chunkOffsets.push(readUint32BE(moovBuf, coData + 8 + i * 4, dv))
      }
    }
  }

  // ── Parse stsc (sample-to-chunk) ──
  const stsc = findBox(moovBuf, 'stsc', stblData, stblEnd)
  const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number; descriptionIndex: number }> = []
  if (stsc) {
    const [stscOffset, stscSize, stscData] = stsc
    const stscEnd = Math.min(stscOffset + stscSize, moovBuf.length)
    if (stscData + 8 <= stscEnd) {
      const stscCount = readUint32BE(moovBuf, stscData + 4, dv)
      const maxEntries = Math.floor((stscEnd - (stscData + 8)) / 12)
      const safeCount = Math.min(stscCount, maxEntries)
      for (let i = 0; i < safeCount; i++) {
        const base = stscData + 8 + i * 12
        stscEntries.push({
          firstChunk: readUint32BE(moovBuf, base, dv),
          samplesPerChunk: readUint32BE(moovBuf, base + 4, dv),
          descriptionIndex: readUint32BE(moovBuf, base + 8, dv),
        })
      }
    }
  }

  return { sampleSizes, chunkOffsets, stscEntries, sampleCount: sampleSizes.length }
}

/**
 * Compute absolute file offset for each sample.
 * Uses stsc entries to determine how many samples per chunk,
 * then accumulates sizes within each chunk.
 */
export function getSampleOffsets(table: SampleTable): number[] {
  const offsets: number[] = []
  const { stscEntries, chunkOffsets, sampleSizes } = table

  let sampleIdx = 0
  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
    const chunkNum = chunkIdx + 1 // 1-based

    // Find applicable stsc entry
    let samplesPerChunk = 1
    for (const entry of stscEntries) {
      if (entry.firstChunk <= chunkNum) {
        samplesPerChunk = entry.samplesPerChunk
      } else {
        break
      }
    }

    let offset = chunkOffsets[chunkIdx]
    for (let s = 0; s < samplesPerChunk; s++) {
      if (sampleIdx >= sampleSizes.length) break
      offsets.push(offset)
      offset += sampleSizes[sampleIdx]
      sampleIdx++
    }
  }

  if (offsets.length < table.sampleCount) {
    console.warn(`getSampleOffsets: produced ${offsets.length} offsets but sampleCount is ${table.sampleCount} (truncated sample table?)`)
  }

  return offsets
}

/**
 * Parse track timing metadata (mdhd timescale, stts sample durations,
 * edts/elst delay) and compute per-sample presentation times in seconds.
 *
 * moovBuf contains the full moov box; trakData/trakEnd delimit the trak.
 * mvhdTimescale is needed to convert elst segment_duration to seconds.
 */
export function parseTrackTiming(
  moovBuf: Uint8Array,
  trakData: number,
  trakEnd: number,
  mvhdTimescale: number,
  sampleCount: number,
): TrackTiming | null {
  const dv = dataViewFor(moovBuf)

  // Find mdia box
  const mdia = findBox(moovBuf, 'mdia', trakData, trakEnd)
  if (!mdia) return null
  const mdiaEnd = mdia[0] + mdia[1]

  // -- mdhd (media header) --
  const mdhd = findBox(moovBuf, 'mdhd', mdia[2], mdiaEnd)
  if (!mdhd) return null
  const mdhdData = mdhd[2]
  const version = moovBuf[mdhdData]
  let timescale: number
  let duration: number
  if (version === 0) {
    timescale = readUint32BE(moovBuf, mdhdData + 12, dv)
    duration = readUint32BE(moovBuf, mdhdData + 16, dv)
  } else {
    timescale = readUint32BE(moovBuf, mdhdData + 20, dv)
    duration = Number(readBigUint64BE(moovBuf, mdhdData + 24, dv))
  }

  // -- stts (decoding time to sample) --
  const minf = findBox(moovBuf, 'minf', mdia[2], mdiaEnd)
  if (!minf) return null
  const stbl = findBox(moovBuf, 'stbl', minf[2], minf[0] + minf[1])
  if (!stbl) return null
  const stblEnd = stbl[0] + stbl[1]

  const stts = findBox(moovBuf, 'stts', stbl[2], stblEnd)
  if (!stts) return null
  const sttsData = stts[2]
  const entryCount = readUint32BE(moovBuf, sttsData + 4, dv)
  const sttsEntries: SttsEntry[] = []
  const sttsEnd = stts[0] + stts[1]
  const sttsMaxEntries = Math.floor((sttsEnd - (sttsData + 8)) / 8)
  const sttsCount = Math.min(entryCount, sttsMaxEntries)
  let pos = sttsData + 8
  for (let i = 0; i < sttsCount; i++) {
    sttsEntries.push({
      count: readUint32BE(moovBuf, pos, dv),
      delta: readUint32BE(moovBuf, pos + 4, dv),
    })
    pos += 8
  }

  // -- edts/elst (edit list) --
  let elstDelay = 0
  const edts = findBox(moovBuf, 'edts', trakData, trakEnd)
  if (edts) {
    const elst = findBox(moovBuf, 'elst', edts[2], edts[0] + edts[1])
    if (elst) {
      const elstData = elst[2]
      const elstVersion = moovBuf[elstData]
      const elstCount = readUint32BE(moovBuf, elstData + 4, dv)
      const elstEnd = elst[0] + elst[1]
      let epos = elstData + 8
      const elstEntrySize = moovBuf[elstData] === 0 ? 12 : 20
      const elstMaxEntries = Math.floor((elstEnd - epos) / elstEntrySize)
      const safeElstCount = Math.min(elstCount, elstMaxEntries)
      for (let i = 0; i < safeElstCount; i++) {
        let segDuration: number
        let mediaTime: number
        if (elstVersion === 0) {
          segDuration = readUint32BE(moovBuf, epos, dv)
          mediaTime = readInt32BE(moovBuf, epos + 4, dv)
          epos += 12 // + 4 for media_rate
        } else {
          segDuration = Number(readBigUint64BE(moovBuf, epos, dv))
          // Read i64 as two i32s (JS BigInt would work but adds complexity)
          const hi = readInt32BE(moovBuf, epos + 8, dv)
          const lo = readUint32BE(moovBuf, epos + 12, dv)
          mediaTime = hi * 0x100000000 + lo
          epos += 20 // + 4 for media_rate
        }
        if (mediaTime === -1 && mvhdTimescale > 0) {
          // Empty edit = delay before media starts
          elstDelay += segDuration / mvhdTimescale
        }
      }
    }
  }

  // -- Build per-sample presentation times --
  const sampleTimes = new Float64Array(sampleCount)
  let sampleIdx = 0
  let cumulativeTime = elstDelay
  for (const entry of sttsEntries) {
    const deltaSec = entry.delta / timescale
    for (let j = 0; j < entry.count && sampleIdx < sampleCount; j++) {
      sampleTimes[sampleIdx] = cumulativeTime
      cumulativeTime += deltaSec
      sampleIdx++
    }
  }
  // Fill any remaining samples (shouldn't happen, but be safe)
  while (sampleIdx < sampleCount) {
    sampleTimes[sampleIdx] = cumulativeTime
    cumulativeTime += 1.0 // fallback: assume 1 second
    sampleIdx++
  }

  return { timescale, duration, sttsEntries, elstDelay, sampleTimes }
}
