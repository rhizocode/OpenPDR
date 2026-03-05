/**
 * OpenPDR Telemetry Parser — Multi-Rate Frame Decoders & Packet Decoder
 * Ported from alivedrive_parser.py (decode_100hz_frame, decode_50hz_frame,
 * decode_10hz_frame, decode_5hz_frame, decode_1hz_frame, decode_packet)
 */

import type { TelemetryRow } from './types'
import { readUint16BE, readInt16BE, readUint32BE, readInt32BE, readFloatBE, dataViewFor } from '../shared/binary-reader'
import {
  PROPORTION_SCALE, ENGINE_SPEED_SCALE, RAD_TO_RPM, TORQUE_SCALE, TORQUE_OFFSET,
  STEERING_SCALE, RAD_TO_DEG, WHEEL_SPEED_SCALE, TIRE_RADIUS_M, MPS_TO_KPH,
  GYRO_YAW_SCALE, DEG_SCALE, ALT_SCALE, HEADING_DEG_SCALE, SPEED_SCALE,
  MPS_TO_MPH, BOOST_PRESSURE_SCALE, POWER_SCALE, OIL_PRESSURE_SCALE,
  FUEL_LEVEL_SCALE, ODOMETER_SCALE, TIRE_PRESSURE_SCALE, BRAKE_PEDAL_MAX,
  enumLabel,
} from './constants'

/** Preamble size at the start of each data packet. */
const PREAMBLE_SIZE = 14

/**
 * Compute the 10 GPS-latitude byte offsets for a packet, deterministically.
 *
 * Each data packet starts with a 14-byte preamble, followed by a carry-over
 * region containing the tail of the previous second's last sub-frame group
 * (one 100 Hz frame + one 50 Hz frame = hz100Size + 24 bytes).  After the
 * carry-over, the 10 Hz frames begin (speed first, then lat/lon/alt/…).
 *
 * Frame spacings are determined solely by the interleaving pattern:
 *   spacing(i) = 28 + (4 if even) + (1 if i∈{0,5}) + (hz1Size if i==0) + 5·groupSize
 */
function computeLatOffsets(hz100Size: number): number[] {
  const hz1Size = hz100Size === 25 ? 34 : 31
  const groupSize = 2 * hz100Size + 24
  const carryOver = hz100Size + 24        // second 100Hz + 50Hz from prev second

  const offsets: number[] = new Array(10)
  offsets[0] = PREAMBLE_SIZE + carryOver + 2  // +2 for speed (first field of 10Hz frame)

  for (let i = 1; i < 10; i++) {
    const prev = i - 1
    // Spacing from lat[prev] to lat[i]:
    //   26 (rest of 10Hz after lat) + optional sparse blocks + 5×groupSize + 2 (speed of next frame)
    let spacing = 28 + 5 * groupSize
    if (prev % 2 === 0) spacing += 4      // 5Hz block on even frames
    if (prev === 0 || prev === 5) spacing += 1  // 2Hz block on frames 0 and 5
    if (prev === 0) spacing += hz1Size     // 1Hz block on frame 0 only
    offsets[i] = offsets[prev] + spacing
  }
  return offsets
}

/** Pre-computed lat offsets for legacy format (17-byte 100Hz frames). */
const LAT_OFFSETS_LEGACY = computeLatOffsets(17)
/** Pre-computed lat offsets for MMP v4+ format (25-byte 100Hz frames). */
const LAT_OFFSETS_V4 = computeLatOffsets(25)

// ── Internal sub-frame types ──

interface Hz100Frame {
  brake_position: number
  engine_rpm: number
  engine_torque_nm: number
  steering_angle_deg: number
  wheel_speed_fl_kph: number
  wheel_speed_fr_kph: number
  wheel_speed_rl_kph: number
  wheel_speed_rr_kph: number
  gyro_yaw_deg_s: number
}

interface Hz50Frame {
  accel_device_x_g: number
  accel_device_y_g: number
  accel_device_z_g: number
  accel_vehicle_x_g: number
  accel_vehicle_y_g: number
  accel_vehicle_z_g: number
}

