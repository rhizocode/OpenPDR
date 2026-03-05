import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { join, resolve } from 'path'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { parsePdrFile } from '../parser'
import { NodeFileSource } from './file-source-node'
import type { ParseResult, IpcChannels, ExportScope, VideoExportOptions } from '../shared/types'
import { exportCsv } from './export-csv'
import { exportGpx } from './export-gpx'
import { exportVideo, cancelVideoExport } from './export-video'
import { initAutoUpdater } from './auto-updater'

type Channel = keyof IpcChannels

const BUILD_ID = 'phase4-v1'
console.log(`[OpenPDR main] build=${BUILD_ID}`)

let mainWindow: BrowserWindow | null = null
let allowedVideoPaths = new Set<string>()

/** Add a video path, capping at 2 entries (primary + compare). */
function addAllowedVideoPath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/')
  if (allowedVideoPaths.has(normalized)) return
  if (allowedVideoPaths.size >= 2) {
    // Keep only the first entry (primary), evict the old compare path
    const primary = allowedVideoPaths.values().next().value!
    allowedVideoPaths.clear()
    allowedVideoPaths.add(primary)
  }
  allowedVideoPaths.add(normalized)
}
let lastParseResult: ParseResult | null = null
let lastFilePath: string | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // webSecurity defaults to true — pdr-file:// protocol handles video serving
    }
  })

  // In dev, load from Vite dev server; in prod, load the built file
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Register a custom protocol to serve local video files securely
protocol.registerSchemesAsPrivileged([
  { scheme: 'pdr-file', privileges: { stream: true } }
])

