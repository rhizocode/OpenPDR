/**
 * OpenPDR — GoPro GPMF Binary Decoder
 *
 * Parses the GoPro Metadata Format (GPMF) KLV telemetry stream embedded
 * in GoPro MP4 files. Each MP4 sample contains ~1 second of GPMF data
 * structured as nested KLV (Key-Length-Value) entries.
 *
 * KLV entry layout (8+ bytes):
 *   Bytes 0-3: FourCC key (ASCII)
 *   Byte 4:    type char (0x00 = container, 's' = int16, 'l' = int32, 'f' = float32, etc.)
 *   Byte 5:    struct size (bytes per element)
 *   Bytes 6-7: repeat count (big-endian uint16)
 *   Bytes 8+:  payload, padded to 4-byte alignment
 *
 * Reference: https://github.com/gopro/gpmf-parser
 */

import {
  readAscii,
  readInt16BE,
  readInt32BE,
  readUint16BE,
  readFloatBE,
  dataViewFor,
} from '../../shared/binary-reader'

/** A single GPMF data stream extracted from a STRM container. */
export interface GpmfStream {
  /** FourCC key identifying the data (e.g. 'GPS5', 'ACCL', 'GYRO') */
  fourcc: string
  /** Type byte (0x00 = container, 's' = int16, 'l' = int32, 'f' = float32, etc.) */
  type: number
  /** Size of each struct element in bytes */
  structSize: number
  /** Number of repeats (rows of data) */
  repeat: number
  /** Raw payload bytes */
  data: Uint8Array
  /** Stream name from STNM */
  name?: string
  /** SI unit string from SIUN */
  units?: string
  /** Scale divisors from SCAL (one per component) */
  scale?: number[]
}

/** Parsed result from one GPMF sample (~1 second of data). */
export interface GpmfPayload {
  /** All data streams found in this sample */
  streams: GpmfStream[]
  /** UTC timestamp string from GPSU (format: YYMMDDHHMMSS.SSS) */
  gpsu?: string
  /** GPS fix type from GPSF (0 = no fix, 2 = 2D, 3 = 3D) */
  gpsf?: number
  /** GPS dilution of precision × 100 from GPSP */
  gpsp?: number
  /** Device name from DVNM */
  dvnm?: string
}

/** GPMF type codes */
const TYPE_CONTAINER = 0x00
const TYPE_INT16 = 0x73     // 's'
const TYPE_UINT16 = 0x53    // 'S'
const TYPE_INT32 = 0x6C     // 'l'
const TYPE_UINT32 = 0x4C    // 'L'
const TYPE_FLOAT32 = 0x66   // 'f'
const TYPE_FOURCC = 0x46    // 'F'
const TYPE_STRING = 0x63    // 'c'
const TYPE_UTC = 0x55       // 'U'

/**
 * Read a SCAL (scale) KLV value. Returns an array of divisors.
 * SCAL can be a single value (applied to all components) or one per component.
 */
function readScal(data: Uint8Array, type: number, structSize: number, repeat: number, dv: DataView): number[] {
  const scales: number[] = []
  if (type === TYPE_INT16) {
    for (let i = 0; i < repeat; i++) {
      scales.push(readInt16BE(data, i * 2, dv))
    }
  } else if (type === TYPE_INT32) {
    for (let i = 0; i < repeat; i++) {
      scales.push(readInt32BE(data, i * 4, dv))
    }
  } else if (type === TYPE_FLOAT32) {
    for (let i = 0; i < repeat; i++) {
      scales.push(readFloatBE(data, i * 4, dv))
    }
  } else {
    // Fallback: single scale of 1
    scales.push(1)
  }
  return scales
}

/**
 * Parse one GPMF sample (typically ~1 second of telemetry data).
 *
 * Walks the KLV tree recursively. Container entries (type=0x00) like DEVC
 * and STRM are descended into. Sticky metadata (STNM, SIUN, SCAL) within
 * a STRM is attached to subsequent data KLVs in that stream.
 */
export function parseGpmfPayload(data: Uint8Array): GpmfPayload {
  const result: GpmfPayload = { streams: [] }
  parseKlvLevel(data, 0, data.length, result, null)
  return result
}

/** Context tracked within a STRM container for sticky metadata. */
interface StrmContext {
  name?: string
  units?: string
  scale?: number[]
}

