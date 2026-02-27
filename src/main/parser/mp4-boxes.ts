/**
 * OpenPDR Telemetry Parser — MP4 Box Traversal Utilities
 * Ported from alivedrive_parser.py (read_box_header, find_box, etc.)
 */

import type { FileHandle } from 'fs/promises'
import type { BoxHeader, BoxResult } from './types'

const CONTAINER_TYPES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta'
])

/** Read an MP4 box header from a Buffer at the given offset. */
export function readBoxHeader(buf: Buffer, offset: number, end?: number): BoxHeader | null {
  const limit = end ?? buf.length
  if (offset + 8 > limit) return null

  let size = buf.readUInt32BE(offset)
  const type = buf.toString('ascii', offset + 4, offset + 8)
  let headerSize = 8

  if (size === 1) {
    // 64-bit extended size
    if (offset + 16 > limit) return null
    size = Number(buf.readBigUInt64BE(offset + 8))
    headerSize = 16
  } else if (size === 0) {
    // Box extends to end of container
    size = limit - offset
  }

  return { offset, size, type, headerSize, dataStart: offset + headerSize }
}

/** Find a box by type within [offset, end) in a buffer. */
export function findBox(buf: Buffer, boxType: string, offset = 0, end?: number): BoxResult | null {
  const limit = end ?? buf.length
  while (offset < limit - 8) {
    const hdr = readBoxHeader(buf, offset, limit)
    if (!hdr || hdr.size < 8) break
    if (hdr.type === boxType) {
      return [hdr.offset, hdr.size, hdr.dataStart]
    }
    offset += hdr.size
  }
  return null
}

/** Find a nested box by slash-separated path like 'moov/trak/mdia'. */
export function findBoxPath(buf: Buffer, path: string): BoxResult | null {
  const parts = path.split('/')
  let offset = 0
  let end = buf.length

  for (let i = 0; i < parts.length; i++) {
    const result = findBox(buf, parts[i], offset, end)
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

/** Brute-force scan for a box by its 4-byte type tag anywhere in the buffer. */
export function scanForBox(buf: Buffer, boxType: string, startOffset = 0): BoxResult | null {
  const tag = Buffer.from(boxType, 'ascii')
  let pos = startOffset
  while (true) {
    const idx = buf.indexOf(tag, pos)
    if (idx === -1 || idx < 4) return null
    const size = buf.readUInt32BE(idx - 4)
    if (size > 8 && size < 100000) {
      return [idx - 4, size, idx + 4]
    }
    pos = idx + 4
  }
}

/** Recursively find ALL boxes of a given type within a range. */
export function findAllBoxes(
  buf: Buffer,
  boxType: string,
  offset = 0,
  end?: number,
  depth = 0,
  maxDepth = 8
): BoxResult[] {
  const limit = end ?? buf.length
  if (depth > maxDepth) return []

  const results: BoxResult[] = []
  let pos = offset

  while (pos < limit - 8) {
    const hdr = readBoxHeader(buf, pos, limit)
    if (!hdr || hdr.size < 8) break
    const boxEnd = pos + hdr.size

    if (hdr.type === boxType) {
      results.push([hdr.offset, hdr.size, hdr.dataStart])
    }

    if (CONTAINER_TYPES.has(hdr.type)) {
      const children = findAllBoxes(buf, boxType, hdr.dataStart, boxEnd, depth + 1, maxDepth)
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
export async function readMoovBox(fh: FileHandle, fileSize: number): Promise<Buffer> {
  let offset = 0
  const headerBuf = Buffer.alloc(16)

  while (offset < fileSize) {
    const { bytesRead } = await fh.read(headerBuf, 0, 16, offset)
    if (bytesRead < 8) break

    let size = headerBuf.readUInt32BE(0)
    const type = headerBuf.toString('ascii', 4, 8)

    if (size === 1) {
      if (bytesRead < 16) break
      size = Number(headerBuf.readBigUInt64BE(8))
    } else if (size === 0) {
      size = fileSize - offset
    }

    if (size < 8) break

    if (type === 'moov') {
      const moovBuf = Buffer.alloc(size)
      await fh.read(moovBuf, 0, size, offset)
      return moovBuf
    }

    offset += size
  }

  throw new Error('Could not find moov box in MP4 file')
}
