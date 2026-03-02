/**
 * OpenPDR — Browser GPX Export
 *
 * Generates GPX 1.1 XML as a Blob for browser download.
 * Uses the same format as the Node.js version.
 */

import type { TelemetryStore } from '../shared/telemetry-store'

const BATCH_SIZE = 2000

const GPX_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="OpenPDR Viewer"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns:openpdr="http://openpdr.org/gpx/1/0"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
`

const GPX_FOOTER = `  </trkseg>
  </trk>
</gpx>
`

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatIsoTime(baseMs: number, offsetSeconds: number): string {
  return new Date(baseMs + offsetSeconds * 1000).toISOString()
}

function formatTrkpt(
  lat: number, lon: number, ele: number,
  timeIso: string, speedKph: number, headingDeg: number
): string {
  return `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">
      <ele>${ele.toFixed(1)}</ele>
      <time>${timeIso}</time>
      <extensions>
        <openpdr:speed_kph>${speedKph.toFixed(1)}</openpdr:speed_kph>
        <openpdr:heading_deg>${headingDeg.toFixed(1)}</openpdr:heading_deg>
      </extensions>
    </trkpt>\n`
}

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

  for (let i = startIdx; i < endIdx; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, endIdx)
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
