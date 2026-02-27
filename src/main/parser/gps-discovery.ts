/**
 * OpenPDR Telemetry Parser — GPS Pattern Matching & Float Block Detection
 * Ported from alivedrive_parser.py (find_gps_in_packet, find_float_blocks)
 */

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
export function findGpsInPacket(packet: Buffer, refRange?: GpsRefRange): number[] {
  const packetSize = packet.length
  const candidates: number[] = []

  for (let off = 0; off < packetSize - 12; off++) {
    const latRaw = packet.readInt32BE(off)
    const lonRaw = packet.readInt32BE(off + 4)
    const altRaw = packet.readUInt32BE(off + 8)

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
      const lat = packet.readInt32BE(filtered[i]) * DEG_SCALE
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
 * Find all 50Hz float blocks (6 x float32 accelerometer data) in a packet.
 * Each block is 24 bytes: 3 device-frame + 3 vehicle-frame acceleration values.
 * Blocks must be at least 20 bytes apart (50 Hz spacing).
 */
export function findFloatBlocks(packet: Buffer, packetSize: number): number[] {
  const floatOffsets: number[] = []

  for (let start = 0; start < packetSize - 24; start++) {
    if (start + 24 > packet.length) break

    let valid = true
    for (let j = 0; j < 6; j++) {
      const fval = packet.readFloatBE(start + j * 4)
      if (Math.abs(fval) > 5.0 || (Math.abs(fval) < 1e-10 && fval !== 0.0)) {
        valid = false
        break
      }
    }

    if (valid) {
      // Check at least 2 non-trivial values
      let nonzero = 0
      for (let j = 0; j < 6; j++) {
        if (Math.abs(packet.readFloatBE(start + j * 4)) > 0.001) {
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
