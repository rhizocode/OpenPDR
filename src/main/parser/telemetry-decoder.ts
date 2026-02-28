/**
 * OpenPDR Telemetry Parser — Multi-Rate Frame Decoders & Packet Decoder
 * Ported from alivedrive_parser.py (decode_100hz_frame, decode_50hz_frame,
 * decode_10hz_frame, decode_5hz_frame, decode_1hz_frame, decode_packet)
 */

import type { TelemetryRow, GpsRefRange } from './types'
import {
  PROPORTION_SCALE, ENGINE_SPEED_SCALE, RAD_TO_RPM, TORQUE_SCALE, TORQUE_OFFSET,
  STEERING_SCALE, RAD_TO_DEG, WHEEL_SPEED_SCALE, TIRE_RADIUS_M, MPS_TO_KPH,
  GYRO_YAW_SCALE, DEG_SCALE, ALT_SCALE, HEADING_DEG_SCALE, SPEED_SCALE,
  MPS_TO_MPH, BOOST_PRESSURE_SCALE, POWER_SCALE, OIL_PRESSURE_SCALE,
  FUEL_LEVEL_SCALE, ODOMETER_SCALE, TIRE_PRESSURE_SCALE,
  enumLabel,
} from './constants'
import { findGpsInPacket, findFloatBlocks, verifyGpsOffsets, verifyFloatOffsets } from './gps-discovery'

