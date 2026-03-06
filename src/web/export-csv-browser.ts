/**
 * OpenPDR — Browser CSV Export
 *
 * Generates CSV telemetry data as a Blob for browser download.
 * Column definitions are shared with the Electron export via export-columns.ts.
 */

import type { TelemetryStore } from '../shared/telemetry-store'
import { CSV_HEADER, BATCH_SIZE, formatRow } from '../shared/export-columns'

/**
 * Export telemetry rows [startIdx, endIdx) to a CSV Blob.
 */
export function exportCsvBlob(
  store: TelemetryStore,
  startIdx: number,
  endIdx: number
): Blob {
  const parts: string[] = [CSV_HEADER]

  for (let i = startIdx; i < endIdx; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, endIdx)
    const lines: string[] = []
    for (let j = i; j < batchEnd; j++) {
      lines.push(formatRow(store, j))
    }
    parts.push(lines.join('\n') + '\n')
  }

  return new Blob(parts, { type: 'text/csv' })
}
