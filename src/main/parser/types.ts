/**
 * OpenPDR Telemetry Parser — Type Definitions
 */

/** MP4 box header result */
export interface BoxHeader {
  offset: number
  size: number
  type: string
  headerSize: number
  dataStart: number
}

/** Compact box location: [offset, size, dataStart] */
export type BoxResult = [number, number, number]

/** Track location within the MP4 moov box */
export interface TrackInfo {
  trakOffset: number
  trakSize: number
  trakData: number
  trakEnd: number
}

/** Sample-to-chunk entry from stsc box */
export interface StscEntry {
  firstChunk: number
  samplesPerChunk: number
  descriptionIndex: number
}

/** Parsed sample table */
export interface SampleTable {
  sampleSizes: number[]
  chunkOffsets: number[]
  stscEntries: StscEntry[]
  sampleCount: number
}

/** Rate group from adcr box */
export interface RateGroup {
  period: number
  numChannels: number
  channels: Array<{ channelId: number; width: number }>
  totalWidth: number
}

/** Version info from advi box */
export interface AdviInfo {
  formatVersion: number
  generation?: number
  mmpVersion?: number
  source?: string
}

/** Outing properties from adop box */
export interface AdopProps {
  lat?: number
  lon?: number
}

/** GPS reference bounding box for search narrowing */
export interface GpsRefRange {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
}

/**
 * Full telemetry row at 10 Hz — all decoded channels.
 * Sparse fields (5Hz, 2Hz, 1Hz) are undefined when not sampled in that frame.
 * The renderer carries forward the last known value for display.
 */
export interface TelemetryRow {
  // Timing
  time: number
  packetIdx: number
  frameIdx: number

  // GPS (10 Hz)
  lat: number
  lon: number
  altitude_m: number
  heading_deg: number
  speed_kph: number
  speed_mph: number
  speed_mps: number
  gps_fix_quality: number
  gps_satellites: number

  // 10 Hz vehicle
  throttle: number
  abs_status: number
  abs_status_label: string
  boost_pressure_kpa: number
  emotor_power_kw: number
  engine_power_kw: number

  // 100 Hz (averaged per 10 Hz period)
  brake: number
  rpm: number
  engine_torque_nm: number
  steering_deg: number
  gyro_yaw_deg_s: number
  wheel_speed_fl_kph: number
  wheel_speed_fr_kph: number
  wheel_speed_rl_kph: number
  wheel_speed_rr_kph: number

  // 50 Hz accelerometer (averaged)
  gforce_lat: number
  gforce_lon: number
  gforce_vert: number

  // 5 Hz (even frames only)
  gear?: string
  gear_raw?: number
  engine_startstop?: string
  esc_status?: string
  tcs_status?: string

  // 2 Hz (frames 0, 5)
  oil_pressure_kpa?: number

  // 1 Hz (frame 0 only)
  emotor_powerlevel?: number
  hv_battery_charge?: number
  drive_mode?: string
  emotor_axle_available?: string
  emotor_temp_rotor_c?: number | null
  emotor_temp_stator_c?: number | null
  engine_temp_coolant_c?: number
  engine_temp_airintake_c?: number
  engine_temp_oil_c?: number
  engine_powerlevel?: number
  outside_air_temp_c?: number
  fuel_level_pct?: number
  hv_battery_temp_avg_c?: number | null
  hv_battery_temp_max_c?: number | null
  hv_battery_temp_min_c?: number | null
  odometer_km?: number
  ptm_mode?: string
  trans_oil_temp_c?: number
  tire_pressure_fl_kpa?: number
  tire_pressure_fr_kpa?: number
  tire_pressure_rl_kpa?: number
  tire_pressure_rr_kpa?: number
  tire_temp_fl_c?: number
  tire_temp_fr_c?: number
  tire_temp_rl_c?: number
  tire_temp_rr_c?: number
  vse_status?: string
}

/** Result returned by parsePdrFile() */
export interface ParseResult {
  rows: TelemetryRow[]
  metadata: {
    fileName: string
    fileSize: number
    sampleCount: number
    duration: number
    adviInfo?: AdviInfo
    refLocation?: { lat: number; lon: number }
    maxSpeed_kph?: number
    maxRpm?: number
  }
}

/** Progress callback for reporting parse progress */
export type ProgressCallback = (phase: string, pct: number) => void
