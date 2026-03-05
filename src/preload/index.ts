import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ParseResult, IpcChannels, ExportScope, VideoExportOptions, RenderOverlayRequest,
  UpdateStatus,
} from '../shared/types'
import type { PdrApi } from '../renderer/types'

type Channel = keyof IpcChannels

const api: PdrApi = {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-file-dialog' satisfies Channel),

  parsePdrFile: (filePath: string): Promise<ParseResult> => {
    if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.mp4')) {
      return Promise.reject(new Error('Invalid file path'))
    }
    return ipcRenderer.invoke('parse-pdr-file' satisfies Channel, filePath)
  },

  onParseProgress: (callback: (phase: string, pct: number) => void): (() => void) => {
    const channel = 'parse-progress' satisfies Channel
    ipcRenderer.removeAllListeners(channel)
    const handler = (_event: Electron.IpcRendererEvent, phase: string, pct: number) => callback(phase, pct)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  setAllowedVideoPath: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('set-allowed-video-path' satisfies Channel, filePath),

  resetAllowedVideoPaths: (): Promise<void> =>
    ipcRenderer.invoke('reset-allowed-video-paths' satisfies Channel),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  getVideoUrl: (filePath: string): string => {
    if (typeof filePath !== 'string') return ''
    // Use pdr-file:// protocol (secure — no webSecurity: false needed)
    const normalized = filePath.replace(/\\/g, '/')
    // Unix paths start with /, Windows paths start with C:/ — ensure exactly: pdr-file:// + / + path
    const urlPath = normalized.startsWith('/') ? normalized : '/' + normalized
    return `pdr-file://${urlPath}`
  },

  exportCsv: (scope: ExportScope): Promise<boolean> =>
    ipcRenderer.invoke('export-csv' satisfies Channel, scope),

  exportGpx: (scope: ExportScope): Promise<boolean> =>
    ipcRenderer.invoke('export-gpx' satisfies Channel, scope),

  exportVideo: (scope: ExportScope, options: VideoExportOptions): Promise<boolean> =>
    ipcRenderer.invoke('export-video' satisfies Channel, scope, options),

  // Bidirectional IPC for overlay frame rendering (main -> renderer -> main)
  onRenderOverlayFrames: (callback: (request: RenderOverlayRequest) => void): (() => void) => {
    const channel = 'render-overlay-frames' satisfies Channel
    ipcRenderer.removeAllListeners(channel)
    const handler = (_event: Electron.IpcRendererEvent, request: RenderOverlayRequest) => callback(request)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  sendOverlayFrameData: (idx: number, buffer: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('overlay-frame-data' satisfies Channel, idx, buffer),

  sendOverlayFramesDone: (): void => {
    ipcRenderer.send('overlay-frames-done' satisfies Channel)
  },

  cancelVideoExport: (): void => {
    ipcRenderer.send('export-video-cancel' satisfies Channel)
  },

  onExportVideoProgress: (callback: (phase: string, pct: number) => void): (() => void) => {
    const channel = 'export-video-progress' satisfies Channel
    ipcRenderer.removeAllListeners(channel)
    const handler = (_event: Electron.IpcRendererEvent, phase: string, pct: number) => callback(phase, pct)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  // Auto-update
  checkForUpdates: (): Promise<void> =>
    ipcRenderer.invoke('check-for-updates' satisfies Channel),

  downloadUpdate: (): Promise<void> =>
    ipcRenderer.invoke('download-update' satisfies Channel),

  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('install-update' satisfies Channel),

  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const channel = 'update-status' satisfies Channel
    ipcRenderer.removeAllListeners(channel)
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('get-app-version' satisfies Channel),
}
contextBridge.exposeInMainWorld('pdr', api)
