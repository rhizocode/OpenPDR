/**
 * OpenPDR Viewer — Shared default constants
 *
 * Canonical definitions for overlay config, layout, RPM config,
 * gear display mapping, and formatting helpers used across the renderer.
 */

import type { OverlayConfig, OverlayLayout, RpmConfig } from './types'

// ── Overlay visibility defaults ──

export const DEFAULT_OVERLAY: OverlayConfig = {
  speed: true, rpmGauge: true, rpmBar: false, gear: true, gforce: true,
  pedals: true, steering: true, gps: true, trackMap: true, session: true,
}

// ── Overlay layout positions (% of container dimensions) ──

export const DEFAULT_LAYOUT: OverlayLayout = {
  speed:    { left: 1.5, top: 82, scale: 1 },
  rpmGauge: { left: 13,  top: 78, scale: 1 },
  rpmBar:   { left: 1.5, top: 95, scale: 1 },
  gear:     { left: 27,  top: 82, scale: 1 },
  steering: { left: 33,  top: 76, scale: 1 },
  gforce:   { left: 82,  top: 68, scale: 1 },
  pedals:   { left: 68,  top: 84, scale: 1 },
  gps:      { left: 85,  top: 2,  scale: 1 },
  trackMap: { left: 1.5, top: 2,  scale: 1 },
  session:  { left: 85,  top: 12, scale: 1 },
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