/** Cached offsets from a previous successful decode, reusable across packets of the same MMP version. */
export interface CachedOffsets {
  gps: number[]
  floats: number[]
}

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
function decode100HzFrame(packet: Buffer, offset: number, hz100Size: number = 17): Hz100Frame | null {
  if (offset < 0 || offset + hz100Size > packet.length) return null

  const torqueRaw = packet.readUInt16BE(offset + 3)

  if (hz100Size === 25) {
    // MMP v4: float32 wheel speeds in m/s
    const wsFlMps = packet.readFloatBE(offset + 7)
    const wsFrMps = packet.readFloatBE(offset + 11)
    const wsRlMps = packet.readFloatBE(offset + 15)
    const wsRrMps = packet.readFloatBE(offset + 19)
    const gyroRaw = packet.readInt16BE(offset + 23)

    return {
      brake_position: packet[offset] * PROPORTION_SCALE,
      engine_rpm: packet.readUInt16BE(offset + 1) * ENGINE_SPEED_SCALE * RAD_TO_RPM,
      engine_torque_nm: torqueRaw * TORQUE_SCALE + TORQUE_OFFSET,
      steering_angle_deg: packet.readInt16BE(offset + 5) * STEERING_SCALE * RAD_TO_DEG,
      wheel_speed_fl_kph: wsFlMps * MPS_TO_KPH,
      wheel_speed_fr_kph: wsFrMps * MPS_TO_KPH,
      wheel_speed_rl_kph: wsRlMps * MPS_TO_KPH,
      wheel_speed_rr_kph: wsRrMps * MPS_TO_KPH,
      gyro_yaw_deg_s: gyroRaw * GYRO_YAW_SCALE * RAD_TO_DEG,
    }
  } else {
    // MMP v3: u16 angular velocity wheel speeds
    const wsFl = packet.readUInt16BE(offset + 7)
    const wsFr = packet.readUInt16BE(offset + 9)
    const wsRl = packet.readUInt16BE(offset + 11)
    const wsRr = packet.readUInt16BE(offset + 13)
    const gyroRaw = packet.readInt16BE(offset + 15)

    return {
      brake_position: packet[offset] * PROPORTION_SCALE,
      engine_rpm: packet.readUInt16BE(offset + 1) * ENGINE_SPEED_SCALE * RAD_TO_RPM,
      engine_torque_nm: torqueRaw * TORQUE_SCALE + TORQUE_OFFSET,
      steering_angle_deg: packet.readInt16BE(offset + 5) * STEERING_SCALE * RAD_TO_DEG,
      wheel_speed_fl_kph: wsFl * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      wheel_speed_fr_kph: wsFr * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      wheel_speed_rl_kph: wsRl * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
      wheel_speed_rr_kph: wsRr * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
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
function decode50HzFrame(packet: Buffer, offset: number): Hz50Frame | null {
  if (offset + 24 > packet.length) return null

  return {
    accel_device_x_g: packet.readFloatBE(offset),
    accel_device_y_g: packet.readFloatBE(offset + 4),
    accel_device_z_g: packet.readFloatBE(offset + 8),
    accel_vehicle_x_g: packet.readFloatBE(offset + 12),
    accel_vehicle_y_g: packet.readFloatBE(offset + 16),
    accel_vehicle_z_g: packet.readFloatBE(offset + 20),
  }
}

/**
 * Decode a 10Hz group 2 frame (28 bytes).
 * Layout: speed(2) lat(4) lon(4) alt(4) heading(4) fix(1) sat(1)
 *         ABS(1) throttle(1) boost(2) emotor_power(2) engine_power(2)
 * Speed is 2 bytes BEFORE latOffset.
 */
function decode10HzFrame(packet: Buffer, latOffset: number): Hz10Frame | null {
  if (latOffset + 26 > packet.length) return null

  const latRaw = packet.readInt32BE(latOffset)
  const lonRaw = packet.readInt32BE(latOffset + 4)
  const altRaw = packet.readUInt32BE(latOffset + 8)
  const headingRaw = packet.readInt32BE(latOffset + 12)
  const fixQuality = packet[latOffset + 16]
  const satellites = packet[latOffset + 17]
  const absStatus = packet[latOffset + 18]
  const throttleRaw = packet[latOffset + 19]
  const boostRaw = packet.readUInt16BE(latOffset + 20)
  const emotorRaw = packet.readUInt16BE(latOffset + 22)
  const engineRaw = packet.readUInt16BE(latOffset + 24)

  // Speed is 2 bytes BEFORE lat
  let speedRaw = 0
  if (latOffset >= 2) {
    speedRaw = packet.readUInt16BE(latOffset - 2)
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
function decode5HzFrame(packet: Buffer, offset: number): Hz5Frame | null {
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
function decode1HzFrame(packet: Buffer, latOffset: number, hz1Size: number = 31): Hz1Frame | null {
  const hz1Offset = latOffset + 26 + 4 + 1 // after group2 + group3 + group4
  if (hz1Offset + hz1Size > packet.length) return null

  const b = packet.subarray(hz1Offset, hz1Offset + hz1Size)
  const hvChargeRaw = b.readUInt16BE(1)

  // MMP v4: drive_mode is u32 (4 bytes) — use low byte for enum lookup
  let dmRaw: number
  let s: number // shift for all fields after drive_mode
  if (hz1Size === 34) {
    dmRaw = b.readUInt32BE(3) & 0xFF
    s = 3
  } else {
    dmRaw = b[3]
    s = 0
  }

  const odometerRaw = b.readUInt32BE(16 + s)

  return {
    emotor_powerlevel: b[0] * 0.01,
    hv_battery_charge: hvChargeRaw * 1.5259e-5,
    drive_mode: dmRaw,
    drive_mode_label: enumLabel('drive_mode', dmRaw),
    emotor_axle_available: b[4 + s],
    emotor_axle_available_label: enumLabel('emotor_axle_available', b[4 + s]),
    emotor_temp_rotor_c: b[5 + s] > 0 ? b[5 + s] - 40 : null,
    emotor_temp_stator_c: b[6 + s] > 0 ? b[6 + s] - 40 : null,
    engine_temp_coolant_c: b[7 + s] - 40,
    engine_temp_airintake_c: b[8 + s] - 40,
    engine_temp_oil_c: b[9 + s] - 40,
    engine_powerlevel: b[10 + s] * 0.01,
    outside_air_temp_c: b[11 + s] * 0.5 - 40,
    fuel_level_pct: b[12 + s] * FUEL_LEVEL_SCALE * 100.0,
    hv_battery_temp_avg_c: b[13 + s] > 0 ? b[13 + s] - 40 : null,
    hv_battery_temp_max_c: b[14 + s] > 0 ? b[14 + s] * 0.5 - 40 : null,
    hv_battery_temp_min_c: b[15 + s] > 0 ? b[15 + s] * 0.5 - 40 : null,
    odometer_km: odometerRaw * ODOMETER_SCALE / 1000.0,
    ptm_mode: b[20 + s],
    ptm_mode_label: enumLabel('ptm_mode', b[20 + s]),
    trans_oil_temp_c: b[21 + s] - 40,
    tire_pressure_fl_kpa: b[22 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_pressure_fr_kpa: b[23 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_pressure_rl_kpa: b[24 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_pressure_rr_kpa: b[25 + s] * TIRE_PRESSURE_SCALE / 1000.0,
    tire_temp_fl_c: b[26 + s] - 20,
    tire_temp_fr_c: b[27 + s] - 20,
    tire_temp_rl_c: b[28 + s] - 20,
    tire_temp_rr_c: b[29 + s] - 20,
    vse_status: b[30 + s],
    vse_status_label: enumLabel('vse_status', b[30 + s]),
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

function avg100Hz(frames: Hz100Frame[]): {
  brake: number; rpm: number; torque: number; steering: number
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
  return {
    brake: brake / n, rpm: rpm / n, torque: torque / n, steering: steering / n,
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
 */
export function decodePacket(
  packet: Buffer,
  packetIdx: number,
  refLatRange?: GpsRefRange,
  hz100Size: number = 17,
  cachedOffsets?: CachedOffsets
): { rows: TelemetryRow[]; offsets: CachedOffsets | undefined } {
  if (packet.length < 100) return { rows: [], offsets: cachedOffsets }

  // Derive 1Hz frame size from 100Hz frame size
  const hz1Size = hz100Size === 25 ? 34 : 31

  // Try cached offsets first, fall back to full scan
  const gpsOffsets = (cachedOffsets && verifyGpsOffsets(packet, cachedOffsets.gps, refLatRange))
    ?? findGpsInPacket(packet, refLatRange)
  if (gpsOffsets.length < 5) return { rows: [], offsets: cachedOffsets }

  const floatOffsets = (cachedOffsets && verifyFloatOffsets(packet, cachedOffsets.floats))
    ?? findFloatBlocks(packet, packet.length)

  // Cache these offsets for subsequent packets
  const newOffsets: CachedOffsets = { gps: gpsOffsets, floats: floatOffsets }

  const records: TelemetryRow[] = []
  const baseTime = packetIdx // seconds

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
    const g2 = decode10HzFrame(packet, latOff)
    if (!g2) continue

    // Find the float blocks and 100Hz frames for this 10Hz period
    const nextLat = frameIdx < gpsOffsets.length - 1
      ? gpsOffsets[frameIdx + 1]
      : packet.length

    const frameFloats = floatOffsets.filter(f => f > latOff && f < nextLat)

    // Decode 100Hz sub-frames (two frames before each float block)
    const hz100Frames: Hz100Frame[] = []
    for (const foff of frameFloats) {
      const f1Off = foff - 2 * hz100Size
      const f2Off = foff - hz100Size
      if (f1Off >= latOff) {
        const f1 = decode100HzFrame(packet, f1Off, hz100Size)
        if (f1 && validate100Hz(f1)) hz100Frames.push(f1)
      }
      const f2 = decode100HzFrame(packet, f2Off, hz100Size)
      if (f2 && validate100Hz(f2)) hz100Frames.push(f2)
    }

    // Decode 50Hz sub-frames
    const hz50Frames: Hz50Frame[] = []
    for (const foff of frameFloats) {
      const f = decode50HzFrame(packet, foff)
      if (f) hz50Frames.push(f)
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
      : { brake: 0, rpm: 0, torque: 0, steering: 0, wsFl: 0, wsFr: 0, wsRl: 0, wsRr: 0, gyro: 0 }

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
      const hz1Data = decode1HzFrame(packet, latOff, hz1Size)
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

  return { rows: records, offsets: newOffsets }
}
