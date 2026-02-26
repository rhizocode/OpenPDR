import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { pathToFileURL } from 'url'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // Phase 0: allow file:// URLs from dev server origin
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
  // Must use net.fetch (not global fetch) — it handles file:// URLs properly
  // with correct Content-Type headers and Range request support for video streaming
  protocol.handle('pdr-file', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname).replace(/^\//, '')
    console.log('[pdr-file] request:', request.url, '→ resolved:', filePath)
    const fileUrl = pathToFileURL(filePath).href
    console.log('[pdr-file] fetching:', fileUrl)
    return net.fetch(fileUrl)
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
  return result.filePaths[0]
})

// IPC: Load telemetry JSON from a file path
ipcMain.handle('load-telemetry', async (_event, jsonPath: string) => {
  const data = await readFile(jsonPath, 'utf-8')
  return JSON.parse(data)
})