app.whenReady().then(() => {
  // Handle serving local files via pdr-file:// protocol
  // Manually handle Range requests so HTML5 video seeking works
  protocol.handle('pdr-file', async (request) => {
    try {
      const url = new URL(request.url)
      let filePath = decodeURIComponent(url.pathname)
      // Windows: pathname is /C:/... — strip the leading slash to get a valid drive path
      // Unix: pathname is /home/... — the leading slash is part of the absolute path
      if (/^\/[A-Za-z]:/.test(filePath)) {
        filePath = filePath.slice(1)
      }
      // Normalize to collapse ".." traversal segments before allowlist check
      filePath = resolve(filePath).replace(/\\/g, '/')

      if (!allowedVideoPaths.has(filePath)) {
        return new Response('Forbidden', { status: 403 })
      }

      const rangeHeader = request.headers.get('Range')

      const fileInfo = await stat(filePath)
      const fileSize = fileInfo.size
      const mimeType = filePath.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream'

      if (rangeHeader) {
        // Parse "bytes=start-end"
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        if (match) {
          const start = parseInt(match[1], 10)
          const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
          const chunkSize = end - start + 1

          const stream = createReadStream(filePath, { start, end })
          const readable = new ReadableStream({
            start(controller) {
              stream.on('data', (chunk: Buffer | string) => controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
              stream.on('end', () => controller.close())
              stream.on('error', (err) => controller.error(err))
            },
            cancel() { stream.destroy() }
          })

          return new Response(readable, {
            status: 206,
            headers: {
              'Content-Type': mimeType,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
            }
          })
        }
      }

      // No Range header — return full file
      const stream = createReadStream(filePath)
      const readable = new ReadableStream({
        start(controller) {
          stream.on('data', (chunk: Buffer | string) => controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
          stream.on('end', () => controller.close())
          stream.on('error', (err) => controller.error(err))
        },
        cancel() { stream.destroy() }
      })

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
        }
      })
    } catch (err) {
      return new Response(`File error: ${(err as Error).message}`, { status: 404 })
    }
  })

  createWindow()

  // Initialize auto-updater (skips on macOS — unsigned builds)
  if (mainWindow) {
    initAutoUpdater(mainWindow)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC: Open file dialog and return the selected MP4 path
ipcMain.handle('open-file-dialog' satisfies Channel, async () => {
  if (!mainWindow) return null

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDR Recording',
    filters: [
      { name: 'PDR Recordings', extensions: ['mp4'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })

  if (result.canceled || result.filePaths.length === 0) return null
  addAllowedVideoPath(result.filePaths[0])
  return result.filePaths[0]
})

// IPC: Set allowed video path (used by drag-and-drop — dialog handler sets it automatically)
// Restrict to .mp4 files to prevent renderer from authorizing arbitrary file reads
ipcMain.handle('set-allowed-video-path' satisfies Channel, (_event, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.mp4')) return
  addAllowedVideoPath(filePath)
})

// IPC: Reset allowed video paths (called when opening a new primary file)
ipcMain.handle('reset-allowed-video-paths' satisfies Channel, () => {
  allowedVideoPaths.clear()
})

// IPC: Parse PDR file — extracts telemetry directly from MP4
ipcMain.handle('parse-pdr-file' satisfies Channel, async (_event, filePath: string): Promise<ParseResult> => {
  const source = await NodeFileSource.open(filePath)
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  try {
    const result = await parsePdrFile(source, fileName, (phase, pct) => {
      mainWindow?.webContents.send('parse-progress' satisfies Channel, phase, pct)
    })
    lastParseResult = result
    lastFilePath = filePath
    return result
  } finally {
    await source.close()
  }
})

// ── Export helpers ──

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

/** Resolve an ExportScope to a row range + label. Returns null if invalid. */
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

/** Base file name without extension, derived from the last parsed file. */
function getBaseName(): string {
  return (lastParseResult?.metadata.fileName ?? 'export').replace(/\.mp4$/i, '')
}

// IPC: Export CSV
ipcMain.handle('export-csv' satisfies Channel, async (_event, scope: ExportScope): Promise<boolean> => {
  if (!mainWindow || !lastParseResult) return false

  const range = getExportRange(scope)
  if (!range) return false

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export CSV',
    defaultPath: `${getBaseName()}_${range.label}.csv`,
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (result.canceled || !result.filePath) return false
  await exportCsv(lastParseResult.store, result.filePath, range.startIdx, range.endIdx)
  return true
})

// IPC: Export GPX
ipcMain.handle('export-gpx' satisfies Channel, async (_event, scope: ExportScope): Promise<boolean> => {
  if (!mainWindow || !lastParseResult || !lastFilePath) return false

  const range = getExportRange(scope)
  if (!range) return false

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export GPX',
    defaultPath: `${getBaseName()}_${range.label}.gpx`,
    filters: [
      { name: 'GPX Files', extensions: ['gpx'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (result.canceled || !result.filePath) return false

  // Estimate recording start: file mtime minus recording duration
  const fileInfo = await stat(lastFilePath)
  const baseDate = new Date(fileInfo.mtimeMs - lastParseResult.metadata.duration * 1000)
  const trackName = `${getBaseName()} ${range.label.replace(/_/g, ' ')}`

  await exportGpx(lastParseResult.store, result.filePath, range.startIdx, range.endIdx, trackName, baseDate)
  return true
})

// IPC: Export Video with baked overlays
ipcMain.handle('export-video' satisfies Channel, async (_event, scope: ExportScope, options: VideoExportOptions): Promise<boolean> => {
  if (!mainWindow || !lastParseResult || !lastFilePath) return false

  const range = getExportRange(scope)
  if (!range) return false

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Video with Overlays',
    defaultPath: `${getBaseName()}_${range.label}.mp4`,
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (result.canceled || !result.filePath) return false

  try {
    await exportVideo(
      lastParseResult.store,
      lastFilePath,
      result.filePath,
      range.startIdx,
      range.endIdx,
      options.overlayConfig,
      options.overlayLayout,
      options.rpmConfig,
      lastParseResult.metadata.lapData?.trackLayout ?? null,
      lastParseResult.metadata.sessionInfo,
      (phase, pct) => mainWindow?.webContents.send('export-video-progress' satisfies Channel, phase, pct),
      mainWindow,
    )
    return true
  } catch (err) {
    console.error('[export-video] Failed:', err)
    return false
  }
})

// IPC: Cancel video export
ipcMain.on('export-video-cancel' satisfies Channel, () => {
  cancelVideoExport()
})
