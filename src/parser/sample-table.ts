/**
 * OpenPDR Telemetry Parser — Sample Table Parsing
 * Ported from alivedrive_parser.py (parse_sample_table, get_sample_offsets)
 */

import { findBox } from './mp4-boxes'
import { readUint32BE, readBigUint64BE, dataViewFor } from '../shared/binary-reader'
import type { SampleTable } from './types'

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

  const stszData = stsz[2]
  // stsz: version(4) + sample_size(4) + count(4) + [sizes...]
  const defaultSize = readUint32BE(moovBuf, stszData + 4, dv)
  const sampleCount = readUint32BE(moovBuf, stszData + 8, dv)

  let sampleSizes: number[]
  if (defaultSize !== 0) {
    sampleSizes = new Array(sampleCount).fill(defaultSize)
  } else {
    sampleSizes = []
    for (let i = 0; i < sampleCount; i++) {
      sampleSizes.push(readUint32BE(moovBuf, stszData + 12 + i * 4, dv))
    }
  }

  // ── Parse stco or co64 (chunk offsets) ──
  const stco = findBox(moovBuf, 'stco', stblData, stblEnd)
  const co64 = findBox(moovBuf, 'co64', stblData, stblEnd)

  const chunkOffsets: number[] = []
  if (co64) {
    const coData = co64[2]
    const coCount = readUint32BE(moovBuf, coData + 4, dv)
    for (let i = 0; i < coCount; i++) {
      chunkOffsets.push(Number(readBigUint64BE(moovBuf, coData + 8 + i * 8, dv)))
    }
  } else if (stco) {
    const coData = stco[2]
    const coCount = readUint32BE(moovBuf, coData + 4, dv)
    for (let i = 0; i < coCount; i++) {
      chunkOffsets.push(readUint32BE(moovBuf, coData + 8 + i * 4, dv))
    }
  }

  // ── Parse stsc (sample-to-chunk) ──
  const stsc = findBox(moovBuf, 'stsc', stblData, stblEnd)
  const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number; descriptionIndex: number }> = []
  if (stsc) {
    const stscData = stsc[2]
    const stscCount = readUint32BE(moovBuf, stscData + 4, dv)
    for (let i = 0; i < stscCount; i++) {
      const base = stscData + 8 + i * 12
      stscEntries.push({
        firstChunk: readUint32BE(moovBuf, base, dv),
        samplesPerChunk: readUint32BE(moovBuf, base + 4, dv),
        descriptionIndex: readUint32BE(moovBuf, base + 8, dv),
      })
    }
  }

  return { sampleSizes, chunkOffsets, stscEntries, sampleCount }
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

  return offsets
}
