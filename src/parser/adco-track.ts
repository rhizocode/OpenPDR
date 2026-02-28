/**
 * OpenPDR Telemetry Parser — ADCO Track Discovery & Metadata Parsing
 * Ported from alivedrive_parser.py (find_adco_track, parse_advi, parse_adop, parse_adeg)
 */

import { readBoxHeader, findAllBoxes } from './mp4-boxes'
import { readUint16BE, readAscii, indexOf, readDoubleBE, dataViewFor } from '../shared/binary-reader'
import type { TrackInfo, AdviInfo, AdopProps } from './types'

/**
 * Find the AliveDrive data track (adrv handler / adco codec) in the moov buffer.
 * The moovBuf is expected to start with the moov box header.
 */
export function findAdcoTrack(moovBuf: Uint8Array): TrackInfo | null {
  const dv = dataViewFor(moovBuf)
  const moovHdr = readBoxHeader(moovBuf, 0, undefined, dv)
  if (!moovHdr) return null
  const moovData = moovHdr.dataStart
  const moovEnd = moovHdr.size

  let pos = moovData
  while (pos < moovEnd - 8) {
    const hdr = readBoxHeader(moovBuf, pos, moovEnd, dv)
    if (!hdr || hdr.size < 8) break

    if (hdr.type === 'trak') {
      const trakOffset = hdr.offset
      const trakSize = hdr.size
      const trakData = hdr.dataStart
      const trakEnd = trakOffset + trakSize

      // Search for hdlr with handler_type "adrv"
      const hdlrResults = findAllBoxes(moovBuf, 'hdlr', trakData, trakEnd, 0, 8, dv)
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
      const stsdResults = findAllBoxes(moovBuf, 'stsd', trakData, trakEnd, 0, 8, dv)
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

  const dv = dataViewFor(data)
  info.formatVersion = readUint16BE(data, 0, dv)
  info.generation = readUint16BE(data, 4, dv)
  info.mmpVersion = readUint16BE(data, 6, dv)

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
 * Parse outing properties from adop box data.
 *
 * The adop box stores key-value pairs in this format:
 *   <null-terminated key> <4-byte type tag> <value>
 *
 * Type tags:
 *   strn — null-terminated string value
 *   vrsn — version (2-byte u16 major, 2-byte u16 minor)
 *   siva — float32 BE value
 *   dtim — null-terminated ISO 8601 datetime string
 *   guid — 16-byte UUID
 *
 * Also extracts reference GPS location from the location properties.
 */
export function parseAdop(data: Uint8Array): AdopProps {
  const props: AdopProps = { properties: new Map() }
  const dv = dataViewFor(data)
  let pos = 0

  while (pos < data.length) {
    // Read null-terminated key string
    const keyEnd = indexOf(data, 0, pos)
    if (keyEnd === -1 || keyEnd === pos) break
    const key = readAscii(data, pos, keyEnd)
    pos = keyEnd + 1

    // Read 4-byte type tag
    if (pos + 4 > data.length) break
    const tag = readAscii(data, pos, pos + 4)
    pos += 4

    // Decode value based on type tag
    const shortKey = key.replace(/^com\.cosworth\.outingproperty\./, '')

    if (tag === 'strn') {
      const valEnd = indexOf(data, 0, pos)
      if (valEnd === -1) break
      props.properties.set(shortKey, readAscii(data, pos, valEnd))
      pos = valEnd + 1
    } else if (tag === 'dtim') {
      // Fixed 25-byte ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SS+HH:MM), not null-terminated
      if (pos + 25 > data.length) break
      props.properties.set(shortKey, readAscii(data, pos, pos + 25))
      pos += 25
    } else if (tag === 'vrsn') {
      // 6 bytes: u16 major + u16 minor + u16 patch
      if (pos + 6 > data.length) break
      const major = readUint16BE(data, pos, dv)
      const minor = readUint16BE(data, pos + 2, dv)
      const patch = readUint16BE(data, pos + 4, dv)
      pos += 6
      props.properties.set(shortKey, patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`)
    } else if (tag === 'siva') {
      // 3-byte prefix: u8 reserved(0) + u8 unit_id + u8 value_type
      // Value types: 0x04=u16(2 bytes), 0x09=f32(4 bytes), 0x0a=f64(8 bytes)
      if (pos + 3 > data.length) break
      const valType = data[pos + 2]
      pos += 3
      const valSize = valType === 0x04 ? 2 : valType === 0x09 ? 4 : valType === 0x0a ? 8 : -1
      if (valSize === -1 || pos + valSize > data.length) break
      let value: number
      if (valType === 0x04) {
        value = readUint16BE(data, pos, dv)
      } else if (valType === 0x09) {
        value = dv.getFloat32(pos, false)
      } else {
        value = dv.getFloat64(pos, false)
      }
      pos += valSize
      props.properties.set(shortKey, value.toString())
    } else if (tag === 'guid') {
      if (pos + 16 > data.length) break
      pos += 16 // skip UUID, not useful for display
    } else {
      // Unknown tag — stop parsing to avoid corruption
      break
    }
  }

  // Extract GPS reference from location properties (stored as radians, convert to degrees)
  const RAD_TO_DEG = 180 / Math.PI
  const latStr = props.properties.get('location.center.latitude')
    ?? props.properties.get('location.starting.latitude')
  const lonStr = props.properties.get('location.center.longitude')
    ?? props.properties.get('location.starting.longitude')
  if (latStr && lonStr) {
    const latRad = parseFloat(latStr)
    const lonRad = parseFloat(lonStr)
    const lat = latRad * RAD_TO_DEG
    const lon = lonRad * RAD_TO_DEG
    if (Math.abs(lat) > 1 && Math.abs(lat) < 85 && Math.abs(lon) > 1 && Math.abs(lon) < 180) {
      props.lat = lat
      props.lon = lon
    }
  }

  // Fallback: heuristic float64 search if structured parsing didn't find GPS
  if (props.lat === undefined) {
    for (let i = 0; i <= data.length - 16; i++) {
      const val = readDoubleBE(data, i, dv)
      if (Math.abs(val) > 1.0 && Math.abs(val) < 85.0) {
        const val2 = readDoubleBE(data, i + 8, dv)
        if (Math.abs(val2) > 1.0 && Math.abs(val2) < 180.0) {
          props.lat = val
          props.lon = val2
          break
        }
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
