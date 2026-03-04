/**
 * OpenPDR — Shared type definitions
 *
 * Types used by both the main process (parser) and the renderer.
 * Imported from src/main and src/renderer via relative paths.
 */

/** Full telemetry row at 10 Hz — all decoded channels. */
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
  brake: number       // remapped pedal position (0–1, scaled for display)
  brake_raw: number   // raw pedal position (0–1, true CAN bus value)
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

/** A single detected lap */
export interface LapInfo {
  lapNumber: number
  startTime: number
  endTime: number
  lapTime: number
}

/** GPS trace + bounds for the track layout */
export interface TrackLayout {
  points: Array<{ lat: number; lon: number }>
  startFinishLat: number
  startFinishLon: number
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number }
}

/** Result of lap detection */
export interface LapData {
  laps: LapInfo[]
  trackLayout: TrackLayout | null
  hasLapData: boolean
  detectionMethod?: 'events' | 'gps-density'
}

/** Version info from advi box (crosses IPC boundary in ParseResult) */
export interface AdviInfo {
  formatVersion: number
  generation?: number
  mmpVersion?: number
  source?: string
}

/** Session metadata combined from adop + advi boxes */
export interface SessionInfo {
  vehicle?: string       // e.g. "Chevrolet (Corvette)"
  model?: string         // e.g. "Corvette"
  engine?: string        // e.g. "6.2L V8 (LT2)"
  year?: string          // e.g. "2026"
  timestamp?: string     // ISO 8601 recording start
  generation?: number
  mmpVersion?: number
}

/** Result returned by parsePdrFile() */
export interface ParseResult {
  store: import('./telemetry-store').TelemetryStore
  metadata: {
    fileName: string
    fileSize: number
    sampleCount: number
    duration: number
    adviInfo?: AdviInfo
    sessionInfo?: SessionInfo
    refLocation?: { lat: number; lon: number }
    maxSpeed_kph?: number
    maxRpm?: number
    lapData?: LapData
  }
}

/** Progress callback for reporting parse progress */
export type ProgressCallback = (phase: string, pct: number) => void

/** Export scope — full recording or a specific lap */
export interface ExportScope {
  type: 'full' | 'lap'
  lapNumber?: number  // 1-based, only when type === 'lap'
}

// ── Overlay types (shared for video export) ─────────────────────────────────

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
  session: boolean
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

/** RPM gauge zone configuration */
export interface RpmConfig {
  redline: number
  maxRpm: number
}

/** Options passed from renderer to main for video export */
export interface VideoExportOptions {
  overlayConfig: OverlayConfig
  overlayLayout: OverlayLayout
  rpmConfig: RpmConfig
}

/** Parameters sent from main to renderer to request overlay frame rendering */
export interface RenderOverlayRequest {
  startIdx: number
  endIdx: number
  width: number
  height: number
  fps: number
  totalFrames: number
  overlayConfig: OverlayConfig
  overlayLayout: OverlayLayout
  rpmConfig: RpmConfig
  trackLayout: TrackLayout | null
  sessionInfo?: SessionInfo
}

// ── Auto-update types ────────────────────────────────────────────────────────

/** A single release's changelog entry */
export interface ReleaseNote {
  version: string
  note: string   // HTML content from GitHub Release body
}

/** Update status pushed from main to renderer */
export interface UpdateStatus {
  state: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: ReleaseNote[]
  progress?: number
  error?: string
}

// ── Typed IPC channel map (3.3) ──────────────────────────────────────────────

/** Type-safe mapping of IPC channel names to their argument and return types. */
export interface IpcChannels {
  'open-file-dialog': { args: []; return: string | null }
  'parse-pdr-file': { args: [string]; return: ParseResult }
  'parse-progress': { args: [string, number]; return: void }
  'set-allowed-video-path': { args: [string]; return: void }
  'export-csv': { args: [ExportScope]; return: boolean }
  'export-gpx': { args: [ExportScope]; return: boolean }
  'export-video': { args: [ExportScope, VideoExportOptions]; return: boolean }
  'render-overlay-frames': { args: [RenderOverlayRequest]; return: void }
  'overlay-frame-data': { args: [number, Uint8Array]; return: void }  // invoke-based (backpressure)
  'overlay-frames-done': { args: []; return: void }
  'export-video-progress': { args: [string, number]; return: void }
  'export-video-cancel': { args: []; return: void }
  // Auto-update
  'check-for-updates': { args: []; return: void }
  'download-update': { args: []; return: void }
  'install-update': { args: []; return: void }
  'update-status': { args: [UpdateStatus]; return: void }
  'get-app-version': { args: []; return: string }
}
