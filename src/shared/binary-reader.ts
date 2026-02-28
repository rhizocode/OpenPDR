/**
 * OpenPDR — Platform-agnostic binary reader helpers
 *
 * DataView-based replacements for Node.js Buffer read methods.
 * All functions operate on Uint8Array (works in both Node.js and browsers).
 */

/** Read unsigned 32-bit big-endian integer */
export function readUint32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, false)
}

/** Read signed 32-bit big-endian integer */
export function readInt32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(offset, false)
}

/** Read unsigned 16-bit big-endian integer */
export function readUint16BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(offset, false)
}

/** Read signed 16-bit big-endian integer */
export function readInt16BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt16(offset, false)
}

/** Read 32-bit big-endian float */
export function readFloatBE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat32(offset, false)
}

/** Read 64-bit big-endian double */
export function readDoubleBE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(offset, false)
}

/** Read unsigned 64-bit big-endian integer as bigint */
export function readBigUint64BE(buf: Uint8Array, offset: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(offset, false)
}

/** Read ASCII string from byte range [start, end) */
export function readAscii(buf: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end && i < buf.length; i++) {
    s += String.fromCharCode(buf[i])
  }
  return s
}

/**
 * Find the first occurrence of a byte value or byte sequence in buf,
 * starting from `start`. Returns -1 if not found.
 */
export function indexOf(buf: Uint8Array, needle: Uint8Array | number, start = 0): number {
  if (typeof needle === 'number') {
    for (let i = start; i < buf.length; i++) {
      if (buf[i] === needle) return i
    }
    return -1
  }

  if (needle.length === 0) return start
  const end = buf.length - needle.length
  outer:
  for (let i = start; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** Create a Uint8Array from an ASCII string (for tag matching) */
export function asciiBytes(str: string): Uint8Array {
  const buf = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i)
  }
  return buf
}
