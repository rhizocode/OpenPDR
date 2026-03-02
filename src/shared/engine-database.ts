/**
 * OpenPDR — Engine database for automatic redline detection
 *
 * Maps GM engine codes found in PDR session metadata to their
 * tachometer redline RPM. Covers all Gen 2 PDR-equipped vehicles.
 */

import type { RpmConfig } from './types'

export interface EngineSpec {
  code: string      // RPO code, e.g. "LT2"
  redline: number   // tach redline RPM
  maxRpm: number    // tach gauge max (from real instrument cluster)
  label: string     // display string for settings UI
}

// maxRpm sets where the arc ends.  Redline should sit at roughly 75% of the
// sweep so the red zone is large enough to be clearly visible on the small gauge.
export const ENGINE_DATABASE: readonly EngineSpec[] = [
  { code: 'LT2', redline: 6500, maxRpm: 8500,  label: 'LT2 \u2014 6.2L V8' },
  { code: 'LT6', redline: 8600, maxRpm: 11000, label: 'LT6 \u2014 5.5L V8' },
  { code: 'LT7', redline: 8000, maxRpm: 10500, label: 'LT7 \u2014 5.5L TT V8' },
  { code: 'LT4', redline: 6500, maxRpm: 8500,  label: 'LT4 \u2014 6.2L SC V8' },
  { code: 'LF4', redline: 6500, maxRpm: 8500,  label: 'LF4 \u2014 3.6L TT V6' },
  { code: 'LGY', redline: 6500, maxRpm: 8500,  label: 'LGY \u2014 3.0L TT V6' },
  { code: 'L3B', redline: 6000, maxRpm: 8000,  label: 'L3B \u2014 2.7L T I4' },
]

/**
 * Match a SessionInfo.engine string (e.g. "6.2L V8 (LT2)") against the
 * database. Performs a case-insensitive substring search for each engine code.
 */
export function detectEngine(engineString: string | undefined): EngineSpec | null {
  if (!engineString) return null
  const upper = engineString.toUpperCase()
  for (const spec of ENGINE_DATABASE) {
    if (upper.includes(spec.code)) return spec
  }
  return null
}

/** Convert an EngineSpec to the RpmConfig used by the gauge renderer. */
export function engineToRpmConfig(spec: EngineSpec): RpmConfig {
  return { redline: spec.redline, maxRpm: spec.maxRpm }
}
