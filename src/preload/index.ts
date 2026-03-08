import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ParseResult, IpcChannels, ExportScope, VideoExportOptions, RenderOverlayRequest,
  UpdateStatus, PdrApi,
} from '../shared/types'

type Channel = keyof IpcChannels

/** Returns null if valid, or a descriptive error string. */
function validateExportScope(scope: ExportScope): string | null {
  if (!scope || typeof scope !== 'object') return 'ExportScope must be a non-null object'
  if (scope.type === 'full') return null
  if (scope.type !== 'lap') return `ExportScope.type must be "full" or "lap", got "${String((scope as unknown as Record<string, unknown>).type)}"`
  if (typeof scope.lapNumber !== 'number' || !Number.isInteger(scope.lapNumber) || scope.lapNumber <= 0)
    return 'ExportScope.lapNumber must be a positive integer when type is "lap"'
  return null
}

const api: PdrApi = {
  platform: 'electron',
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-file-dialog' satisfies Channel),

  parsePdrFile: (filePath: string): Promise<ParseResult> => {
    if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.mp4')) {
      return Promise.reject(new Error('Invalid file path'))
    }
    return ipcRenderer.invoke('parse-pdr-file' satisfies Channel, filePath)
  },

  onParseProgress: (() => {
    let prev: ((_event: Electron.IpcRendererEvent, phase: string, pct: number) => void) | null = null
    return (callback: (phase: string, pct: number) => void): (() => void) => {
      const channel = 'parse-progress' satisfies Channel
      if (prev) ipcRenderer.removeListener(channel, prev)
      const handler = (_event: Electron.IpcRendererEvent, phase: string, pct: number) => callback(phase, pct)
      prev = handler
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler); if (prev === handler) prev = null }
    }
  })(),

  setAllowedVideoPath: (filePath: string): Promise<void> => {
    if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.mp4')) {
      return Promise.reject(new Error('Invalid video path'))
    }
    return ipcRenderer.invoke('set-allowed-video-path' satisfies Channel, filePath)
  },

  resetAllowedVideoPaths: (): Promise<void> =>
    ipcRenderer.invoke('reset-allowed-video-paths' satisfies Channel),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  getVideoUrl: (filePath: string): string => {
    if (typeof filePath !== 'string') return ''
    // Use pdr-file:// protocol (secure — no webSecurity: false needed)
    const normalized = filePath.replace(/\\/g, '/')
    const urlPath = normalized.startsWith('/') ? normalized : '/' + normalized
    // Use URL constructor to properly percent-encode special characters (#, ?, %)
    const u = new URL('pdr-file:///')
    u.pathname = urlPath
    return u.href
  },

  exportCsv: (scope: ExportScope): Promise<boolean> => {
    const err = validateExportScope(scope)
    if (err) return Promise.reject(new Error(err))
    return ipcRenderer.invoke('export-csv' satisfies Channel, scope)
  },

  exportGpx: (scope: ExportScope): Promise<boolean> => {
    const err = validateExportScope(scope)
    if (err) return Promise.reject(new Error(err))
    return ipcRenderer.invoke('export-gpx' satisfies Channel, scope)
  },

  exportVideo: (scope: ExportScope, options: VideoExportOptions): Promise<boolean> => {
    const err = validateExportScope(scope)
    if (err) return Promise.reject(new Error(err))
    if (!options || typeof options !== 'object' || !options.overlayConfig)
      return Promise.reject(new Error('Invalid export options: overlayConfig is required'))
    return ipcRenderer.invoke('export-video' satisfies Channel, scope, options)
  },

  // Bidirectional IPC for overlay frame rendering (main -> renderer -> main)
  onRenderOverlayFrames: (() => {
    let prev: ((_event: Electron.IpcRendererEvent, request: RenderOverlayRequest) => void) | null = null
    return (callback: (request: RenderOverlayRequest) => void): (() => void) => {
      const channel = 'render-overlay-frames' satisfies Channel
      if (prev) ipcRenderer.removeListener(channel, prev)
      const handler = (_event: Electron.IpcRendererEvent, request: RenderOverlayRequest) => callback(request)
      prev = handler
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler); if (prev === handler) prev = null }
    }
  })(),

  sendOverlayFrameData: (idx: number, buffer: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('overlay-frame-data' satisfies Channel, idx, buffer),

  sendOverlayFramesDone: (): void => {
    ipcRenderer.send('overlay-frames-done' satisfies Channel)
  },

  cancelVideoExport: (): void => {
    ipcRenderer.send('export-video-cancel' satisfies Channel)
  },

  onExportVideoProgress: (() => {
    let prev: ((_event: Electron.IpcRendererEvent, phase: string, pct: number) => void) | null = null
    return (callback: (phase: string, pct: number) => void): (() => void) => {
      const channel = 'export-video-progress' satisfies Channel
      if (prev) ipcRenderer.removeListener(channel, prev)
      const handler = (_event: Electron.IpcRendererEvent, phase: string, pct: number) => callback(phase, pct)
      prev = handler
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler); if (prev === handler) prev = null }
    }
  })(),

  // Auto-update
  checkForUpdates: (): Promise<void> =>
    ipcRenderer.invoke('check-for-updates' satisfies Channel),

  downloadUpdate: (): Promise<void> =>
    ipcRenderer.invoke('download-update' satisfies Channel),

  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('install-update' satisfies Channel),

  onUpdateStatus: (() => {
    let prev: ((_event: Electron.IpcRendererEvent, status: UpdateStatus) => void) | null = null
    return (callback: (status: UpdateStatus) => void): (() => void) => {
      const channel = 'update-status' satisfies Channel
      if (prev) ipcRenderer.removeListener(channel, prev)
      const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
      prev = handler
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler); if (prev === handler) prev = null }
    }
  })(),

  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('get-app-version' satisfies Channel),
}
contextBridge.exposeInMainWorld('pdr', api)