interface Hz10Frame {
  latitude_deg: number
  longitude_deg: number
  altitude_m: number
  heading_deg: number
  speed_mps: number
  speed_kph: number
  speed_mph: number
  gps_fix_quality: number
  gps_satellites: number
  abs_status: number
  abs_status_label: string
  throttle_position: number
  boost_pressure_kpa: number
  emotor_power_kw: number
  engine_power_kw: number
}

interface Hz5Frame {
  gear: number
  gear_label: string
  engine_startstop: number
  engine_startstop_label: string
  esc_status: number
  esc_status_label: string
  tcs_status: number
  tcs_status_label: string
}

interface Hz1Frame {
  emotor_powerlevel: number
  hv_battery_charge: number
  drive_mode: number
  drive_mode_label: string
  emotor_axle_available: number
  emotor_axle_available_label: string
  emotor_temp_rotor_c: number | null
  emotor_temp_stator_c: number | null
  engine_temp_coolant_c: number
  engine_temp_airintake_c: number
  engine_temp_oil_c: number
  engine_powerlevel: number
  outside_air_temp_c: number
  fuel_level_pct: number
  hv_battery_temp_avg_c: number | null
  hv_battery_temp_max_c: number | null
  hv_battery_temp_min_c: number | null
  odometer_km: number
  ptm_mode: number
  ptm_mode_label: string
  trans_oil_temp_c: number
  tire_pressure_fl_kpa: number
  tire_pressure_fr_kpa: number
  tire_pressure_rl_kpa: number
  tire_pressure_rr_kpa: number
  tire_temp_fl_c: number
  tire_temp_fr_c: number
  tire_temp_rl_c: number
  tire_temp_rr_c: number
  vse_status: number
  vse_status_label: string
}

// ── Frame decoders ──

/**
 * Decode a 100Hz sub-frame.
 *
 * MMP ≤ 3 (17 bytes):
 *   brake(1) engine_speed(2) torque(2) steering(2)
 *   wheel_FL(2) wheel_FR(2) wheel_RL(2) wheel_RR(2) gyro_yaw(2)
 *   — wheel speeds are u16 angular velocity (rad/s scale + tire radius)
 *
 * MMP ≥ 4 (25 bytes):
 *   brake(1) engine_speed(2) torque(2) steering(2)
 *   wheel_FL(4) wheel_FR(4) wheel_RL(4) wheel_RR(4) gyro_yaw(2)
 *   — wheel speeds are float32 BE in m/s (direct)
 */
function decode100HzFrame(packet: Uint8Array, offset: number, hz100Size: number, dv: DataView): Hz100Frame | null {
  if (offset < 0 || offset + hz100Size > packet.length) return null

  const torqueRaw = readUint16BE(packet, offset + 3, dv)

  if (hz100Size === 25) {
    // MMP v4: float32 wheel speeds in m/s
    // NaN/Infinity are sentinel values meaning "not available"
    const wsFlMps = readFloatBE(packet, offset + 7, dv)
    const wsFrMps = readFloatBE(packet, offset + 11, dv)
    const wsRlMps = readFloatBE(packet, offset + 15, dv)
    const wsRrMps = readFloatBE(packet, offset + 19, dv)
    const gyroRaw = readInt16BE(packet, offset + 23, dv)

    return {
      brake_position: packet[offset] * PROPORTION_SCALE,
      engine_rpm: readUint16BE(packet, offset + 1, dv) * ENGINE_SPEED_SCALE * RAD_TO_RPM,
      engine_torque_nm: torqueRaw * TORQUE_SCALE + TORQUE_OFFSET,
      steering_angle_deg: readInt16BE(packet, offset + 5, dv) * STEERING_SCALE * RAD_TO_DEG,
      wheel_speed_fl_kph: Number.isFinite(wsFlMps) ? wsFlMps * MPS_TO_KPH : 0,
      wheel_speed_fr_kph: Number.isFinite(wsFrMps) ? wsFrMps * MPS_TO_KPH : 0,
      wheel_speed_rl_kph: Number.isFinite(wsRlMps) ? wsRlMps * MPS_TO_KPH : 0,
      wheel_speed_rr_kph: Number.isFinite(wsRrMps) ? wsRrMps * MPS_TO_KPH : 0,
      gyro_yaw_deg_s: gyroRaw * GYRO_YAW_SCALE * RAD_TO_DEG,
    }
  } else {
    // MMP v3: u16 angular velocity wheel speeds
    // GM CAN bus reports 0xFF00-0xFFFF as "not available" sentinels when stationary
    const wsFl = readUint16BE(packet, offset + 7, dv)
    const wsFr = readUint16BE(packet, offset + 9, dv)
    const wsRl = readUint16BE(packet, offset + 11, dv)
    const wsRr = readUint16BE(packet, offset + 13, dv)
    const gyroRaw = readInt16BE(packet, offset + 15, dv)

    return {
      brake_position: packet[offset] * PROPORTION_SCALE,
      engine_rpm: readUint16BE(packet, offset + 1, dv) * ENGINE_SPEED_SCALE * RAD_TO_RPM,
      engine_torque_nm: torqueRaw * TORQUE_SCALE + TORQUE_OFFSET,
      steering_angle_deg: readInt16BE(packet, offset + 5, dv) * STEERING_SCALE * RAD_TO_DEG,
      wheel_speed_fl_kph: wsFl >= 0xFF00 ? 0 : wsFl * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      wheel_speed_fr_kph: wsFr >= 0xFF00 ? 0 : wsFr * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      wheel_speed_rl_kph: wsRl >= 0xFF00 ? 0 : wsRl * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      wheel_speed_rr_kph: wsRr >= 0xFF00 ? 0 : wsRr * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      gyro_yaw_deg_s: gyroRaw * GYRO_YAW_SCALE * RAD_TO_DEG,
    }
  }
}

