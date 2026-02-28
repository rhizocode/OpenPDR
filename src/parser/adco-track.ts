/**
 * OpenPDR Telemetry Parser — ADCO Track Discovery & Metadata Parsing
 * Ported from alivedrive_parser.py (find_adco_track, parse_advi, parse_adop, parse_adeg)
 */

import { readBoxHeader, findAllBoxes } from './mp4-boxes'
import { readUint16BE, readAscii, indexOf, readDoubleBE } from '../shared/binary-reader'
import type { TrackInfo, AdviInfo, AdopProps } from './types'

/**
 * Find the AliveDrive data track (adrv handler / adco codec) in the moov buffer.
 * The moovBuf is expected to start with the moov box header.
 */
export function findAdcoTrack(moovBuf: Uint8Array): TrackInfo | null {
  const moovHdr = readBoxHeader(moovBuf, 0)
  if (!moovHdr) return null
  const moovData = moovHdr.dataStart
  const moovEnd = moovHdr.size

  let pos = moovData
  while (pos < moovEnd - 8) {
    const hdr = readBoxHeader(moovBuf, pos, moovEnd)
    if (!hdr || hdr.size < 8) break

    if (hdr.type === 'trak') {
      const trakOffset = hdr.offset
      const trakSize = hdr.size
      const trakData = hdr.dataStart
      const trakEnd = trakOffset + trakSize

      // Search for hdlr with handler_type "adrv"
      const hdlrResults = findAllBoxes(moovBuf, 'hdlr', trakData, trakEnd)
      for (const [hOff, hSize, hData] of hdlrResults) {
        if (hData + 12 <= hOff + hSize) {
          // hdlr box: version(4) + predefined(4) + handler_type(4)
          const handlerType = readAscii(moovBuf, hData + 8, hData + 12)
          if (handlerType === 'adrv') {
            return { trakOffset, trakSize, trakData, trakEnd }
          }
        }
      }

      // Also check for 'adco' codec in stsd
      const stsdResults = findAllBoxes(moovBuf, 'stsd', trakData, trakEnd)
      for (const [sOff, sSize, sData] of stsdResults) {
        if (sData + 16 <= sOff + sSize) {
          const entryStart = sData + 8 // skip version + count
          if (entryStart + 8 <= sOff + sSize) {
            const codecType = readAscii(moovBuf, entryStart + 4, entryStart + 8)
            if (codecType === 'adco') {
              return { trakOffset, trakSize, trakData, trakEnd }
            }
          }
        }
      }
    }

    pos += hdr.size
  }

  return null
}

/**
 * Parse version info from advi box data (payload after box header).
 *
 * Key fields:
 *   [0:2]  formatVersion (u16 BE)
 *   [4:6]  generation (u16 BE) — 1=gen1, 2=gen2
 *   [6:8]  mmpVersion (u16 BE) — MMP firmware version
 *          MMP ≤ 3: 17-byte 100Hz frames (u16 wheel speeds)
 *          MMP ≥ 4: 25-byte 100Hz frames (float32 wheel speeds)
 *   [22:]  null-terminated source identifier string
 */
export function parseAdvi(data: Uint8Array): AdviInfo {
  const info: AdviInfo = { formatVersion: 0 }
  if (data.length < 24) return info

  info.formatVersion = readUint16BE(data, 0)
  info.generation = readUint16BE(data, 4)
  info.mmpVersion = readUint16BE(data, 6)

  // Find null-terminated source identifier string after 22 bytes of numeric header
  const strStart = 22
  if (strStart < data.length) {
    const end = indexOf(data, 0, strStart)
    if (end !== -1) {
      info.source = readAscii(data, strStart, end)
    }
  }

  return info
}

/**
 * Parse outing properties from adop box data to get reference GPS location.
 * Searches for float64 pairs that look like plausible lat/lon coordinates.
 */
export function parseAdop(data: Uint8Array): AdopProps {
  const props: AdopProps = {}

  for (let i = 0; i <= data.length - 16; i++) {
    if (i + 16 > data.length) break
    const val = readDoubleBE(data, i)
    if (Math.abs(val) > 1.0 && Math.abs(val) < 85.0) {
      const val2 = readDoubleBE(data, i + 8)
      if (Math.abs(val2) > 1.0 && Math.abs(val2) < 180.0) {
        props.lat = val
        props.lon = val2
        break
      }
    }
  }

  return props
}

/**
 * Parse event definitions from adeg box data.
 * Returns a list of { eventId, name } objects.
 */
export function parseAdeg(data: Uint8Array): Array<{ eventId: number; name: string }> {
  const events: Array<{ eventId: number; name: string }> = []
  let pos = 0

  while (pos < data.length - 2) {
    const eventId = readUint16BE(data, pos)
    pos += 2
    const end = indexOf(data, 0, pos)
    if (end === -1) break
    const name = readAscii(data, pos, end)
    pos = end + 1
    events.push({ eventId, name })
  }

  return events
}
