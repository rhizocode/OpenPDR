/**
 * OpenPDR Telemetry Parser — Scale Factors and Enum Mappings
 * Ported from alivedrive_parser.py (Cosworth adcp box definitions)
 */

// GPS & angle
export const GPS_SCALE = 1.7453293e-09
export const DEG_SCALE = GPS_SCALE * (180.0 / Math.PI)
export const ALT_SCALE = 0.001
export const HEADING_SCALE = 1.745329252e-07
export const HEADING_DEG_SCALE = HEADING_SCALE * (180.0 / Math.PI)

// Speed
export const SPEED_SCALE = 0.00434028

// Engine
export const ENGINE_SPEED_SCALE = 0.0261799388
export const TORQUE_SCALE = 0.5
export const TORQUE_OFFSET = -848.0

// Steering
export const STEERING_SCALE = 0.001090831

// Wheels
export const WHEEL_SPEED_SCALE = 0.0251327412
export const TIRE_RADIUS_M = 0.321

// Proportions
export const PROPORTION_SCALE = 1.0 / 255.0

// Pressures
export const OIL_PRESSURE_SCALE = 4000
export const BOOST_PRESSURE_SCALE = 1000
export const TIRE_PRESSURE_SCALE = 4000

// Power
export const POWER_SCALE = 500

// Fuel level
export const FUEL_LEVEL_SCALE = 0.003921

// Odometer
export const ODOMETER_SCALE = 15.625

// Gyro yaw rate
export const GYRO_YAW_SCALE = 0.00041887902

// Conversion helpers
export const RAD_TO_RPM = 60.0 / (2.0 * Math.PI)
export const MPS_TO_KPH = 3.6
export const MPS_TO_MPH = 2.23694
export const RAD_TO_DEG = 180.0 / Math.PI

// ─── Enum mappings ───

export const ENUM_ABS: Record<number, string> = {
  0: 'inactive',
  1: 'active',
  3: 'unknown',
}

export const ENUM_GEAR: Record<number, string> = {
  0: 'notsupported',
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  6: 'sixth',
  7: 'seventh',
  8: 'eighth',
  9: 'ninth',
  10: 'tenth',
  11: 'unused',
  12: 'cvtforward',
  13: 'neutral',
  14: 'reverse',
  15: 'park',
}

export const ENUM_DRIVE_MODE: Record<number, string> = {
  0: 'none',
  1: 'tour',
  2: 'sport',
  3: 'track',
  4: 'winter',
  5: 'offroad',
  6: 'towhaul',
  7: 'hold',
  8: 'mountain',
  9: 'personal',
  10: 'custom',
  11: 'awd',
  12: 'economy',
  13: 'automatic',
  14: 'ev',
  15: 'gradebraking',
  16: 'exhaustbrake',
  17: 'activerevmatch',
  18: '2wd',
  19: 'comfort',
  20: 'startstopdisable',
  21: 'crawl',
  22: 'chargeplus',
  23: 'baja',
  24: 'maxpower',
}

export const ENUM_EMOTOR_AXLE: Record<number, string> = {
  0: 'notavailable',
  1: 'available',
  3: 'unknown',
}

export const ENUM_ENGINE_STARTSTOP: Record<number, string> = {
  0: 'engineoff',
  1: 'enginerunning',
  2: 'enginestarting',
  3: 'enginestopping',
  7: 'unknown',
}

export const ENUM_ESC: Record<number, string> = {
  0: 'inactive',
  1: 'active',
  3: 'unknown',
}

export const ENUM_PTM: Record<number, string> = {
  0: 'disabled',
  1: 'wet',
  2: 'dry',
  3: 'sport1',
  4: 'sport2',
  5: 'race',
  6: 'inactive',
  7: 'unknown',
}

export const ENUM_TCS: Record<number, string> = {
  0: 'inactive',
  1: 'active',
  3: 'unknown',
}

// NOTE: VSE has OPPOSITE polarity from ABS/ESC/TCS (0 = active, 1 = inactive)
export const ENUM_VSE: Record<number, string> = {
  0: 'active',
  1: 'inactive',
  3: 'unknown',
}

/** Consolidated lookup: field name → enum dict */
export const ENUM_LABELS: Record<string, Record<number, string>> = {
  abs_status: ENUM_ABS,
  gear: ENUM_GEAR,
  drive_mode: ENUM_DRIVE_MODE,
  emotor_axle_available: ENUM_EMOTOR_AXLE,
  engine_startstop: ENUM_ENGINE_STARTSTOP,
  esc_status: ENUM_ESC,
  ptm_mode: ENUM_PTM,
  tcs_status: ENUM_TCS,
  vse_status: ENUM_VSE,
}

export function enumLabel(fieldName: string, rawValue: number): string {
  const mapping = ENUM_LABELS[fieldName]
  if (!mapping) return String(rawValue)
  return mapping[rawValue] ?? `unknown_${rawValue}`
}