/**
 * Decode a 50Hz sub-frame (24 bytes = 6 x float32).
 * Two independent 3-axis accelerometer readings in g:
 * - Device (ch 8-10): raw sensor frame
 * - Vehicle (ch 11-13): gravity-compensated vehicle-frame-aligned
 */
function decode50HzFrame(packet: Uint8Array, offset: number, dv: DataView): Hz50Frame | null {
  if (offset + 24 > packet.length) return null

  return {
    accel_device_x_g: readFloatBE(packet, offset, dv),
    accel_device_y_g: readFloatBE(packet, offset + 4, dv),
    accel_device_z_g: readFloatBE(packet, offset + 8, dv),
    accel_vehicle_x_g: readFloatBE(packet, offset + 12, dv),
    accel_vehicle_y_g: readFloatBE(packet, offset + 16, dv),
    accel_vehicle_z_g: readFloatBE(packet, offset + 20, dv),
  }
}

/**
 * Decode a 10Hz group 2 frame (28 bytes).
 * Layout: speed(2) lat(4) lon(4) alt(4) heading(4) fix(1) sat(1)
 *         ABS(1) throttle(1) boost(2) emotor_power(2) engine_power(2)
 * Speed is 2 bytes BEFORE latOffset.
 */
function decode10HzFrame(packet: Uint8Array, latOffset: number, dv: DataView): Hz10Frame | null {
  if (latOffset + 26 > packet.length) return null

  const latRaw = readInt32BE(packet, latOffset, dv)
  const lonRaw = readInt32BE(packet, latOffset + 4, dv)
  const altRaw = readUint32BE(packet, latOffset + 8, dv)
  const headingRaw = readInt32BE(packet, latOffset + 12, dv)
  const fixQuality = packet[latOffset + 16]
  const satellites = packet[latOffset + 17]
  const absStatus = packet[latOffset + 18]
  const throttleRaw = packet[latOffset + 19]
  const boostRaw = readUint16BE(packet, latOffset + 20, dv)
  const emotorRaw = readUint16BE(packet, latOffset + 22, dv)
  const engineRaw = readUint16BE(packet, latOffset + 24, dv)

  // Speed is 2 bytes BEFORE lat
  let speedRaw = 0
  if (latOffset >= 2) {
    speedRaw = readUint16BE(packet, latOffset - 2, dv)
  }

  return {
    latitude_deg: latRaw * DEG_SCALE,
    longitude_deg: lonRaw * DEG_SCALE,
    altitude_m: altRaw * ALT_SCALE,
    heading_deg: headingRaw * HEADING_DEG_SCALE,
    speed_mps: speedRaw * SPEED_SCALE,
    speed_kph: speedRaw * SPEED_SCALE * MPS_TO_KPH,
    speed_mph: speedRaw * SPEED_SCALE * MPS_TO_MPH,
    gps_fix_quality: fixQuality,
    gps_satellites: satellites,
    abs_status: absStatus,
    abs_status_label: enumLabel('abs_status', absStatus),
    throttle_position: throttleRaw * PROPORTION_SCALE,
    boost_pressure_kpa: boostRaw * BOOST_PRESSURE_SCALE / 1000.0,
    emotor_power_kw: emotorRaw * POWER_SCALE / 1000.0,
    engine_power_kw: engineRaw * POWER_SCALE / 1000.0,
  }
}

