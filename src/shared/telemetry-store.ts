/**
 * OpenPDR — Columnar Telemetry Store
 *
 * Stores telemetry data as parallel typed arrays (one per channel) instead of
 * an array of objects. This reduces heap usage from ~200-300 MB to ~25-35 MB
 * for a typical 20-minute session at 10 Hz (~120K rows).
 *
 * Charts and the track map read the typed arrays directly. The HUD uses
 * getRow() to assemble a single TelemetryRow object per frame.
 */

import type { TelemetryRow } from './types'

export interface TelemetryStore {
  /** Number of rows currently stored. */
  length: number

  // ── Timing (always populated) ──
  time: Float64Array
  packetIdx: Uint32Array
  frameIdx: Uint8Array

  // ── GPS 10 Hz (always populated) ──
  lat: Float64Array
  lon: Float64Array
  altitude_m: Float32Array
  heading_deg: Float32Array
  speed_kph: Float32Array
  speed_mph: Float32Array
  speed_mps: Float32Array
  gps_fix_quality: Uint8Array
  gps_satellites: Uint8Array

  // ── 10 Hz vehicle ──
  throttle: Float32Array
  abs_status: Uint8Array
  boost_pressure_kpa: Float32Array
  emotor_power_kw: Float32Array
  engine_power_kw: Float32Array

  // ── 100 Hz averaged ──
  brake: Float32Array      // remapped pedal position (0–1, scaled for display)
  brake_raw: Float32Array  // raw pedal position (0–1, true CAN bus value)
  rpm: Float32Array
  engine_torque_nm: Float32Array
  steering_deg: Float32Array
  gyro_yaw_deg_s: Float32Array
  wheel_speed_fl_kph: Float32Array
  wheel_speed_fr_kph: Float32Array
  wheel_speed_rl_kph: Float32Array
  wheel_speed_rr_kph: Float32Array

  // ── 50 Hz averaged ──
  gforce_lat: Float32Array
  gforce_lon: Float32Array
  gforce_vert: Float32Array

  // ── Sparse channels (regular arrays — only populated every N rows) ──
  abs_status_label: string[]
  gear: (string | undefined)[]
  gear_raw: (number | undefined)[]
  engine_startstop: (string | undefined)[]
  esc_status: (string | undefined)[]
  tcs_status: (string | undefined)[]
  oil_pressure_kpa: (number | undefined)[]

  // ── 1 Hz sparse channels ──
  emotor_powerlevel: (number | undefined)[]
  hv_battery_charge: (number | undefined)[]
  drive_mode: (string | undefined)[]
  emotor_axle_available: (string | undefined)[]
  emotor_temp_rotor_c: (number | null | undefined)[]
  emotor_temp_stator_c: (number | null | undefined)[]
  engine_temp_coolant_c: (number | undefined)[]
  engine_temp_airintake_c: (number | undefined)[]
  engine_temp_oil_c: (number | undefined)[]
  engine_powerlevel: (number | undefined)[]
  outside_air_temp_c: (number | undefined)[]
  fuel_level_pct: (number | undefined)[]
  hv_battery_temp_avg_c: (number | null | undefined)[]
  hv_battery_temp_max_c: (number | null | undefined)[]
  hv_battery_temp_min_c: (number | null | undefined)[]
  odometer_km: (number | undefined)[]
  ptm_mode: (string | undefined)[]
  trans_oil_temp_c: (number | undefined)[]
  tire_pressure_fl_kpa: (number | undefined)[]
  tire_pressure_fr_kpa: (number | undefined)[]
  tire_pressure_rl_kpa: (number | undefined)[]
  tire_pressure_rr_kpa: (number | undefined)[]
  tire_temp_fl_c: (number | undefined)[]
  tire_temp_fr_c: (number | undefined)[]
  tire_temp_rl_c: (number | undefined)[]
  tire_temp_rr_c: (number | undefined)[]
  vse_status: (string | undefined)[]
}

