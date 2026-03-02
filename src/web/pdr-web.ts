/**
 * OpenPDR — Browser PdrApi implementation
 *
 * Provides the same window.pdr API that the Electron preload exposes,
 * but implemented entirely with browser APIs. The renderer code is
 * unchanged — it just calls window.pdr.* methods regardless of platform.
 */

import type { PdrApi } from '../renderer/types'
import type { ParseResult, ExportScope } from '../shared/types'
import { BrowserFileSource } from './file-source-browser'
import { parsePdrFile } from '../parser/index'
import { exportCsvBlob } from './export-csv-browser'
import { exportGpxBlob } from './export-gpx-browser'

/** Map of string keys to stashed File objects (substitutes for file paths). */
const fileMap = new Map<string, File>()

/** Most recent parse result (needed for exports). */
let lastParseResult: ParseResult | null = null
let lastFileName: string | null = null

/** Trigger a browser download for a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

/** Stash a File and return a string key for it. */
function stashFile(file: File): string {
  const key = file.name
  fileMap.set(key, file)
  return key
}

/** Binary search: find the first index where time[i] >= target. */
function searchTimeIndex(times: Float64Array, target: number, length: number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Resolve an ExportScope to a row range + label. */
function getExportRange(scope: ExportScope): { startIdx: number; endIdx: number; label: string } | null {
  if (!lastParseResult) return null
  const store = lastParseResult.store
  const lapData = lastParseResult.metadata.lapData

  if (scope.type === 'full') {
    return { startIdx: 0, endIdx: store.length, label: 'Full' }
  }

  if (!lapData?.hasLapData || !scope.lapNumber) return null
  const lap = lapData.laps.find(l => l.lapNumber === scope.lapNumber)
  if (!lap) return null

  const startIdx = searchTimeIndex(store.time, lap.startTime, store.length)
  const endIdx = searchTimeIndex(store.time, lap.endTime, store.length)
  return { startIdx, endIdx, label: `Lap_${lap.lapNumber}` }
}

/** Base file name without extension. */
function getBaseName(): string {
  return (lastParseResult?.metadata.fileName ?? 'export').replace(/\.mp4$/i, '')
}

/** Progress callback holder. */
let progressCallback: ((phase: string, pct: number) => void) | null = null

const pdrWeb: PdrApi = {
  async openFileDialog(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.mp4'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) { resolve(null); return }
        resolve(stashFile(file))
      }
      // Handle cancel — the change event won't fire, so use a focus fallback
      const onFocus = () => {
        window.removeEventListener('focus', onFocus)
        setTimeout(() => {
          if (!input.files?.length) resolve(null)
        }, 300)
      }
      window.addEventListener('focus', onFocus)
      input.click()
    })
  },

  async parsePdrFile(filePath: string): Promise<ParseResult> {
    const file = fileMap.get(filePath)
    if (!file) throw new Error(`File not found: ${filePath}`)

    const source = new BrowserFileSource(file)
    const result = await parsePdrFile(source, file.name, (phase, pct) => {
      progressCallback?.(phase, pct)
    })

    lastParseResult = result
    lastFileName = file.name
    return result
  },

  onParseProgress(callback: (phase: string, pct: number) => void): () => void {
    progressCallback = callback
    return () => { progressCallback = null }
  },

  async setAllowedVideoPath(_filePath: string): Promise<void> {
    // No-op in browser — no security boundary to manage
  },

  getPathForFile(file: File): string {
    return stashFile(file)
  },

  getVideoUrl(filePath: string): string {
    const file = fileMap.get(filePath)
    if (!file) return ''
    return URL.createObjectURL(file)
  },

  async exportCsv(scope: ExportScope): Promise<boolean> {
    if (!lastParseResult) return false
    const range = getExportRange(scope)
    if (!range) return false

    const blob = exportCsvBlob(lastParseResult.store, range.startIdx, range.endIdx)
    downloadBlob(blob, `${getBaseName()}_${range.label}.csv`)
    return true
  },

  async exportGpx(scope: ExportScope): Promise<boolean> {
    if (!lastParseResult) return false
    const range = getExportRange(scope)
    if (!range) return false

    // Estimate recording start: use current time minus duration as fallback
    const baseDate = new Date(Date.now() - lastParseResult.metadata.duration * 1000)
    const trackName = `${getBaseName()} ${range.label.replace(/_/g, ' ')}`

    const blob = exportGpxBlob(
      lastParseResult.store,
      range.startIdx, range.endIdx,
      trackName, baseDate
    )
    downloadBlob(blob, `${getBaseName()}_${range.label}.gpx`)
    return true
  },

  async exportVideo(): Promise<boolean> {
    alert('Video export with overlays is not available in the web version.\n\nUse the desktop app for video export.')
    return false
  },

  onRenderOverlayFrames(_callback): () => void {
    return () => {} // no-op
  },

  cancelVideoExport(): void {
    // no-op
  },

  onExportVideoProgress(_callback): () => void {
    return () => {} // no-op
  },

  async sendOverlayFrameData(_idx: number, _buffer: Uint8Array): Promise<void> {
    // no-op
  },

  sendOverlayFramesDone(): void {
    // no-op
  },
}

/** Install the browser PdrApi on window.pdr before renderer modules initialize. */
export function installWebPdr(): void {
  ;(window as any).pdr = pdrWeb
}
