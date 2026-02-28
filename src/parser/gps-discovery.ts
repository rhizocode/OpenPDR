/**
 * OpenPDR Telemetry Parser — GPS Pattern Matching & Float Block Detection
 * Ported from alivedrive_parser.py (find_gps_in_packet, find_float_blocks)
 */

import { readInt32BE, readUint32BE, readFloatBE, dataViewFor } from '../shared/binary-reader'
import { DEG_SCALE, ALT_SCALE } from './constants'
import type { GpsRefRange } from './types'

/**
 * Find GPS latitude positions in a packet by searching for valid coordinate patterns.
 * Returns an array of byte offsets within the packet where lat (i32 BE) begins.
 *
 * Strategy:
 * 1. Scan for (lat, lon, alt) triplets that form valid GPS coordinates
 * 2. Filter to evenly-spaced positions (expecting ~300-360 byte gaps for 10 Hz)
 * 3. Validate clustering: all lats should be similar (within 0.5 degrees)
 */
export function findGpsInPacket(packet: Uint8Array, refRange?: GpsRefRange): number[] {
  const packetSize = packet.length
  const candidates: number[] = []
  const dv = dataViewFor(packet)

  for (let off = 0; off < packetSize - 12; off++) {
    const latRaw = readInt32BE(packet, off, dv)
    const lonRaw = readInt32BE(packet, off + 4, dv)
    const altRaw = readUint32BE(packet, off + 8, dv)

    const latDeg = latRaw * DEG_SCALE
    const lonDeg = lonRaw * DEG_SCALE
    const altM = altRaw * ALT_SCALE

    if (refRange) {
      if (
        latDeg >= refRange.latMin && latDeg <= refRange.latMax &&
        lonDeg >= refRange.lonMin && lonDeg <= refRange.lonMax &&
        altM > 0 && altM < 10000
      ) {
        candidates.push(off)
      }
    } else {
      // Strict search: require plausible lat AND lon AND altitude
      if (
        Math.abs(latDeg) > 10.0 && Math.abs(latDeg) < 80.0 &&
        Math.abs(lonDeg) > 10.0 && Math.abs(lonDeg) < 180.0 &&
        altM > 0 && altM < 10000
      ) {
        candidates.push(off)
      }
    }
  }

  // Filter to evenly-spaced positions (expecting ~300-360 byte gaps)
  if (candidates.length < 2) return candidates

  const filtered = [candidates[0]]
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i] - filtered[filtered.length - 1] >= 250) {
      filtered.push(candidates[i])
    }
    if (filtered.length >= 10) break
  }

  // Validate: GPS readings should be clustered (all similar lat/lon)
  if (filtered.length >= 3) {
    const lats: number[] = []
    const checkCount = Math.min(5, filtered.length)
    for (let i = 0; i < checkCount; i++) {
      const lat = readInt32BE(packet, filtered[i], dv) * DEG_SCALE
      lats.push(lat)
    }
    const latRange = Math.max(...lats) - Math.min(...lats)
    if (latRange > 0.5) {
      return [] // Likely false positives
    }
  }

  return filtered
}

/**
 * Verify previously-discovered GPS offsets in a new packet.
 * Returns the offsets if they still contain valid GPS data, or null if stale.
 */
export function verifyGpsOffsets(
  packet: Uint8Array,
  knownOffsets: number[],
  refRange?: GpsRefRange
): number[] | null {
  if (knownOffsets.length === 0) return null
  const dv = dataViewFor(packet)
  for (const off of knownOffsets) {
    if (off + 12 > packet.length) return null
    const latDeg = readInt32BE(packet, off, dv) * DEG_SCALE
    const lonDeg = readInt32BE(packet, off + 4, dv) * DEG_SCALE
    const altM = readUint32BE(packet, off + 8, dv) * ALT_SCALE
    if (refRange) {
      if (
        latDeg < refRange.latMin || latDeg > refRange.latMax ||
        lonDeg < refRange.lonMin || lonDeg > refRange.lonMax ||
        altM <= 0 || altM >= 10000
      ) return null
    } else {
      if (
        Math.abs(latDeg) <= 10.0 || Math.abs(latDeg) >= 80.0 ||
        Math.abs(lonDeg) <= 10.0 || Math.abs(lonDeg) >= 180.0 ||
        altM <= 0 || altM >= 10000
      ) return null
    }
  }
  return knownOffsets
}

/**
 * Verify previously-discovered float block offsets in a new packet.
 * Returns the offsets if they still contain valid float data, or null if stale.
 */
export function verifyFloatOffsets(
  packet: Uint8Array,
  knownOffsets: number[]
): number[] | null {
  if (knownOffsets.length === 0) return null
  const dv = dataViewFor(packet)
  for (const start of knownOffsets) {
    if (start + 24 > packet.length) return null
    for (let j = 0; j < 6; j++) {
      const fval = readFloatBE(packet, start + j * 4, dv)
      if (Math.abs(fval) > 5.0 || (Math.abs(fval) < 1e-10 && fval !== 0.0)) {
        return null
      }
    }
  }
  return knownOffsets
}

/**
 * Find all 50Hz float blocks (6 x float32 accelerometer data) in a packet.
 * Each block is 24 bytes: 3 device-frame + 3 vehicle-frame acceleration values.
 * Blocks must be at least 20 bytes apart (50 Hz spacing).
 */
export function findFloatBlocks(packet: Uint8Array, packetSize: number): number[] {
  const floatOffsets: number[] = []
  const dv = dataViewFor(packet)

  for (let start = 0; start < packetSize - 24; start++) {
    if (start + 24 > packet.length) break

    let valid = true
    for (let j = 0; j < 6; j++) {
      const fval = readFloatBE(packet, start + j * 4, dv)
      if (Math.abs(fval) > 5.0 || (Math.abs(fval) < 1e-10 && fval !== 0.0)) {
        valid = false
        break
      }
    }

    if (valid) {
      // Check at least 2 non-trivial values
      let nonzero = 0
      for (let j = 0; j < 6; j++) {
        if (Math.abs(readFloatBE(packet, start + j * 4, dv)) > 0.001) {
          nonzero++
        }
      }
      if (nonzero >= 2) {
        if (floatOffsets.length === 0 || start - floatOffsets[floatOffsets.length - 1] >= 20) {
          floatOffsets.push(start)
        }
      }
    }
  }

  return floatOffsets
}
