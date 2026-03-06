/**
 * OpenPDR — CSV Export (Electron / Node.js)
 *
 * Streams telemetry data from a TelemetryStore to a CSV file.
 * Column definitions are shared with the browser export via export-columns.ts.
 */

import { createWriteStream } from 'fs'
import type { TelemetryStore } from '../shared/telemetry-store'
import { CSV_HEADER, BATCH_SIZE, formatRow } from '../shared/export-columns'

/**
 * Export telemetry rows [startIdx, endIdx) to a CSV file.
 * Uses streaming writes with backpressure handling.
 */
export function exportCsv(
  store: TelemetryStore,
  filePath: string,
  startIdx: number,
  endIdx: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(filePath, { encoding: 'utf8' })
    ws.on('error', reject)
    ws.on('finish', resolve)

    ws.write(CSV_HEADER)

    let i = startIdx

    function writeBatch(): void {
      let ok = true
      while (i < endIdx && ok) {
        const batchEnd = Math.min(i + BATCH_SIZE, endIdx)
        const lines: string[] = []
        for (; i < batchEnd; i++) {
          lines.push(formatRow(store, i))
        }
        ok = ws.write(lines.join('\n') + '\n')
      }
      if (i >= endIdx) {
        ws.end()
      } else {
        ws.once('drain', writeBatch)
      }
    }

    writeBatch()
  })
}
