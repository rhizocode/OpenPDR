/**
 * OpenPDR — GPX Export (Electron / Node.js)
 *
 * Streams GPS telemetry from a TelemetryStore to a GPX 1.1 XML file.
 * Format helpers are shared with the browser export via export-gpx-format.ts.
 */

import { createWriteStream } from 'fs'
import type { TelemetryStore } from '../shared/telemetry-store'
import { GPX_HEADER, GPX_FOOTER, GPX_BATCH_SIZE, escapeXml, formatIsoTime, formatTrkpt } from '../shared/export-gpx-format'

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

    // Write preamble — destroy stream on failure to avoid leaking the file handle
    try {
      ws.write(GPX_HEADER)
      ws.write(`  <metadata><name>${escapeXml(trackName)}</name></metadata>\n`)
      ws.write(`  <trk>\n`)
      ws.write(`  <name>${escapeXml(trackName)}</name>\n`)
      ws.write(`  <trkseg>\n`)
    } catch (err) {
      ws.destroy()
      reject(err as Error)
      return
    }

    let i = startIdx

    function writeBatch(): void {
      let ok = true
      while (i < endIdx && ok) {
        const batchEnd = Math.min(i + GPX_BATCH_SIZE, endIdx)
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
