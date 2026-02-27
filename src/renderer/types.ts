/**
 * OpenPDR Viewer — Shared type definitions
 *
 * All interfaces used across renderer modules. Standard Web APIs only
 * (no Electron/Node imports) for future PWA portability.
 */

export interface LapInfo {
  lapNumber: number
  startTime: number
  endTime: number
  lapTime: number
}

export interface TrackLayout {
  points: Array<{ lat: number; lon: number }>
  startFinishLat: number
  startFinishLon: number
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number }
}

export interface LapData {
  laps: LapInfo[]
  trackLayout: TrackLayout | null
  hasLapData: boolean
}

export interface ParseResult {
  rows: TelemetryRow[]
  metadata: {
    fileName: string
    fileSize: number
    sampleCount: number
    duration: number
    maxSpeed_kph?: number
    maxRpm?: number
    lapData?: LapData
  }
}

export interface TelemetryRow {
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
  // 100 Hz averaged
  brake: number
  rpm: number
  engine_torque_nm: number
  steering_deg: number
  gyro_yaw_deg_s: number
  wheel_speed_fl_kph: number
  wheel_speed_fr_kph: number
  wheel_speed_rl_kph: number
  wheel_speed_rr_kph: number
  // 50 Hz averaged
  gforce_lat: number
  gforce_lon: number
  gforce_vert: number
  // 5 Hz (sparse)
  gear?: string
  gear_raw?: number
  engine_startstop?: string
  esc_status?: string
  tcs_status?: string
  // 2 Hz
  oil_pressure_kpa?: number
  // 1 Hz (all optional)
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

export interface PdrApi {
  openFileDialog(): Promise<string | null>
  parsePdrFile(filePath: string): Promise<ParseResult>
  onParseProgress(callback: (phase: string, pct: number) => void): void
  getVideoUrl(filePath: string): string
}

declare global {
  interface Window { pdr: PdrApi }
}

/** Overlay visibility configuration */
export interface OverlayConfig {
  speed: boolean
  rpmGauge: boolean
  gear: boolean
  gforce: boolean
  pedals: boolean
  steering: boolean
  gps: boolean
  trackMap: boolean
}

/** RPM gauge zone configuration */
export interface RpmConfig {
  yellowStart: number
  redline: number
  maxRpm: number
}

/** Overlay key — matches keys of OverlayConfig */
export type OverlayKey = keyof OverlayConfig

/** Position + scale for a single overlay element (% of video-container) */
export interface OverlayPosition {
  left: number
  top: number
  scale: number
}

/** Stored layout for all overlay elements */
export type OverlayLayout = Record<OverlayKey, OverlayPosition>