function parseKlvLevel(
  data: Uint8Array,
  start: number,
  end: number,
  result: GpmfPayload,
  strmCtx: StrmContext | null,
): void {
  let pos = start
  // Use a DataView over the full buffer for efficient reads
  const dv = dataViewFor(data)

  while (pos + 8 <= end) {
    // Read KLV header
    const fourcc = readAscii(data, pos, pos + 4)
    const type = data[pos + 4]
    const structSize = data[pos + 5]
    const repeat = readUint16BE(data, pos + 6, dv)

    const payloadSize = structSize * repeat
    const paddedSize = (payloadSize + 3) & ~3  // pad to 4-byte alignment
    const payloadStart = pos + 8
    const payloadEnd = Math.min(payloadStart + payloadSize, end)

    if (payloadStart + paddedSize > end + 4) {
      // Malformed — stop parsing this level
      break
    }

    if (type === TYPE_CONTAINER) {
      // Container: recurse
      if (fourcc === 'STRM') {
        // New stream — fresh sticky context
        const ctx: StrmContext = {}
        parseKlvLevel(data, payloadStart, payloadEnd, result, ctx)
      } else {
        // DEVC or other container — pass through current context
        parseKlvLevel(data, payloadStart, payloadEnd, result, strmCtx)
      }
    } else if (strmCtx !== null) {
      // Inside a STRM container — handle sticky metadata and data
      if (fourcc === 'STNM' && (type === TYPE_STRING || type === TYPE_UTC)) {
        strmCtx.name = readNullTermString(data, payloadStart, payloadEnd)
      } else if (fourcc === 'SIUN' && type === TYPE_STRING) {
        strmCtx.units = readNullTermString(data, payloadStart, payloadEnd)
      } else if (fourcc === 'SCAL') {
        const scalData = data.subarray(payloadStart, payloadEnd)
        const scalDv = dataViewFor(scalData)
        strmCtx.scale = readScal(scalData, type, structSize, repeat, scalDv)
      } else if (fourcc === 'GPSU' && type === TYPE_UTC) {
        result.gpsu = readNullTermString(data, payloadStart, payloadEnd)
      } else if (fourcc === 'GPSF' && (type === TYPE_INT32 || type === TYPE_UINT32) && payloadSize >= 4) {
        result.gpsf = readInt32BE(data, payloadStart, dv)
      } else if (fourcc === 'GPSP' && type === TYPE_UINT16 && payloadSize >= 2) {
        result.gpsp = readUint16BE(data, payloadStart, dv)
      } else if (fourcc === 'DVNM' && type === TYPE_STRING) {
        result.dvnm = readNullTermString(data, payloadStart, payloadEnd)
      } else if (isDataStream(fourcc)) {
        // Actual telemetry data stream
        result.streams.push({
          fourcc,
          type,
          structSize,
          repeat,
          data: data.subarray(payloadStart, payloadEnd),
          name: strmCtx.name,
          units: strmCtx.units,
          scale: strmCtx.scale ? [...strmCtx.scale] : undefined,
        })
      }
    } else {
      // Top-level non-container entries
      if (fourcc === 'GPSU' && type === TYPE_UTC) {
        result.gpsu = readNullTermString(data, payloadStart, payloadEnd)
      } else if (fourcc === 'DVNM' && type === TYPE_STRING) {
        result.dvnm = readNullTermString(data, payloadStart, payloadEnd)
      }
    }

    pos = payloadStart + paddedSize
  }
}

/** Known data stream FourCCs that carry actual telemetry samples. */
function isDataStream(fourcc: string): boolean {
  return fourcc === 'GPS5' || fourcc === 'ACCL' || fourcc === 'GYRO' ||
    fourcc === 'GPS9' || fourcc === 'CORI' || fourcc === 'GRAV' ||
    fourcc === 'WNDM' || fourcc === 'MWET' || fourcc === 'IORI' ||
    fourcc === 'SHUT' || fourcc === 'WBAL' || fourcc === 'WRGB' ||
    fourcc === 'ISOE' || fourcc === 'UNIF' || fourcc === 'AALP'
}

/** Read a null-terminated (or length-bounded) ASCII string. */
function readNullTermString(data: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) {
    if (data[i] === 0) break
    s += String.fromCharCode(data[i])
  }
  return s
}

/**
 * Read an array of int16 values from a GPMF stream payload.
 * Returns a flat array: [row0_comp0, row0_comp1, ..., row1_comp0, ...]
 */
export function readInt16Array(stream: GpmfStream): number[] {
  const componentsPerRow = stream.structSize / 2
  const total = stream.repeat * componentsPerRow
  const result: number[] = new Array(total)
  const dv = dataViewFor(stream.data)
  for (let i = 0; i < total; i++) {
    result[i] = readInt16BE(stream.data, i * 2, dv)
  }
  return result
}

/**
 * Read an array of int32 values from a GPMF stream payload.
 */
export function readInt32Array(stream: GpmfStream): number[] {
  const componentsPerRow = stream.structSize / 4
  const total = stream.repeat * componentsPerRow
  const result: number[] = new Array(total)
  const dv = dataViewFor(stream.data)
  for (let i = 0; i < total; i++) {
    result[i] = readInt32BE(stream.data, i * 4, dv)
  }
  return result
}

/**
 * Read an array of float32 values from a GPMF stream payload.
 */
export function readFloat32Array(stream: GpmfStream): number[] {
  const componentsPerRow = stream.structSize / 4
  const total = stream.repeat * componentsPerRow
  const result: number[] = new Array(total)
  const dv = dataViewFor(stream.data)
  for (let i = 0; i < total; i++) {
    result[i] = readFloatBE(stream.data, i * 4, dv)
  }
  return result
}
