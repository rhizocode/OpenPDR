/**
 * OpenPDR — Marlin Unit Conversion & Channel Mapping
 *
 * Two-stage conversion: raw → SI (via mrld multiplier/offset) → display units
 * (via unit scale/offset tables).
 *
 * Channel name → TelemetryStore field mapping for writing decoded values
 * into the shared columnar store.
 *
 * Ported from protocol/marlin_parser.py (UNIT_SCALE, UNIT_OFFSET, convert).
 */

import type { MarlinChannel } from '../types'
import type { TelemetryStore } from '../../shared/telemetry-store'

// ── Unit conversion tables (SI → display) ──────────────────────────────────

/** Multiplier to convert from SI base unit to the display unit. */
const UNIT_SCALE: Record<string, number> = {
  '°C':    1.0,
  'G':     1 / 9.80665,
  'kph':   3.6,
  '°':     180 / Math.PI,
  '°/s':   180 / Math.PI,
  '°/sec': 180 / Math.PI,
  '%':     100,
  'kPa':   1 / 1000,
  'rpm':   10,         // Cosworth RPM encoding quirk
  'km':    1 / 1000,
  'ltr':   1000,
  'mm':    1000,
}

/** Offset to add after scaling (e.g. Kelvin → Celsius). */
const UNIT_OFFSET: Record<string, number> = {
  '°C': -273.15,
}

/**
 * Convert a raw integer value to display units using the channel's
 * multiplier/offset and the unit scale/offset tables.
 *
 * display = raw × multiplier × unitScale + offset × unitScale + unitOffset
 */
export function convertRaw(raw: number, ch: MarlinChannel): number {
  const scale = UNIT_SCALE[ch.units] ?? 1.0
  const uOffset = UNIT_OFFSET[ch.units] ?? 0.0
  return raw * ch.multiplier * scale + ch.offset * scale + uOffset
}

// ── Gear labels (same encoding as AliveDrive) ──────────────────────────────

const GEAR_LABELS: Record<number, string> = {
  0: 'unknown', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6',
  7: '7', 8: '8', 9: '9', 10: '10', 11: '11', 12: '12',
  13: 'N', 14: 'R', 15: 'P',
}

// ── Channel mapping: Marlin channel name → TelemetryStore writer ────────────

/**
 * A writer function that stores a converted display value into the
 * TelemetryStore at a given row index.
 */
type ChannelWriter = (store: TelemetryStore, index: number, displayValue: number) => void

/** Map from Marlin channel name (as found in mrld) to store writer. */
const CHANNEL_MAP = new Map<string, ChannelWriter>()

// Helper to register a channel mapping
function reg(name: string, writer: ChannelWriter): void {
  CHANNEL_MAP.set(name, writer)
}

// ── Dense channels (typed arrays) ──

reg('RPM', (s, i, v) => { s.rpm[i] = v })
reg('Speed', (s, i, v) => {
  s.speed_kph[i] = v
  s.speed_mph[i] = v / 1.609344
  s.speed_mps[i] = v / 3.6
})
reg('Accelerator', (s, i, v) => { s.throttle[i] = v / 100 }) // % → 0-1
reg('Brake Pos', (s, i, v) => {
  const frac = v / 100 // % → 0-1
  s.brake[i] = frac
  s.brake_raw[i] = frac
})
reg('Steering Angle', (s, i, v) => { s.steering_deg[i] = -v })
reg('Lateral Acceleration', (s, i, v) => { s.gforce_lat[i] = v })
reg('Longitudinal Acceleration', (s, i, v) => { s.gforce_lon[i] = v })
reg('Vertical Acceleration', (s, i, v) => { s.gforce_vert[i] = v })
reg('Latitude', (s, i, v) => { s.lat[i] = v })
reg('Longitude', (s, i, v) => { s.lon[i] = v })
reg('Altitude', (s, i, v) => { s.altitude_m[i] = v })
reg('Heading', (s, i, v) => { s.heading_deg[i] = v })
reg('GPS Fix', (s, i, v) => { s.gps_fix_quality[i] = v })
reg('GPS Precision', (_s, _i, _v) => { /* no matching store field */ })
reg('Number of Satellites', (s, i, v) => { s.gps_satellites[i] = v })
reg('Yaw Rate', (s, i, v) => { s.gyro_yaw_deg_s[i] = v })
reg('Wheel Speed Left Front', (s, i, v) => { s.wheel_speed_fl_kph[i] = v })
reg('Wheel Speed Right Front', (s, i, v) => { s.wheel_speed_fr_kph[i] = v })
reg('Wheel Speed Left Rear', (s, i, v) => { s.wheel_speed_rl_kph[i] = v })
reg('Wheel Speed Right Rear', (s, i, v) => { s.wheel_speed_rr_kph[i] = v })
reg('Intake Boost Pressure', (s, i, v) => { s.boost_pressure_kpa[i] = v })
reg('Engine Power', (s, i, v) => { s.engine_power_kw[i] = v })
reg('Electric Motor Power', (s, i, v) => { s.emotor_power_kw[i] = v })
reg('Engine Torque', (s, i, v) => { s.engine_torque_nm[i] = v })

