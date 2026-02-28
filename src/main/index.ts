import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { join } from 'path'
import { createReadStream, statSync } from 'fs'
import { parsePdrFile } from './parser'
import type { ParseResult } from './parser'

const BUILD_ID = 'phase1-v3'
console.log(`[OpenPDR main] build=${BUILD_ID}`)

let mainWindow: BrowserWindow | null = null
let allowedVideoPath: string | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
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
  { scheme: 'pdr-file', privileges: { stream: true, bypassCSP: true } }
])

app.whenReady().then(() => {
  // Handle serving local files via pdr-file:// protocol
  // Manually handle Range requests so HTML5 video seeking works
  protocol.handle('pdr-file', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname).replace(/^\//, '')

    if (filePath !== allowedVideoPath) {
      return new Response('Forbidden', { status: 403 })
    }

    const rangeHeader = request.headers.get('Range')

    const fileSize = statSync(filePath).size
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
            stream.on('data', (chunk: Buffer) => controller.enqueue(chunk))
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
        stream.on('data', (chunk: Buffer) => controller.enqueue(chunk))
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
  })

  createWindow()

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
ipcMain.handle('open-file-dialog', async () => {
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
  allowedVideoPath = result.filePaths[0]
  return result.filePaths[0]
})

// IPC: Parse PDR file — extracts telemetry directly from MP4
ipcMain.handle('parse-pdr-file', async (_event, filePath: string): Promise<ParseResult> => {
  return parsePdrFile(filePath, (phase, pct) => {
    mainWindow?.webContents.send('parse-progress', phase, pct)
  })
})
