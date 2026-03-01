/**
 * OpenPDR — CSV Export
 *
 * Streams telemetry data from a TelemetryStore to a CSV file.
 * Reads directly from columnar arrays — no per-row object allocation.
 */

import { createWriteStream } from 'fs'
import type { TelemetryStore } from '../shared/telemetry-store'

/** Column definition: name + accessor that returns a CSV-safe string. */
interface Column {
  name: string
  get: (store: TelemetryStore, i: number) => string
}

/** Accessor for typed arrays (always populated, numeric). */
const num = (key: keyof TelemetryStore) =>
  (store: TelemetryStore, i: number) => (store[key] as ArrayLike<number>)[i].toString()

/** Accessor for sparse number arrays (may be undefined or null). */
const sparse = (key: keyof TelemetryStore) =>
  (store: TelemetryStore, i: number) => {
    const v = (store[key] as Array<number | null | undefined>)[i]
    return v == null ? '' : v.toString()
  }

/** Accessor for sparse string arrays (may be undefined). */
const str = (key: keyof TelemetryStore) =>
  (store: TelemetryStore, i: number) => (store[key] as Array<string | undefined>)[i] ?? ''

const COLUMNS: Column[] = [
  // Timing
  { name: 'time',               get: num('time') },
  { name: 'packetIdx',          get: num('packetIdx') },
  { name: 'frameIdx',           get: num('frameIdx') },

  // GPS 10 Hz
  { name: 'lat',                get: num('lat') },
  { name: 'lon',                get: num('lon') },
  { name: 'altitude_m',         get: num('altitude_m') },
  { name: 'heading_deg',        get: num('heading_deg') },
  { name: 'speed_kph',          get: num('speed_kph') },
  { name: 'speed_mph',          get: num('speed_mph') },
  { name: 'speed_mps',          get: num('speed_mps') },
  { name: 'gps_fix_quality',    get: num('gps_fix_quality') },
  { name: 'gps_satellites',     get: num('gps_satellites') },

  // 10 Hz vehicle
  { name: 'throttle',           get: num('throttle') },
  { name: 'abs_status',         get: num('abs_status') },
  { name: 'abs_status_label',   get: str('abs_status_label') },
  { name: 'boost_pressure_kpa', get: num('boost_pressure_kpa') },
  { name: 'emotor_power_kw',    get: num('emotor_power_kw') },
  { name: 'engine_power_kw',    get: num('engine_power_kw') },

  // 100 Hz averaged
  { name: 'brake',              get: num('brake') },
  { name: 'brake_raw',          get: num('brake_raw') },
  { name: 'rpm',                get: num('rpm') },
  { name: 'engine_torque_nm',   get: num('engine_torque_nm') },
  { name: 'steering_deg',       get: num('steering_deg') },
  { name: 'gyro_yaw_deg_s',     get: num('gyro_yaw_deg_s') },
  { name: 'wheel_speed_fl_kph', get: num('wheel_speed_fl_kph') },
  { name: 'wheel_speed_fr_kph', get: num('wheel_speed_fr_kph') },
  { name: 'wheel_speed_rl_kph', get: num('wheel_speed_rl_kph') },
  { name: 'wheel_speed_rr_kph', get: num('wheel_speed_rr_kph') },

  // 50 Hz averaged
  { name: 'gforce_lat',         get: num('gforce_lat') },
  { name: 'gforce_lon',         get: num('gforce_lon') },
  { name: 'gforce_vert',        get: num('gforce_vert') },

  // Sparse channels
  { name: 'gear',               get: str('gear') },
  { name: 'gear_raw',           get: sparse('gear_raw') },
  { name: 'engine_startstop',   get: str('engine_startstop') },
  { name: 'esc_status',         get: str('esc_status') },
  { name: 'tcs_status',         get: str('tcs_status') },
  { name: 'oil_pressure_kpa',   get: sparse('oil_pressure_kpa') },

  // 1 Hz sparse
  { name: 'emotor_powerlevel',      get: sparse('emotor_powerlevel') },
  { name: 'hv_battery_charge',      get: sparse('hv_battery_charge') },
  { name: 'drive_mode',             get: str('drive_mode') },
  { name: 'emotor_axle_available',  get: str('emotor_axle_available') },
  { name: 'emotor_temp_rotor_c',    get: sparse('emotor_temp_rotor_c') },
  { name: 'emotor_temp_stator_c',   get: sparse('emotor_temp_stator_c') },
  { name: 'engine_temp_coolant_c',  get: sparse('engine_temp_coolant_c') },
  { name: 'engine_temp_airintake_c', get: sparse('engine_temp_airintake_c') },
  { name: 'engine_temp_oil_c',      get: sparse('engine_temp_oil_c') },
  { name: 'engine_powerlevel',      get: sparse('engine_powerlevel') },
  { name: 'outside_air_temp_c',     get: sparse('outside_air_temp_c') },
  { name: 'fuel_level_pct',         get: sparse('fuel_level_pct') },
  { name: 'hv_battery_temp_avg_c',  get: sparse('hv_battery_temp_avg_c') },
  { name: 'hv_battery_temp_max_c',  get: sparse('hv_battery_temp_max_c') },
  { name: 'hv_battery_temp_min_c',  get: sparse('hv_battery_temp_min_c') },
  { name: 'odometer_km',            get: sparse('odometer_km') },
  { name: 'ptm_mode',               get: str('ptm_mode') },
  { name: 'trans_oil_temp_c',       get: sparse('trans_oil_temp_c') },
  { name: 'tire_pressure_fl_kpa',   get: sparse('tire_pressure_fl_kpa') },
  { name: 'tire_pressure_fr_kpa',   get: sparse('tire_pressure_fr_kpa') },
  { name: 'tire_pressure_rl_kpa',   get: sparse('tire_pressure_rl_kpa') },
  { name: 'tire_pressure_rr_kpa',   get: sparse('tire_pressure_rr_kpa') },
  { name: 'tire_temp_fl_c',         get: sparse('tire_temp_fl_c') },
  { name: 'tire_temp_fr_c',         get: sparse('tire_temp_fr_c') },
  { name: 'tire_temp_rl_c',         get: sparse('tire_temp_rl_c') },
  { name: 'tire_temp_rr_c',         get: sparse('tire_temp_rr_c') },
  { name: 'vse_status',             get: str('vse_status') },
]