// ── Sparse channels (regular arrays) ──

reg('Gear', (s, i, v) => {
  const raw = Math.round(v)
  s.gear_raw[i] = raw
  s.gear[i] = GEAR_LABELS[raw] ?? String(raw)
})
reg('Oil Pressure', (s, i, v) => { s.oil_pressure_kpa[i] = v })
reg('Coolant Temp', (s, i, v) => { s.engine_temp_coolant_c[i] = v })
reg('Oil Temp', (s, i, v) => { s.engine_temp_oil_c[i] = v })
reg('Trans Oil Temp', (s, i, v) => { s.trans_oil_temp_c[i] = v })
reg('Fuel Level', (s, i, v) => { s.fuel_level_pct[i] = v })
reg('Distance', (s, i, v) => { s.odometer_km[i] = v })
reg('Outside Air Temperature', (s, i, v) => { s.outside_air_temp_c[i] = v })
reg('Intake Air Temperature', (s, i, v) => { s.engine_temp_airintake_c[i] = v })
reg('ABS Active', (s, i, v) => {
  const active = Math.round(v)
  s.abs_status[i] = active
  s.abs_status_label[i] = active ? 'active' : 'inactive'
})
reg('Traction Control Active', (s, i, v) => {
  s.tcs_status[i] = Math.round(v) ? 'active' : 'inactive'
})
reg('Vehicle Stability Active', (s, i, v) => {
  s.vse_status[i] = Math.round(v) ? 'active' : 'inactive'
})
reg('Performance Traction Management', (s, i, v) => {
  s.ptm_mode[i] = String(Math.round(v))
})
reg('Driver Performance Mode', (s, i, v) => {
  s.drive_mode[i] = String(Math.round(v))
})

// Tyre pressures (Marlin names use "Tyre" not "Tire")
reg('LF Tyre Pressure', (s, i, v) => { s.tire_pressure_fl_kpa[i] = v })
reg('RF Tyre Pressure', (s, i, v) => { s.tire_pressure_fr_kpa[i] = v })
reg('LR Tyre Pressure', (s, i, v) => { s.tire_pressure_rl_kpa[i] = v })
reg('RR Tyre Pressure', (s, i, v) => { s.tire_pressure_rr_kpa[i] = v })

// Tyre temps
reg('LF Tyre Temp', (s, i, v) => { s.tire_temp_fl_c[i] = v })
reg('RF Tyre Temp', (s, i, v) => { s.tire_temp_fr_c[i] = v })
reg('LR Tyre Temp', (s, i, v) => { s.tire_temp_rl_c[i] = v })
reg('RR Tyre Temp', (s, i, v) => { s.tire_temp_rr_c[i] = v })

// Electric vehicle channels
reg('Electric Motor Torque', (_s, _i, _v) => { /* no matching store field for emotor torque */ })
reg('Customer Usable State of Charge', (s, i, v) => { s.hv_battery_charge[i] = v })
reg('Electric Axle Available', (s, i, v) => {
  s.emotor_axle_available[i] = Math.round(v) ? 'available' : 'unavailable'
})
reg('Electric Axle Available Indication On', (s, i, v) => {
  s.emotor_axle_available[i] = Math.round(v) ? 'available' : 'unavailable'
})
reg('Engine Start Stop State', (s, i, v) => {
  s.engine_startstop[i] = String(Math.round(v))
})
reg('Engine Power Level %', (s, i, v) => { s.engine_powerlevel[i] = v })
reg('Engine Propulsion Display Power Level Percent', (s, i, v) => { s.engine_powerlevel[i] = v })
reg('Battery Power Level %', (s, i, v) => { s.emotor_powerlevel[i] = v })
reg('Battery Propulsion Display Power Level Percent', (s, i, v) => { s.emotor_powerlevel[i] = v })
reg('Battery Voltage', (_s, _i, _v) => { /* no matching store field yet */ })
reg('High Voltage Battery Average Temperature', (s, i, v) => { s.hv_battery_temp_avg_c[i] = v })
reg('High Voltage Battery Minimum Temperature', (s, i, v) => { s.hv_battery_temp_min_c[i] = v })
reg('High Voltage Battery Maximum Temperature', (s, i, v) => { s.hv_battery_temp_max_c[i] = v })
reg('Electric Motor Stator Temperature', (s, i, v) => { s.emotor_temp_stator_c[i] = v })
reg('Electric Motor Rotor Temperature', (s, i, v) => { s.emotor_temp_rotor_c[i] = v })

// Channels we intentionally skip (system metrics, no UI)
reg('Boost Pressure Ind', (_s, _i, _v) => { /* already have Intake Boost Pressure */ })
reg('Recording Event Odometer', (_s, _i, _v) => {})
reg('Temperature Multimedia Processor', (_s, _i, _v) => {})
reg('Temperature Internal Board', (_s, _i, _v) => {})
reg('Temperature Camera Module', (_s, _i, _v) => {})

/** Get the channel writer for a Marlin channel name. Returns undefined for unmapped channels. */
export function getChannelWriter(name: string): ChannelWriter | undefined {
  return CHANNEL_MAP.get(name)
}
