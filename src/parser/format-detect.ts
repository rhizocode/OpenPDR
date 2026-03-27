/**
 * OpenPDR — PDR Format Detection
 *
 * Detects the telemetry format (AliveDrive, Marlin, etc.) by inspecting
 * the handler type and codec in the MP4 moov box. Extensible via
 * FORMAT_REGISTRY — add an entry to support a new format.
 */

import { readBoxHeader, findAllBoxes } from './mp4-boxes'
import { readAscii, dataViewFor } from '../shared/binary-reader'
import type { TrackInfo, FormatDetection, FormatType } from './types'

interface FormatEntry {
  handlerType: string   // hdlr handler_type (e.g. 'adrv', 'ctbx')
  codecType: string     // stsd sample entry format (e.g. 'adco', 'marl')
  format: FormatType
  /** Require BOTH handler + codec to match within the same trak (default: false for backwards compat) */
  matchBoth?: boolean
}

/** Registry of known PDR formats. Add entries here for new formats. */
const FORMAT_REGISTRY: FormatEntry[] = [
  { handlerType: 'adrv', codecType: 'adco', format: 'alivedrive' },
  { handlerType: 'ctbx', codecType: 'marl', format: 'marlin' },
  { handlerType: 'meta', codecType: 'gpmd', format: 'gopro', matchBoth: true },
]

/**
 * Detect the PDR telemetry format from the moov box buffer.
 * Walks all trak boxes and checks hdlr handler_type and stsd codec
 * against the format registry.
 *
 * Returns the first match with its TrackInfo, or null if no known format found.
 */
export function detectFormat(moovBuf: Uint8Array): FormatDetection | null {
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
      const trakData = hdr.dataStart
      const trakEnd = Math.min(hdr.offset + hdr.size, moovEnd)
      const trackInfo: TrackInfo = {
        trakOffset: hdr.offset,
        trakSize: hdr.size,
        trakData,
        trakEnd,
      }

      // Extract handler type from hdlr box
      let handlerType: string | null = null
      const hdlrResults = findAllBoxes(moovBuf, 'hdlr', trakData, trakEnd, 0, 8, dv)
      for (const [hOff, hSize, hData] of hdlrResults) {
        if (hData + 12 <= hOff + hSize) {
          handlerType = readAscii(moovBuf, hData + 8, hData + 12)
          break
        }
      }

      // Extract codec type from stsd box
      let codecType: string | null = null
      const stsdResults = findAllBoxes(moovBuf, 'stsd', trakData, trakEnd, 0, 8, dv)
      for (const [sOff, sSize, sData] of stsdResults) {
        const entryStart = sData + 8 // skip version(4) + entry_count(4)
        if (entryStart + 8 <= sOff + sSize) {
          codecType = readAscii(moovBuf, entryStart + 4, entryStart + 8)
          break
        }
      }

      // Check each registry entry against this trak
      for (const entry of FORMAT_REGISTRY) {
        if (entry.matchBoth) {
          // Require BOTH handler and codec to match (e.g. GoPro: 'meta' is generic)
          if (handlerType === entry.handlerType && codecType === entry.codecType) {
            return { format: entry.format, trackInfo }
          }
        } else {
          // Legacy: either field match is sufficient
          if (handlerType === entry.handlerType || codecType === entry.codecType) {
            return { format: entry.format, trackInfo }
          }
        }
      }
    }

    pos += hdr.size
  }

  return null
}
