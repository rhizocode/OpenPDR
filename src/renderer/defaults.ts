/**
 * OpenPDR Viewer — Shared default constants
 *
 * Canonical definitions for overlay config, layout, RPM config,
 * gear display mapping, and formatting helpers used across the renderer.
 */

import type { OverlayConfig, OverlayLayout, RpmConfig } from './types'
import { STORAGE_KEYS } from './storage-keys'

// ── Overlay visibility defaults ──

export const DEFAULT_OVERLAY: OverlayConfig = {
  speed: true, rpmGauge: false, rpmBar: true, gear: true, gforce: true,
  pedals: true, steering: true, gps: false, trackMap: true, session: true,
}

// ── Overlay layout positions (% of container dimensions) ──

export const DEFAULT_LAYOUT: OverlayLayout = {
  speed:    { left: 46.41, top: 1.24,  scale: 2.01  },
  rpmGauge: { left: 5.06,  top: 37.52, scale: 1.61  },
  rpmBar:   { left: 26.37, top: 93.62, scale: 2.26  },
  gear:     { left: 56.06, top: 82.32, scale: 1.81  },
  steering: { left: 45.16, top: 71.93, scale: 2.36  },
  gforce:   { left: 88.42, top: 79.60, scale: 1.77  },
  pedals:   { left: 33.76, top: 85.38, scale: 2.00  },
  gps:      { left: 87.17, top: 1.96,  scale: 1     },
  trackMap: { left: 0.59,  top: 1.29,  scale: 1.83  },
  session:  { left: 70.25, top: 1.05,  scale: 2.11  },
}

// ── RPM gauge defaults ──

export const DEFAULT_RPM_CONFIG: RpmConfig = {
  redline: 6500,
  maxRpm: 8500,
}

// ── Gear label → display character ──

export const GEAR_DISPLAY: Record<string, string> = {
  park: 'P', neutral: 'N', reverse: 'R',
  first: '1', second: '2', third: '3',
  fourth: '4', fifth: '5', sixth: '6',
  seventh: '7', eighth: '8', ninth: '9', tenth: '10',
}

/** Resolve a raw gear label to its display character. */
export function resolveGearDisplay(gear: string | undefined): string {
  if (!gear) return '-'
  return GEAR_DISPLAY[gear] ?? gear
}

// ── Brake display mode ──
// Raw CAN bus "brake.position" is pedal travel (0–1). Power-assisted brakes
// mean hard braking rarely exceeds ~40% pedal travel.  "Enhanced" mode scales
// 0–40% to 0–100% with a gamma curve so the overlay reads more like braking
// effort rather than raw pedal travel.  "Raw" mode shows true pedal position.

export type BrakeMode = 'raw' | 'enhanced'

const BRAKE_PEDAL_MAX = 0.40
const BRAKE_GAMMA = 1.5   // >1 compresses low-end, feels more natural

let brakeMode: BrakeMode = (localStorage.getItem(STORAGE_KEYS.brakeMode) as BrakeMode) || 'enhanced'

export function getBrakeMode(): BrakeMode { return brakeMode }

const brakeModeListeners: Array<(mode: BrakeMode) => void> = []

/** Register a callback when brake display mode changes. */
export function onBrakeModeChange(cb: (mode: BrakeMode) => void): void {
  brakeModeListeners.push(cb)
}

export function setBrakeMode(mode: BrakeMode): void {
  brakeMode = mode
  localStorage.setItem(STORAGE_KEYS.brakeMode, mode)
  for (const cb of brakeModeListeners) cb(mode)
}

/**
 * Map raw brake pedal position (0–1) to display value (0–1) based on current mode.
 *   raw:      pass-through (true pedal travel %)
 *   enhanced: (pedal / 0.40)^1.5  clamped to 1 — scales to full range with a
 *             concave curve that compresses the low end so light braking doesn't
 *             look exaggerated while hard braking still reads as 100%.
 */
export function getBrakeDisplay(raw: number): number {
  if (brakeMode === 'raw') return raw
  const t = Math.min(raw / BRAKE_PEDAL_MAX, 1)
  return Math.pow(t, BRAKE_GAMMA)
}

// ── Formatting helpers ──

/** Format seconds as M:SS.mmm */
export function formatLapTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const sFmt = s < 10 ? '0' + s.toFixed(3) : s.toFixed(3)
  return `${m}:${sFmt}`
}

/**
 * Format an ISO 8601 timestamp with offset for display, preserving the
 * recording timezone from the file (avoids Date() local-tz conversion).
 * Input format: "2026-01-13T13:03:28+00:00" (25 bytes from ADOP files).
 */
export function formatTimestamp(timestamp: string): string {
  const m = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/)
  if (m) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const month = months[parseInt(m[2], 10) - 1]
    const day = parseInt(m[3], 10)
    const year = m[1]
    const hour24 = parseInt(m[4], 10)
    const minute = m[5]
    const ampm = hour24 >= 12 ? 'PM' : 'AM'
    const hour12 = hour24 % 12 || 12
    return `${month} ${day}, ${year} ${hour12}:${minute} ${ampm}`
  }
  return timestamp
}