/** Create an empty TelemetryStore pre-allocated for `capacity` rows. */
export function createTelemetryStore(capacity: number): TelemetryStore {
  return {
    length: 0,

    time: new Float64Array(capacity),
    packetIdx: new Uint32Array(capacity),
    frameIdx: new Uint8Array(capacity),

    lat: new Float64Array(capacity),
    lon: new Float64Array(capacity),
    altitude_m: new Float32Array(capacity),
    heading_deg: new Float32Array(capacity),
    speed_kph: new Float32Array(capacity),
    speed_mph: new Float32Array(capacity),
    speed_mps: new Float32Array(capacity),
    gps_fix_quality: new Uint8Array(capacity),
    gps_satellites: new Uint8Array(capacity),

    throttle: new Float32Array(capacity),
    abs_status: new Uint8Array(capacity),
    boost_pressure_kpa: new Float32Array(capacity),
    emotor_power_kw: new Float32Array(capacity),
    engine_power_kw: new Float32Array(capacity),

    brake: new Float32Array(capacity),
    brake_raw: new Float32Array(capacity),
    rpm: new Float32Array(capacity),
    engine_torque_nm: new Float32Array(capacity),
    steering_deg: new Float32Array(capacity),
    gyro_yaw_deg_s: new Float32Array(capacity),
    wheel_speed_fl_kph: new Float32Array(capacity),
    wheel_speed_fr_kph: new Float32Array(capacity),
    wheel_speed_rl_kph: new Float32Array(capacity),
    wheel_speed_rr_kph: new Float32Array(capacity),

    gforce_lat: new Float32Array(capacity),
    gforce_lon: new Float32Array(capacity),
    gforce_vert: new Float32Array(capacity),

    abs_status_label: new Array(capacity),
    gear: new Array(capacity),
    gear_raw: new Array(capacity),
    engine_startstop: new Array(capacity),
    esc_status: new Array(capacity),
    tcs_status: new Array(capacity),
    oil_pressure_kpa: new Array(capacity),

    emotor_powerlevel: new Array(capacity),
    hv_battery_charge: new Array(capacity),
    drive_mode: new Array(capacity),
    emotor_axle_available: new Array(capacity),
    emotor_temp_rotor_c: new Array(capacity),
    emotor_temp_stator_c: new Array(capacity),
    engine_temp_coolant_c: new Array(capacity),
    engine_temp_airintake_c: new Array(capacity),
    engine_temp_oil_c: new Array(capacity),
    engine_powerlevel: new Array(capacity),
    outside_air_temp_c: new Array(capacity),
    fuel_level_pct: new Array(capacity),
    hv_battery_temp_avg_c: new Array(capacity),
    hv_battery_temp_max_c: new Array(capacity),
    hv_battery_temp_min_c: new Array(capacity),
    odometer_km: new Array(capacity),
    ptm_mode: new Array(capacity),
    trans_oil_temp_c: new Array(capacity),
    tire_pressure_fl_kpa: new Array(capacity),
    tire_pressure_fr_kpa: new Array(capacity),
    tire_pressure_rl_kpa: new Array(capacity),
    tire_pressure_rr_kpa: new Array(capacity),
    tire_temp_fl_c: new Array(capacity),
    tire_temp_fr_c: new Array(capacity),
    tire_temp_rl_c: new Array(capacity),
    tire_temp_rr_c: new Array(capacity),
    vse_status: new Array(capacity),
  }
}

