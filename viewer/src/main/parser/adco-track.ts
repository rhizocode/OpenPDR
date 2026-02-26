/**
 * OpenPDR Telemetry Parser — ADCO Track Discovery & Metadata Parsing
 * Ported from alivedrive_parser.py (find_adco_track, parse_advi, parse_adop, parse_adcr, parse_adeg)
 */

import { readBoxHeader, findBox, findAllBoxes, scanForBox } from './mp4-boxes'
import type { TrackInfo, RateGroup, AdviInfo, AdopProps } from './types'

/**
 * Find the AliveDrive data track (adrv handler / adco codec) in the moov buffer.
 * The moovBuf is expected to start with the moov box header.
 */
export function findAdcoTrack(moovBuf: Buffer): TrackInfo | null {
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
          const handlerType = moovBuf.toString('ascii', hData + 8, hData + 12)
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
            const codecType = moovBuf.toString('ascii', entryStart + 4, entryStart + 8)
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
 */
export function parseAdvi(data: Buffer): AdviInfo {
  const info: AdviInfo = { formatVersion: 0 }
  if (data.length < 24) return info

  info.formatVersion = data.readUInt16BE(0)

  // Find null-terminated source identifier string after 22 bytes of numeric header
  const strStart = 22
  if (strStart < data.length) {
    const end = data.indexOf(0, strStart)
    if (end !== -1) {
      info.source = data.toString('ascii', strStart, end)
    }
  }

  return info
}

/**
 * Parse outing properties from adop box data to get reference GPS location.
 * Searches for float64 pairs that look like US lat/lon coordinates.
 */
export function parseAdop(data: Buffer): AdopProps {
  const props: AdopProps = {}

  for (let i = 0; i <= data.length - 16; i++) {
    try {
      const val = data.readDoubleBE(i)
      if (val > 25.0 && val < 50.0) {
        const val2 = data.readDoubleBE(i + 8)
        if (val2 > -130.0 && val2 < -60.0) {
          props.lat = val
          props.lon = val2
          break
        }
      }
    } catch {
      // readDoubleBE can throw if offset is out of bounds
    }
  }

  return props
}

/**
 * Parse the rate table from the adcr box payload.
 * Version 1: first group uses 3 padding bytes, subsequent groups use 4.
 */
export function parseAdcr(data: Buffer): RateGroup[] {
  if (data.length < 4) return []

  const version = data[0]
  const numGroups = data[2]
  let offset = 4

  const groups: RateGroup[] = []
  for (let g = 0; g < numGroups; g++) {
    const padSize = g === 0 ? 3 : 4
    offset += padSize

    if (offset + 6 > data.length) break

    const period = data.readUInt32BE(offset)
    offset += 4
    const numChannels = data.readUInt16BE(offset)
    offset += 2

    const channels: Array<{ channelId: number; width: number }> = []
    for (let c = 0; c < numChannels; c++) {
      if (offset + 3 > data.length) break
      const channelId = data.readUInt16BE(offset)
      offset += 2
      const width = data[offset]
      offset += 1
      channels.push({ channelId, width })
    }

    groups.push({
      period,
      numChannels,
      channels,
      totalWidth: channels.reduce((sum, ch) => sum + ch.width, 0),
    })
  }

  return groups
}

/**
 * Parse event definitions from adeg box data.
 * Returns a list of { eventId, name } objects.
 */
export function parseAdeg(data: Buffer): Array<{ eventId: number; name: string }> {
  const events: Array<{ eventId: number; name: string }> = []
  let pos = 0

  while (pos < data.length - 2) {
    const eventId = data.readUInt16BE(pos)
    pos += 2
    const end = data.indexOf(0, pos)
    if (end === -1) break
    const name = data.toString('ascii', pos, end)
    pos = end + 1
    events.push({ eventId, name })
  }

  return events
}