/**
 * Decode 5Hz data (4 bytes): gear, startstop, ESC, TCS.
 */
function decode5HzFrame(packet: Uint8Array, offset: number): Hz5Frame | null {
  if (offset + 4 > packet.length) return null

  const gearRaw = packet[offset]
  const startstopRaw = packet[offset + 1]
  const escRaw = packet[offset + 2]
  const tcsRaw = packet[offset + 3]

  return {
    gear: gearRaw,
    gear_label: enumLabel('gear', gearRaw),
    engine_startstop: startstopRaw,
    engine_startstop_label: enumLabel('engine_startstop', startstopRaw),
    esc_status: escRaw,
    esc_status_label: enumLabel('esc_status', escRaw),
    tcs_status: tcsRaw,
    tcs_status_label: enumLabel('tcs_status', tcsRaw),
  }
}

/**
 * Decode the full 1 Hz frame.
 * The 1 Hz block starts after: 10 Hz (26 bytes) + 5 Hz (4 bytes) + 2 Hz (1 byte)
 * = latOffset + 31.
 *
 * MMP ≤ 3 (31 bytes): drive_mode is u8 at b[3]
 * MMP ≥ 4 (34 bytes): drive_mode is u32 at b[3:7], shifting everything after by 3
 */
function decode1HzFrame(packet: Uint8Array, latOffset: number, hz1Size: number, dv: DataView): Hz1Frame | null {
  const hz1Offset = latOffset + 26 + 4 + 1 // after group2 + group3 + group4
  if (hz1Offset + hz1Size > packet.length) return null

  // Read directly from packet using absolute offsets (avoid subarray + new DataView)
  const b0 = hz1Offset
  const hvChargeRaw = readUint16BE(packet, b0 + 1, dv)

  // MMP v4: drive_mode is u32 (4 bytes) — use low byte for enum lookup
  let dmRaw: number
  let s: number // shift for all fields after drive_mode
  if (hz1Size === 34) {
    dmRaw = readUint32BE(packet, b0 + 3, dv) & 0xFF
    s = 3
  } else {
    dmRaw = packet[b0 + 3]
    s = 0
  }

  const odometerRaw = readUint32BE(packet, b0 + 16 + s, dv)

  return {
    emotor_powerlevel: packet[b0] * 0.01,
    hv_battery_charge: hvChargeRaw * 1.5259e-5,
    drive_mode: dmRaw,
    drive_mode_label: enumLabel('drive_mode', dmRaw),
    emotor_axle_available: packet[b0 + 4 + s],
    emotor_axle_available_label: enumLabel('emotor_axle_available', packet[b0 + 4 + s]),
    emotor_temp_rotor_c: packet[b0 + 5 + s] > 0 ? packet[b0 + 5 + s] - 40 : null,
    emotor_temp_stator_c: packet[b0 + 6 + s] > 0 ? packet[b0 + 6 + s] - 40 : null,
    engine_temp_coolant_c: packet[b0 + 7 + s] - 40,
    engine_temp_airintake_c: packet[b0 + 8 + s] - 40,
    engine_temp_oil_c: packet[b0 + 9 + s] - 40,
    engine_powerlevel: packet[b0 + 10 + s] * 0.01,
    outside_air_temp_c: packet[b0 + 11 + s] * 0.5 - 40,
    fuel_level_pct: packet[b0 + 12 + s] * FUEL_LEVEL_SCALE * 100.0,
    hv_battery_temp_avg_c: packet[b0 + 13 + s] > 0 ? packet[b0 + 13 + s] - 40 : null,
    hv_battery_temp_max_c: packet[b0 + 14 + s] > 0 ? packet[b0 + 14 + s] * 0.5 - 40 : null,
    hv_battery_temp_min_c: packet[b0 + 15 + s] > 0 ? packet[b0 + 15 + s] * 0.5 - 40 : null,
    odometer_km: odometerRaw * ODOMETER_SCALE / 1000.0,
    ptm_mode: packet[b0 + 20 + s],
    ptm_mode_label: enumLabel('ptm_mode', packet[b0 + 20 + s]),
    trans_oil_temp_c: packet[b0 + 21 + s] - 40,
    tire_pressure_fl_kpa: packet[b0 + 22 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_pressure_fr_kpa: packet[b0 + 23 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_pressure_rl_kpa: packet[b0 + 24 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_pressure_rr_kpa: packet[b0 + 25 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_temp_fl_c: packet[b0 + 26 + s] - 20,
    tire_temp_fr_c: packet[b0 + 27 + s] - 20,
    tire_temp_rl_c: packet[b0 + 28 + s] - 20,
    tire_temp_rr_c: packet[b0 + 29 + s] - 20,
    vse_status: packet[b0 + 30 + s],
    vse_status_label: enumLabel('vse_status', packet[b0 + 30 + s]),
  }
}

// ── Validation ──

/**
 * Sanity-check a decoded 100Hz frame.
 * In MMP v4, the float block scanner can find false matches due to float32
 * wheel speeds at low vehicle speeds.  This rejects obviously-wrong frames.
 */
function validate100Hz(f: Hz100Frame): boolean {
  if (Math.abs(f.engine_rpm) > 12000) return false
  if (Math.abs(f.wheel_speed_fl_kph) > 400) return false
  if (Math.abs(f.wheel_speed_fr_kph) > 400) return false
  if (Math.abs(f.wheel_speed_rl_kph) > 400) return false
  if (Math.abs(f.wheel_speed_rr_kph) > 400) return false
  return true
}

// ── Helper: average an array of sub-frames ──

/** Remap raw brake pedal position for display: 0–BRAKE_PEDAL_MAX → 0–1. */
function remapBrake(raw: number): number {
  return Math.min(raw / BRAKE_PEDAL_MAX, 1)
}

function avg100Hz(frames: Hz100Frame[]): {
  brake: number; brakeRaw: number; rpm: number; torque: number; steering: number
  wsFl: number; wsFr: number; wsRl: number; wsRr: number; gyro: number
} {
  const n = frames.length
  let brake = 0, rpm = 0, torque = 0, steering = 0
  let wsFl = 0, wsFr = 0, wsRl = 0, wsRr = 0, gyro = 0
  for (const f of frames) {
    brake += f.brake_position
    rpm += f.engine_rpm
    torque += f.engine_torque_nm
    steering += f.steering_angle_deg
    wsFl += f.wheel_speed_fl_kph
    wsFr += f.wheel_speed_fr_kph
    wsRl += f.wheel_speed_rl_kph
    wsRr += f.wheel_speed_rr_kph
    gyro += f.gyro_yaw_deg_s
  }
  const brakeRaw = brake / n
  return {
    brake: remapBrake(brakeRaw), brakeRaw, rpm: rpm / n, torque: torque / n, steering: steering / n,
    wsFl: wsFl / n, wsFr: wsFr / n, wsRl: wsRl / n, wsRr: wsRr / n, gyro: gyro / n,
  }
}

function avg50Hz(frames: Hz50Frame[]): { lat: number; lon: number; vert: number } {
  const n = frames.length
  let lat = 0, lon = 0, vert = 0
  for (const f of frames) {
    lat += f.accel_vehicle_x_g
    lon += f.accel_vehicle_y_g
    vert += f.accel_vehicle_z_g
  }
  return { lat: lat / n, lon: lon / n, vert: vert / n }
}

// ── Main packet decoder ──

/**
 * Decode a complete telemetry packet (one second of data).
 * MMP ≤ 3: ~3247 bytes, 17-byte 100Hz frames
 * MMP ≥ 4: ~4050 bytes, 25-byte 100Hz frames
 * Returns up to 10 TelemetryRow records (one per 100ms frame at 10 Hz).
 *
 * @param baseTime - Presentation time in seconds for this packet's first frame.
 *                   Derived from MP4 stts/elst timing when available.
 * @param packetIdx - Sample index in the data track (for TelemetryRow.packetIdx).
 */
export function decodePacket(
  packet: Uint8Array,
  baseTime: number,
  packetIdx: number,
  hz100Size: number = 17,
): TelemetryRow[] {
  if (packet.length < 100) return []

  // Single DataView for all reads from this packet
  const dv = dataViewFor(packet)

  // Derive 1Hz frame size from 100Hz frame size
  const hz1Size = hz100Size === 25 ? 34 : 31

  // Deterministic lat offsets — no GPS scanning needed
  const gpsOffsets = hz100Size === 25 ? LAT_OFFSETS_V4 : LAT_OFFSETS_LEGACY

  // Sub-frame group size: [100Hz][100Hz][50Hz]
  const groupSize = 2 * hz100Size + 24

  const records: TelemetryRow[] = []

  // Carry-forward state for sparse channels within this packet
  let lastGearLabel: string | undefined
  let lastGearRaw: number | undefined
  let lastStartstop: string | undefined
  let lastEsc: string | undefined
  let lastTcs: string | undefined

  for (let frameIdx = 0; frameIdx < gpsOffsets.length; frameIdx++) {
    const latOff = gpsOffsets[frameIdx]
    const frameTime = baseTime + frameIdx * 0.1

    // Decode 10Hz data
    const g2 = decode10HzFrame(packet, latOff, dv)
    if (!g2) continue

    // Compute sub-frame start using the known interleaving pattern:
    // GPS(26) + [5Hz(4) if even] + [2Hz(1) if frame 0|5] + [1Hz if frame 0]
    // then 5 groups of [100Hz, 100Hz, 50Hz]
    let subFrameStart = latOff + 26
    if (frameIdx % 2 === 0) subFrameStart += 4  // 5Hz block
    if (frameIdx === 0 || frameIdx === 5) subFrameStart += 1  // 2Hz block
    if (frameIdx === 0) subFrameStart += hz1Size  // 1Hz block

    // Decode 100Hz and 50Hz sub-frames at computed positions
    const hz100Frames: Hz100Frame[] = []
    const hz50Frames: Hz50Frame[] = []
    for (let g = 0; g < 5; g++) {
      const gOff = subFrameStart + g * groupSize
      const f1 = decode100HzFrame(packet, gOff, hz100Size, dv)
      if (f1 && validate100Hz(f1)) hz100Frames.push(f1)
      const f2 = decode100HzFrame(packet, gOff + hz100Size, hz100Size, dv)
      if (f2 && validate100Hz(f2)) hz100Frames.push(f2)
      const f50 = decode50HzFrame(packet, gOff + 2 * hz100Size, dv)
      if (f50) hz50Frames.push(f50)
    }

    // 5Hz data (even frames: 0, 2, 4, 6, 8)
    const has5Hz = frameIdx % 2 === 0
    let hz5Data: Hz5Frame | null = null
    if (has5Hz) {
      hz5Data = decode5HzFrame(packet, latOff + 26)
    }

    // 2Hz oil pressure (frames 0 and 5)
    let oilPressureKpa: number | undefined
    if (frameIdx === 0 || frameIdx === 5) {
      let hz2Offset = latOff + 26
      if (has5Hz) hz2Offset += 4 // after 5Hz block
      if (hz2Offset < packet.length) {
        oilPressureKpa = packet[hz2Offset] * OIL_PRESSURE_SCALE / 1000.0
      }
    }

    // Build the row
    const avg100 = hz100Frames.length > 0
      ? avg100Hz(hz100Frames)
      : { brake: 0, brakeRaw: 0, rpm: 0, torque: 0, steering: 0, wsFl: 0, wsFr: 0, wsRl: 0, wsRr: 0, gyro: 0 }

    const avg50 = hz50Frames.length > 0
      ? avg50Hz(hz50Frames)
      : { lat: 0, lon: 0, vert: 0 }

    const row: TelemetryRow = {
      time: frameTime,
      packetIdx,
      frameIdx,

      // GPS (10 Hz)
      lat: g2.latitude_deg,
      lon: g2.longitude_deg,
      altitude_m: g2.altitude_m,
      heading_deg: g2.heading_deg,
      speed_kph: g2.speed_kph,
      speed_mph: g2.speed_mph,
      speed_mps: g2.speed_mps,
      gps_fix_quality: g2.gps_fix_quality,
      gps_satellites: g2.gps_satellites,

      // 10 Hz vehicle
      throttle: g2.throttle_position,
      abs_status: g2.abs_status,
      abs_status_label: g2.abs_status_label,
      boost_pressure_kpa: g2.boost_pressure_kpa,
      emotor_power_kw: g2.emotor_power_kw,
      engine_power_kw: g2.engine_power_kw,

      // 100 Hz averaged
      brake: avg100.brake,
      brake_raw: avg100.brakeRaw,
      rpm: avg100.rpm,
      engine_torque_nm: avg100.torque,
      steering_deg: avg100.steering,
      gyro_yaw_deg_s: avg100.gyro,
      wheel_speed_fl_kph: avg100.wsFl,
      wheel_speed_fr_kph: avg100.wsFr,
      wheel_speed_rl_kph: avg100.wsRl,
      wheel_speed_rr_kph: avg100.wsRr,

      // 50 Hz averaged (vehicle-frame accelerometers)
      gforce_lat: avg50.lat,
      gforce_lon: avg50.lon,
      gforce_vert: avg50.vert,
    }

    // 5 Hz (even frames only) — carry forward to odd frames for instant display
    if (hz5Data) {
      lastGearLabel = hz5Data.gear_label
      lastGearRaw = hz5Data.gear
      lastStartstop = hz5Data.engine_startstop_label
      lastEsc = hz5Data.esc_status_label
      lastTcs = hz5Data.tcs_status_label
    }
    if (lastGearLabel !== undefined) {
      row.gear = lastGearLabel
      row.gear_raw = lastGearRaw
      row.engine_startstop = lastStartstop
      row.esc_status = lastEsc
      row.tcs_status = lastTcs
    }

    // 2 Hz
    if (oilPressureKpa !== undefined) {
      row.oil_pressure_kpa = oilPressureKpa
    }

    // 1 Hz (frame 0 only)
    if (frameIdx === 0) {
      const hz1Data = decode1HzFrame(packet, latOff, hz1Size, dv)
      if (hz1Data) {
        row.emotor_powerlevel = hz1Data.emotor_powerlevel
        row.hv_battery_charge = hz1Data.hv_battery_charge
        row.drive_mode = hz1Data.drive_mode_label
        row.emotor_axle_available = hz1Data.emotor_axle_available_label
        row.emotor_temp_rotor_c = hz1Data.emotor_temp_rotor_c
        row.emotor_temp_stator_c = hz1Data.emotor_temp_stator_c
        row.engine_temp_coolant_c = hz1Data.engine_temp_coolant_c
        row.engine_temp_airintake_c = hz1Data.engine_temp_airintake_c
        row.engine_temp_oil_c = hz1Data.engine_temp_oil_c
        row.engine_powerlevel = hz1Data.engine_powerlevel
        row.outside_air_temp_c = hz1Data.outside_air_temp_c
        row.fuel_level_pct = hz1Data.fuel_level_pct
        row.hv_battery_temp_avg_c = hz1Data.hv_battery_temp_avg_c
        row.hv_battery_temp_max_c = hz1Data.hv_battery_temp_max_c
        row.hv_battery_temp_min_c = hz1Data.hv_battery_temp_min_c
        row.odometer_km = hz1Data.odometer_km
        row.ptm_mode = hz1Data.ptm_mode_label
        row.trans_oil_temp_c = hz1Data.trans_oil_temp_c
        row.tire_pressure_fl_kpa = hz1Data.tire_pressure_fl_kpa
        row.tire_pressure_fr_kpa = hz1Data.tire_pressure_fr_kpa
        row.tire_pressure_rl_kpa = hz1Data.tire_pressure_rl_kpa
        row.tire_pressure_rr_kpa = hz1Data.tire_pressure_rr_kpa
        row.tire_temp_fl_c = hz1Data.tire_temp_fl_c
        row.tire_temp_fr_c = hz1Data.tire_temp_fr_c
        row.tire_temp_rl_c = hz1Data.tire_temp_rl_c
        row.tire_temp_rr_c = hz1Data.tire_temp_rr_c
        row.vse_status = hz1Data.vse_status_label
      }
    }

    records.push(row)
  }

  return records
}