/** Write a TelemetryRow into the store at position `index`. */
export function writeRow(store: TelemetryStore, index: number, row: TelemetryRow): void {
  store.time[index] = row.time
  store.packetIdx[index] = row.packetIdx
  store.frameIdx[index] = row.frameIdx

  store.lat[index] = row.lat
  store.lon[index] = row.lon
  store.altitude_m[index] = row.altitude_m
  store.heading_deg[index] = row.heading_deg
  store.speed_kph[index] = row.speed_kph
  store.speed_mph[index] = row.speed_mph
  store.speed_mps[index] = row.speed_mps
  store.gps_fix_quality[index] = row.gps_fix_quality
  store.gps_satellites[index] = row.gps_satellites

  store.throttle[index] = row.throttle
  store.abs_status[index] = row.abs_status
  store.boost_pressure_kpa[index] = row.boost_pressure_kpa
  store.emotor_power_kw[index] = row.emotor_power_kw
  store.engine_power_kw[index] = row.engine_power_kw

  store.brake[index] = row.brake
  store.brake_raw[index] = row.brake_raw
  store.rpm[index] = row.rpm
  store.engine_torque_nm[index] = row.engine_torque_nm
  store.steering_deg[index] = row.steering_deg
  store.gyro_yaw_deg_s[index] = row.gyro_yaw_deg_s
  store.wheel_speed_fl_kph[index] = row.wheel_speed_fl_kph
  store.wheel_speed_fr_kph[index] = row.wheel_speed_fr_kph
  store.wheel_speed_rl_kph[index] = row.wheel_speed_rl_kph
  store.wheel_speed_rr_kph[index] = row.wheel_speed_rr_kph

  store.gforce_lat[index] = row.gforce_lat
  store.gforce_lon[index] = row.gforce_lon
  store.gforce_vert[index] = row.gforce_vert

  store.abs_status_label[index] = row.abs_status_label
  store.gear[index] = row.gear
  store.gear_raw[index] = row.gear_raw
  store.engine_startstop[index] = row.engine_startstop
  store.esc_status[index] = row.esc_status
  store.tcs_status[index] = row.tcs_status
  store.oil_pressure_kpa[index] = row.oil_pressure_kpa

  store.emotor_powerlevel[index] = row.emotor_powerlevel
  store.hv_battery_charge[index] = row.hv_battery_charge
  store.drive_mode[index] = row.drive_mode
  store.emotor_axle_available[index] = row.emotor_axle_available
  store.emotor_temp_rotor_c[index] = row.emotor_temp_rotor_c
  store.emotor_temp_stator_c[index] = row.emotor_temp_stator_c
  store.engine_temp_coolant_c[index] = row.engine_temp_coolant_c
  store.engine_temp_airintake_c[index] = row.engine_temp_airintake_c
  store.engine_temp_oil_c[index] = row.engine_temp_oil_c
  store.engine_powerlevel[index] = row.engine_powerlevel
  store.outside_air_temp_c[index] = row.outside_air_temp_c
  store.fuel_level_pct[index] = row.fuel_level_pct
  store.hv_battery_temp_avg_c[index] = row.hv_battery_temp_avg_c
  store.hv_battery_temp_max_c[index] = row.hv_battery_temp_max_c
  store.hv_battery_temp_min_c[index] = row.hv_battery_temp_min_c
  store.odometer_km[index] = row.odometer_km
  store.ptm_mode[index] = row.ptm_mode
  store.trans_oil_temp_c[index] = row.trans_oil_temp_c
  store.tire_pressure_fl_kpa[index] = row.tire_pressure_fl_kpa
  store.tire_pressure_fr_kpa[index] = row.tire_pressure_fr_kpa
  store.tire_pressure_rl_kpa[index] = row.tire_pressure_rl_kpa
  store.tire_pressure_rr_kpa[index] = row.tire_pressure_rr_kpa
  store.tire_temp_fl_c[index] = row.tire_temp_fl_c
  store.tire_temp_fr_c[index] = row.tire_temp_fr_c
  store.tire_temp_rl_c[index] = row.tire_temp_rl_c
  store.tire_temp_rr_c[index] = row.tire_temp_rr_c
  store.vse_status[index] = row.vse_status
}

/** Create a zeroed TelemetryRow suitable for reuse with getRowInto(). */
export function createEmptyRow(): TelemetryRow {
  return {
    time: 0, packetIdx: 0, frameIdx: 0,
    lat: 0, lon: 0, altitude_m: 0, heading_deg: 0,
    speed_kph: 0, speed_mph: 0, speed_mps: 0,
    gps_fix_quality: 0, gps_satellites: 0,
    throttle: 0, abs_status: 0, abs_status_label: '',
    boost_pressure_kpa: 0, emotor_power_kw: 0, engine_power_kw: 0,
    brake: 0, brake_raw: 0, rpm: 0, engine_torque_nm: 0, steering_deg: 0,
    gyro_yaw_deg_s: 0,
    wheel_speed_fl_kph: 0, wheel_speed_fr_kph: 0,
    wheel_speed_rl_kph: 0, wheel_speed_rr_kph: 0,
    gforce_lat: 0, gforce_lon: 0, gforce_vert: 0,
  }
}

/**
 * Fill a pre-allocated TelemetryRow from columnar arrays at `index`.
 * Mutates `out` in-place — no allocation. Callers must not hold references
 * across frames.
 */
