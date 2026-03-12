/**
 * OpenPDR — Marlin Track Discovery & Metadata Parsing
 *
 * Parses the marl stsd entry to extract the three proprietary sub-boxes:
 *   mrlh — version
 *   mrlv — recording metadata (tag/format/value triplets)
 *   mrld — channel dictionary (448-byte records)
 *
 * Ported from protocol/marlin_parser.py (parse_stsd_marlin, _parse_mrlh,
 * _parse_mrlv, _parse_mrld).
 */

import { findAllBoxes, readBoxHeader } from '../mp4-boxes'
import {
  readUint32BE, readInt32BE, readAscii, readDoubleBE,
  readBigUint64BE, dataViewFor,
} from '../../shared/binary-reader'
import type { MarlinChannel, MarlinMetadata } from '../types'

const utf8 = new TextDecoder('utf-8', { fatal: false })

/** Read a null-padded string field using UTF-8 (handles °, etc.). */
function readString(buf: Uint8Array, start: number, maxLen: number): string {
  let end = start
  while (end < start + maxLen && buf[end] !== 0) end++
  return utf8.decode(buf.subarray(start, end))
}

const MRLD_RECORD_SIZE = 448

/** Parsed result of the marl stsd entry sub-boxes. */
export interface MarlSubBoxes {
  version: number
  metadata: MarlinMetadata
  channels: Map<number, MarlinChannel>
}

/** Parse mrlh sub-box. Returns version number. */
function parseMrlh(data: Uint8Array, offset: number, size: number): number {
  if (size >= 4) {
    return readUint32BE(data, offset)
  }
  return 0
}

/** Parse mrlv metadata tag/format/value triplets. */
function parseMrlv(data: Uint8Array, offset: number, size: number): MarlinMetadata {
  const meta: MarlinMetadata = {
    recordingId: '', startDate: '', startTime: '', endTime: '', endDate: '',
    timezone: '', trackName: '', country: '', language: '',
    softwareVersion: '', unitSystem: '', recordingType: '',
    startTimestampTicks: 0,
  }

  const fmtSizes: Record<string, number> = {
    strs: 64, lang: 64, strl: 256, time: 32,
    date: 32, tmzn: 32, tstm: 8, focc: 4,
  }

  const end = offset + size
  let pos = offset

  while (pos + 8 <= end) {
    const tag = readAscii(data, pos, pos + 4)
    const fmt = readAscii(data, pos + 4, pos + 8)

    // kvp format (64-byte key + 256-byte value = 320 bytes)
    if (fmt.startsWith('kvp')) {
      pos += 8 + 320
      continue
    }

    const length = fmtSizes[fmt]
    if (length === undefined) break
    if (pos + 8 + length > end) break

    const valStart = pos + 8

    if (fmt === 'tstm' && length >= 8) {
      meta.startTimestampTicks = Number(readBigUint64BE(data, valStart))
    } else if (fmt === 'focc') {
      const text = readAscii(data, valStart, valStart + 4).replace(/\0/g, '')
      if (tag === 'rtyp') meta.recordingType = text
      else if (tag === 'unit') meta.unitSystem = text === 'usim' ? 'U.S. Imperial' : text
    } else {
      // String value — read until null terminator or length (UTF-8)
      const text = readString(data, valStart, length)

      switch (tag) {
        case 'id  ': meta.recordingId = text; break
        case 'time': meta.startTime = text; break
        case 'zone': meta.timezone = text; break
        case 'date': meta.startDate = text; break
        case 'lang': meta.language = text; break
        case 'ltim': meta.endTime = text; break
        case 'ldat': meta.endDate = text; break
        case 'trkn': meta.trackName = text; break
        case 'cntr': meta.country = text; break
        case 'swvs': meta.softwareVersion = text; break
      }
    }

    pos += 8 + length
  }

  return meta
}

