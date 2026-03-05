/**
 * OpenPDR — GPX Export
 *
 * Streams GPS telemetry from a TelemetryStore to a GPX 1.1 XML file.
 * Skips points with no GPS fix (fix_quality === 0 or lat === 0).
 */

import { createWriteStream } from 'fs'
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
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
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
 * Export GPS trace [startIdx, endIdx) to a GPX 1.1 file.
 * Points with no fix are skipped.
 */
export function exportGpx(
  store: TelemetryStore,
  filePath: string,
  startIdx: number,
  endIdx: number,
  trackName: string,
  baseDate: Date
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(filePath, { encoding: 'utf8' })
    ws.on('error', reject)
    ws.on('finish', resolve)

    const baseMs = baseDate.getTime()

    // Write preamble
    ws.write(GPX_HEADER)
    ws.write(`  <metadata><name>${escapeXml(trackName)}</name></metadata>\n`)
    ws.write(`  <trk>\n`)
    ws.write(`  <name>${escapeXml(trackName)}</name>\n`)
    ws.write(`  <trkseg>\n`)

    let i = startIdx

    function writeBatch(): void {
      let ok = true
      while (i < endIdx && ok) {
        const batchEnd = Math.min(i + BATCH_SIZE, endIdx)
        const chunks: string[] = []
        for (; i < batchEnd; i++) {
          // Skip invalid GPS points
          if (store.gps_fix_quality[i] === 0 || store.lat[i] === 0) continue

          chunks.push(formatTrkpt(
            store.lat[i],
            store.lon[i],
            store.altitude_m[i],
            formatIsoTime(baseMs, store.time[i]),
            store.speed_kph[i],
            store.heading_deg[i]
          ))
        }
        if (chunks.length > 0) {
          ok = ws.write(chunks.join(''))
        }
      }
      if (i >= endIdx) {
        ws.write(GPX_FOOTER)
        ws.end()
      } else {
        ws.once('drain', writeBatch)
      }
    }

    writeBatch()
  })
}