export function getRowInto(store: TelemetryStore, index: number, out: TelemetryRow): TelemetryRow {
  out.time = store.time[index]
  out.packetIdx = store.packetIdx[index]
  out.frameIdx = store.frameIdx[index]

  out.lat = store.lat[index]
  out.lon = store.lon[index]
  out.altitude_m = store.altitude_m[index]
  out.heading_deg = store.heading_deg[index]
  out.speed_kph = store.speed_kph[index]
  out.speed_mph = store.speed_mph[index]
  out.speed_mps = store.speed_mps[index]
  out.gps_fix_quality = store.gps_fix_quality[index]
  out.gps_satellites = store.gps_satellites[index]

  out.throttle = store.throttle[index]
  out.abs_status = store.abs_status[index]
  out.abs_status_label = store.abs_status_label[index]
  out.boost_pressure_kpa = store.boost_pressure_kpa[index]
  out.emotor_power_kw = store.emotor_power_kw[index]
  out.engine_power_kw = store.engine_power_kw[index]

  out.brake = store.brake[index]
  out.brake_raw = store.brake_raw[index]
  out.rpm = store.rpm[index]
  out.engine_torque_nm = store.engine_torque_nm[index]
  out.steering_deg = store.steering_deg[index]
  out.gyro_yaw_deg_s = store.gyro_yaw_deg_s[index]
  out.wheel_speed_fl_kph = store.wheel_speed_fl_kph[index]
  out.wheel_speed_fr_kph = store.wheel_speed_fr_kph[index]
  out.wheel_speed_rl_kph = store.wheel_speed_rl_kph[index]
  out.wheel_speed_rr_kph = store.wheel_speed_rr_kph[index]

  out.gforce_lat = store.gforce_lat[index]
  out.gforce_lon = store.gforce_lon[index]
  out.gforce_vert = store.gforce_vert[index]

  // Sparse channels — always assign (undefined is fine, keeps the object shape monomorphic)
  out.gear = store.gear[index]
  out.gear_raw = store.gear_raw[index]
  out.engine_startstop = store.engine_startstop[index]
  out.esc_status = store.esc_status[index]
  out.tcs_status = store.tcs_status[index]
  out.oil_pressure_kpa = store.oil_pressure_kpa[index]

  out.emotor_powerlevel = store.emotor_powerlevel[index]
  out.hv_battery_charge = store.hv_battery_charge[index]
  out.drive_mode = store.drive_mode[index]
  out.emotor_axle_available = store.emotor_axle_available[index]
  out.emotor_temp_rotor_c = store.emotor_temp_rotor_c[index]
  out.emotor_temp_stator_c = store.emotor_temp_stator_c[index]
  out.engine_temp_coolant_c = store.engine_temp_coolant_c[index]
  out.engine_temp_airintake_c = store.engine_temp_airintake_c[index]
  out.engine_temp_oil_c = store.engine_temp_oil_c[index]
  out.engine_powerlevel = store.engine_powerlevel[index]
  out.outside_air_temp_c = store.outside_air_temp_c[index]
  out.fuel_level_pct = store.fuel_level_pct[index]
  out.hv_battery_temp_avg_c = store.hv_battery_temp_avg_c[index]
  out.hv_battery_temp_max_c = store.hv_battery_temp_max_c[index]
  out.hv_battery_temp_min_c = store.hv_battery_temp_min_c[index]
  out.odometer_km = store.odometer_km[index]
  out.ptm_mode = store.ptm_mode[index]
  out.trans_oil_temp_c = store.trans_oil_temp_c[index]
  out.tire_pressure_fl_kpa = store.tire_pressure_fl_kpa[index]
  out.tire_pressure_fr_kpa = store.tire_pressure_fr_kpa[index]
  out.tire_pressure_rl_kpa = store.tire_pressure_rl_kpa[index]
  out.tire_pressure_rr_kpa = store.tire_pressure_rr_kpa[index]
  out.tire_temp_fl_c = store.tire_temp_fl_c[index]
  out.tire_temp_fr_c = store.tire_temp_fr_c[index]
  out.tire_temp_rl_c = store.tire_temp_rl_c[index]
  out.tire_temp_rr_c = store.tire_temp_rr_c[index]
  out.vse_status = store.vse_status[index]

  return out
}

/** Assemble a TelemetryRow object from columnar arrays at `index`. Allocates — use getRowInto() in hot paths. */
export function getRow(store: TelemetryStore, index: number): TelemetryRow {
  return getRowInto(store, index, createEmptyRow())
}

/**
 * Binary search: find the index of the row closest to time `t`.
 * Returns 0 for empty stores. Clamps to [0, length-1].
 */
export function findClosestTimeIndex(times: Float64Array, t: number, length: number): number {
  if (length === 0) return 0

  let lo = 0
  let hi = length - 1

  if (t <= times[0]) return 0
  if (t >= times[hi]) return hi

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < t) lo = mid + 1
    else if (times[mid] > t) hi = mid - 1
    else return mid
  }

  if (lo >= length) return hi
  if (hi < 0) return lo
  return (t - times[hi]) <= (times[lo] - t) ? hi : lo
}

/**
 * Trim a store to its actual length by slicing all typed arrays.
 * Call after parsing is complete when length < capacity.
 */