/** Parse mrld channel dictionary — array of 448-byte records. */
function parseMrld(data: Uint8Array, offset: number, size: number): Map<number, MarlinChannel> {
  const channels = new Map<number, MarlinChannel>()
  const dv = dataViewFor(data)
  const end = offset + size
  let pos = offset

  while (pos + MRLD_RECORD_SIZE <= end) {
    const channelId = readUint32BE(data, pos, dv)
    const typeId = readUint32BE(data, pos + 4, dv)
    // num at pos+8 (channel ordinal, mirrors channelId — skip)

    // Units string: 64 bytes at offset 12 (UTF-8 for ° etc.)
    const units = readString(data, pos + 12, 64)

    // Flags at offset 76 (skip — always 7)
    const intervalTicks = Number(readBigUint64BE(data, pos + 80, dv))
    // min_raw at 88, max_raw at 92 (skip for channel mapping)
    // display_min at 96, display_max at 104 (skip)
    const multiplier = readDoubleBE(data, pos + 112, dv)
    const offset_ = readDoubleBE(data, pos + 120, dv)

    // Name: 64 bytes at offset 128
    const name = readString(data, pos + 128, 64)

    // Description: 64 bytes at offset 192
    const description = readString(data, pos + 192, 64)

    // Remaining 192 bytes (offset 256–447) are reserved

    channels.set(channelId, {
      channelId,
      typeId,
      units,
      intervalTicks,
      multiplier,
      offset: offset_,
      name,
      description,
    })

    pos += MRLD_RECORD_SIZE
  }

  return channels
}

/**
 * Parse the marl stsd entry and its sub-boxes (mrlh, mrlv, mrld).
 *
 * Navigates: trak → mdia → minf → stbl → stsd → marl entry → sub-boxes.
 */
export function parseMarlSubBoxes(
  moovBuf: Uint8Array,
  trakData: number,
  trakEnd: number,
): MarlSubBoxes {
  const dv = dataViewFor(moovBuf)
  const empty: MarlSubBoxes = {
    version: 0,
    metadata: {
      recordingId: '', startDate: '', startTime: '', endTime: '', endDate: '',
      timezone: '', trackName: '', country: '', language: '',
      softwareVersion: '', unitSystem: '', recordingType: '',
      startTimestampTicks: 0,
    },
    channels: new Map(),
  }

  // Find stsd box within the track
  const stsdResults = findAllBoxes(moovBuf, 'stsd', trakData, trakEnd, 0, 8, dv)
  if (stsdResults.length === 0) return empty

  const [stsdOff, stsdSize, stsdData] = stsdResults[0]
  const stsdEnd = stsdOff + stsdSize

  // stsd: version(1) + flags(3) + entry_count(4) = 8 bytes, then sample entries
  if (stsdData + 8 > stsdEnd) return empty

  // Read sample entry: size(4) + format(4)
  const entryStart = stsdData + 8
  if (entryStart + 8 > stsdEnd) return empty

  const entrySize = readUint32BE(moovBuf, entryStart, dv)
  const entryFormat = readAscii(moovBuf, entryStart + 4, entryStart + 8)

  if (entryFormat !== 'marl') return empty

  // Skip standard sample entry header: size(4) + format(4) + reserved(6) + data_ref_index(2) = 16 bytes
  const subBoxStart = entryStart + 16
  const entryEnd = entryStart + entrySize

  let version = 0
  let metadata = empty.metadata
  let channels = empty.channels

  // Parse sub-boxes within the marl entry
  let pos = subBoxStart
  while (pos + 8 <= entryEnd) {
    const subHdr = readBoxHeader(moovBuf, pos, entryEnd, dv)
    if (!subHdr || subHdr.size < 8) break

    const subType = subHdr.type
    const subDataStart = subHdr.dataStart
    const subDataSize = subHdr.size - subHdr.headerSize

    if (subType === 'mrlh') {
      version = parseMrlh(moovBuf, subDataStart, subDataSize)
    } else if (subType === 'mrlv') {
      metadata = parseMrlv(moovBuf, subDataStart, subDataSize)
    } else if (subType === 'mrld') {
      channels = parseMrld(moovBuf, subDataStart, subDataSize)
    }

    pos += subHdr.size
  }

  return { version, metadata, channels }
}