const HEADER = COLUMNS.map(c => c.name).join(',') + '\n'
const COL_COUNT = COLUMNS.length
const BATCH_SIZE = 2000

function formatRow(store: TelemetryStore, i: number): string {
  const vals = new Array<string>(COL_COUNT)
  for (let c = 0; c < COL_COUNT; c++) {
    vals[c] = COLUMNS[c].get(store, i)
  }
  return vals.join(',')
}

/**
 * Export telemetry rows [startIdx, endIdx) to a CSV file.
 * Uses streaming writes with backpressure handling.
 */
export function exportCsv(
  store: TelemetryStore,
  filePath: string,
  startIdx: number,
  endIdx: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(filePath, { encoding: 'utf8' })
    ws.on('error', reject)
    ws.on('finish', resolve)

    ws.write(HEADER)

    let i = startIdx

    function writeBatch(): void {
      let ok = true
      while (i < endIdx && ok) {
        const batchEnd = Math.min(i + BATCH_SIZE, endIdx)
        const lines: string[] = []
        for (; i < batchEnd; i++) {
          lines.push(formatRow(store, i))
        }
        ok = ws.write(lines.join('\n') + '\n')
      }
      if (i >= endIdx) {
        ws.end()
      } else {
        ws.once('drain', writeBatch)
      }
    }

    writeBatch()
  })
}