export function trimStore(store: TelemetryStore): TelemetryStore {
  const n = store.length
  if (n === store.time.length) return store  // already exact size

  return {
    length: n,

    time: store.time.slice(0, n),
    packetIdx: store.packetIdx.slice(0, n),
    frameIdx: store.frameIdx.slice(0, n),

    lat: store.lat.slice(0, n),
    lon: store.lon.slice(0, n),
    altitude_m: store.altitude_m.slice(0, n),
    heading_deg: store.heading_deg.slice(0, n),
    speed_kph: store.speed_kph.slice(0, n),
    speed_mph: store.speed_mph.slice(0, n),
    speed_mps: store.speed_mps.slice(0, n),
    gps_fix_quality: store.gps_fix_quality.slice(0, n),
    gps_satellites: store.gps_satellites.slice(0, n),

    throttle: store.throttle.slice(0, n),
    abs_status: store.abs_status.slice(0, n),
    boost_pressure_kpa: store.boost_pressure_kpa.slice(0, n),
    emotor_power_kw: store.emotor_power_kw.slice(0, n),
    engine_power_kw: store.engine_power_kw.slice(0, n),

    brake: store.brake.slice(0, n),
    brake_raw: store.brake_raw.slice(0, n),
    rpm: store.rpm.slice(0, n),
    engine_torque_nm: store.engine_torque_nm.slice(0, n),
    steering_deg: store.steering_deg.slice(0, n),
    gyro_yaw_deg_s: store.gyro_yaw_deg_s.slice(0, n),
    wheel_speed_fl_kph: store.wheel_speed_fl_kph.slice(0, n),
    wheel_speed_fr_kph: store.wheel_speed_fr_kph.slice(0, n),
    wheel_speed_rl_kph: store.wheel_speed_rl_kph.slice(0, n),
    wheel_speed_rr_kph: store.wheel_speed_rr_kph.slice(0, n),

    gforce_lat: store.gforce_lat.slice(0, n),
    gforce_lon: store.gforce_lon.slice(0, n),
    gforce_vert: store.gforce_vert.slice(0, n),

    abs_status_label: store.abs_status_label.slice(0, n),
    gear: store.gear.slice(0, n),
    gear_raw: store.gear_raw.slice(0, n),
    engine_startstop: store.engine_startstop.slice(0, n),
    esc_status: store.esc_status.slice(0, n),
    tcs_status: store.tcs_status.slice(0, n),
    oil_pressure_kpa: store.oil_pressure_kpa.slice(0, n),

    emotor_powerlevel: store.emotor_powerlevel.slice(0, n),
    hv_battery_charge: store.hv_battery_charge.slice(0, n),
    drive_mode: store.drive_mode.slice(0, n),
    emotor_axle_available: store.emotor_axle_available.slice(0, n),
    emotor_temp_rotor_c: store.emotor_temp_rotor_c.slice(0, n),
    emotor_temp_stator_c: store.emotor_temp_stator_c.slice(0, n),
    engine_temp_coolant_c: store.engine_temp_coolant_c.slice(0, n),
    engine_temp_airintake_c: store.engine_temp_airintake_c.slice(0, n),
    engine_temp_oil_c: store.engine_temp_oil_c.slice(0, n),
    engine_powerlevel: store.engine_powerlevel.slice(0, n),
    outside_air_temp_c: store.outside_air_temp_c.slice(0, n),
    fuel_level_pct: store.fuel_level_pct.slice(0, n),
    hv_battery_temp_avg_c: store.hv_battery_temp_avg_c.slice(0, n),
    hv_battery_temp_max_c: store.hv_battery_temp_max_c.slice(0, n),
    hv_battery_temp_min_c: store.hv_battery_temp_min_c.slice(0, n),
    odometer_km: store.odometer_km.slice(0, n),
    ptm_mode: store.ptm_mode.slice(0, n),
    trans_oil_temp_c: store.trans_oil_temp_c.slice(0, n),
    tire_pressure_fl_kpa: store.tire_pressure_fl_kpa.slice(0, n),
    tire_pressure_fr_kpa: store.tire_pressure_fr_kpa.slice(0, n),
    tire_pressure_rl_kpa: store.tire_pressure_rl_kpa.slice(0, n),
    tire_pressure_rr_kpa: store.tire_pressure_rr_kpa.slice(0, n),
    tire_temp_fl_c: store.tire_temp_fl_c.slice(0, n),
    tire_temp_fr_c: store.tire_temp_fr_c.slice(0, n),
    tire_temp_rl_c: store.tire_temp_rl_c.slice(0, n),
    tire_temp_rr_c: store.tire_temp_rr_c.slice(0, n),
    vse_status: store.vse_status.slice(0, n),
  }
}
