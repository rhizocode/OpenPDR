/**
 * OpenPDR — Browser GPX Export
 *
 * Generates GPX 1.1 XML as a Blob for browser download.
 * Format helpers are shared with the Electron export via export-gpx-format.ts.
 */

import type { TelemetryStore } from '../shared/telemetry-store'
import { GPX_HEADER, GPX_FOOTER, GPX_BATCH_SIZE, escapeXml, formatIsoTime, formatTrkpt } from '../shared/export-gpx-format'

/**
 * Export GPS trace [startIdx, endIdx) to a GPX 1.1 Blob.
 * Points with no fix are skipped.
 */
export function exportGpxBlob(
  store: TelemetryStore,
  startIdx: number,
  endIdx: number,
  trackName: string,
  baseDate: Date
): Blob {
  const baseMs = baseDate.getTime()
  const parts: string[] = []

  parts.push(GPX_HEADER)
  parts.push(`  <metadata><name>${escapeXml(trackName)}</name></metadata>\n`)
  parts.push(`  <trk>\n`)
  parts.push(`  <name>${escapeXml(trackName)}</name>\n`)
  parts.push(`  <trkseg>\n`)

  for (let i = startIdx; i < endIdx; i += GPX_BATCH_SIZE) {
    const batchEnd = Math.min(i + GPX_BATCH_SIZE, endIdx)
    for (let j = i; j < batchEnd; j++) {
      if (store.gps_fix_quality[j] === 0 || store.lat[j] === 0) continue

      parts.push(formatTrkpt(
        store.lat[j],
        store.lon[j],
        store.altitude_m[j],
        formatIsoTime(baseMs, store.time[j]),
        store.speed_kph[j],
        store.heading_deg[j]
      ))
    }
  }

  parts.push(GPX_FOOTER)

  return new Blob(parts, { type: 'application/gpx+xml' })
}
