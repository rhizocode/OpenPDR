/**
 * OpenPDR Telemetry Parser — MP4 Box Traversal Utilities
 * Ported from alivedrive_parser.py (read_box_header, find_box, etc.)
 */

import type { PdrFileSource } from '../shared/file-source'
import { readUint32BE, readBigUint64BE, readAscii, indexOf, asciiBytes, dataViewFor } from '../shared/binary-reader'
import type { BoxHeader, BoxResult } from './types'

const CONTAINER_TYPES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta'
])

/** Read an MP4 box header from a Uint8Array at the given offset. */
export function readBoxHeader(buf: Uint8Array, offset: number, end?: number, dv?: DataView): BoxHeader | null {
  const limit = end ?? buf.length
  if (offset + 8 > limit) return null

  let size = readUint32BE(buf, offset, dv)
  const type = readAscii(buf, offset + 4, offset + 8)
  let headerSize = 8

  if (size === 1) {
    // 64-bit extended size
    if (offset + 16 > limit) return null
    size = Number(readBigUint64BE(buf, offset + 8, dv))
    headerSize = 16
  } else if (size === 0) {
    // Box extends to end of container
    size = limit - offset
  }

  return { offset, size, type, headerSize, dataStart: offset + headerSize }
}

/** Find a box by type within [offset, end) in a buffer. */
export function findBox(buf: Uint8Array, boxType: string, offset = 0, end?: number, dv?: DataView): BoxResult | null {
  const limit = end ?? buf.length
  while (offset < limit - 8) {
    const hdr = readBoxHeader(buf, offset, limit, dv)
    if (!hdr || hdr.size < 8) break
    if (hdr.type === boxType) {
      return [hdr.offset, hdr.size, hdr.dataStart]
    }
    offset += hdr.size
  }
  return null
}

/** Find a nested box by slash-separated path like 'moov/trak/mdia'. */
export function findBoxPath(buf: Uint8Array, path: string): BoxResult | null {
  const parts = path.split('/')
  const dv = dataViewFor(buf)
  let offset = 0
  let end = buf.length

  for (let i = 0; i < parts.length; i++) {
    const result = findBox(buf, parts[i], offset, end, dv)
    if (!result) return null
    const [boxOffset, boxSize, dataStart] = result
    if (i < parts.length - 1) {
      offset = dataStart
      end = boxOffset + boxSize
    } else {
      return result
    }
  }
  return null
}

/** Check if 4 bytes at offset look like a valid MP4 box type (printable ASCII). */
function looksLikeBoxType(buf: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 4; i++) {
    const b = buf[offset + i]
    if (b < 0x20 || b > 0x7e) return false
  }
  return true
}

/** Brute-force scan for a box by its 4-byte type tag anywhere in the buffer. */
export function scanForBox(buf: Uint8Array, boxType: string, startOffset = 0): BoxResult | null {
  const tag = asciiBytes(boxType)
  const dv = dataViewFor(buf)
  let pos = startOffset
  while (true) {
    const idx = indexOf(buf, tag, pos)
    if (idx === -1 || idx < 4) return null
    const boxStart = idx - 4
    // Use readBoxHeader to handle both standard and extended (64-bit) box headers
    const hdr = readBoxHeader(buf, boxStart, undefined, dv)
    if (hdr && hdr.size > 8 && hdr.size < 100000 && boxStart + hdr.size <= buf.length) {
      const nextBox = boxStart + hdr.size
      // Accept if box reaches buffer end, or a plausible successor box follows
      if (nextBox + 8 > buf.length || looksLikeBoxType(buf, nextBox + 4)) {
        return [hdr.offset, hdr.size, hdr.dataStart]
      }
    }
    pos = idx + 4
  }
}

/** Recursively find ALL boxes of a given type within a range. */
export function findAllBoxes(
  buf: Uint8Array,
  boxType: string,
  offset = 0,
  end?: number,
  depth = 0,
  maxDepth = 8,
  dv?: DataView
): BoxResult[] {
  const limit = end ?? buf.length
  if (depth > maxDepth) return []

  const view = dv ?? dataViewFor(buf)
  const results: BoxResult[] = []
  let pos = offset

  while (pos < limit - 8) {
    const hdr = readBoxHeader(buf, pos, limit, view)
    if (!hdr || hdr.size < 8) break
    const boxEnd = Math.min(pos + hdr.size, limit)

    if (hdr.type === boxType) {
      results.push([hdr.offset, hdr.size, hdr.dataStart])
    }

    if (CONTAINER_TYPES.has(hdr.type)) {
      const children = findAllBoxes(buf, boxType, hdr.dataStart, boxEnd, depth + 1, maxDepth, view)
      results.push(...children)
    }

    pos = boxEnd
  }

  return results
}

/**
 * Read the moov box from an MP4 file.
 * Scans top-level boxes (skipping mdat) and reads only the moov box into memory.
 */
export async function readMoovBox(source: PdrFileSource): Promise<Uint8Array> {
  let offset = 0
  const fileSize = source.size

  let iterations = 0
  while (offset < fileSize && iterations++ < 10000) {
    const headerBuf = await source.read(offset, 16)
    if (headerBuf.length < 8) break

    let size = readUint32BE(headerBuf, 0)
    const type = readAscii(headerBuf, 4, 8)

    if (size === 1) {
      if (headerBuf.length < 16) break
      size = Number(readBigUint64BE(headerBuf, 8))
    } else if (size === 0) {
      size = fileSize - offset
    }

    if (size < 8) break
    // Overflow guard: if offset + size wraps or doesn't advance, stop
    if (offset + size <= offset) break

    if (type === 'moov') {
      const MAX_MOOV_SIZE = 50_000_000 // 50 MB — generous upper bound
      if (size > MAX_MOOV_SIZE) {
        throw new Error(`moov box too large: ${size} bytes (max ${MAX_MOOV_SIZE})`)
      }
      return source.read(offset, size)
    }

    offset += size
  }

  throw new Error('Could not find moov box in MP4 file')
}

/**
 * Parse the mvhd (Movie Header) box to extract the global timescale.
 * Returns the timescale (ticks per second), or 1000 as fallback.
 */
export function parseMvhdTimescale(moovBuf: Uint8Array): number {
  const moovHdr = readBoxHeader(moovBuf, 0)
  if (!moovHdr) return 1000
  const mvhd = findBox(moovBuf, 'mvhd', moovHdr.dataStart, moovBuf.length)
  if (!mvhd) return 1000
  const d = mvhd[2]
  const mvhdEnd = mvhd[0] + mvhd[1]
  const version = moovBuf[d]
  // timescale is at offset 12 (v0) or 20 (v1) from data start
  const tsOffset = version === 0 ? 12 : 20
  if (d + tsOffset + 4 > mvhdEnd) return 1000
  return readUint32BE(moovBuf, d + tsOffset)
}
