/**
 * OpenPDR Viewer — Auto-updater
 *
 * Wraps electron-updater to check GitHub Releases for new versions.
 * Communicates update state to the renderer via IPC.
 *
 * - Windows (NSIS) and Linux (AppImage): full auto-update support
 * - macOS (DMG): disabled (requires code signing)
 */

import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcChannels, UpdateStatus, ReleaseNote } from '../shared/types'

type Channel = keyof IpcChannels

let getWindow: () => BrowserWindow | null = () => null

function sendStatus(status: UpdateStatus): void {
  getWindow()?.webContents.send('update-status' satisfies Channel, status)
}

export function initAutoUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  // Always register version handler (platform-independent)
  ipcMain.handle('get-app-version' satisfies Channel, () => {
    return app.getVersion()
  })

  // macOS: unsigned DMGs don't support auto-update via Squirrel.Mac
  if (process.platform === 'darwin') {
    console.log('[auto-updater] Skipping on macOS (unsigned build)')
    // Register stub handlers so renderer IPC calls don't reject
    ipcMain.handle('check-for-updates' satisfies Channel, () => {
      sendStatus({ state: 'not-available' })
    })
    ipcMain.handle('download-update' satisfies Channel, () => {})
    ipcMain.handle('install-update' satisfies Channel, () => {})
    return
  }

  // ── Configure ──
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.fullChangelog = true
  autoUpdater.logger = console

  // ── electron-updater events → IPC status pushes ──

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    // fullChangelog=true makes releaseNotes an array of { version, note }
    let releaseNotes: ReleaseNote[] | undefined
    if (Array.isArray(info.releaseNotes)) {
      releaseNotes = info.releaseNotes.map((r) => ({
        version: r.version,
        note: r.note ?? '',
      }))
    } else if (typeof info.releaseNotes === 'string') {
      releaseNotes = [{ version: info.version, note: info.releaseNotes }]
    }

    sendStatus({ state: 'available', version: info.version, releaseNotes })
  })

  autoUpdater.on('update-not-available', () => {
    sendStatus({ state: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      state: 'downloading',
      progress: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater] Error:', err.message)
    sendStatus({ state: 'error', error: err.message })
  })

  // ── IPC handlers ──
  // Fire-and-forget: results communicated via 'update-status' event

  ipcMain.handle('check-for-updates' satisfies Channel, () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[auto-updater] Check failed:', err.message)
    })
  })

  ipcMain.handle('download-update' satisfies Channel, () => {
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[auto-updater] Download failed:', err.message)
    })
  })

  ipcMain.handle('install-update' satisfies Channel, () => {
    autoUpdater.quitAndInstall()
  })

  // ── Auto-check on launch (5s delay to avoid slowing startup) ──
  setTimeout(() => {
    console.log('[auto-updater] Auto-checking for updates...')
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[auto-updater] Auto-check failed:', err.message)
    })
  }, 5000)
}
