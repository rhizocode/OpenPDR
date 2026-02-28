import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ParseResult, IpcChannels, ExportScope } from '../shared/types'

type Channel = keyof IpcChannels

contextBridge.exposeInMainWorld('pdr', {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-file-dialog' satisfies Channel),

  parsePdrFile: (filePath: string): Promise<ParseResult> =>
    ipcRenderer.invoke('parse-pdr-file' satisfies Channel, filePath),

  onParseProgress: (callback: (phase: string, pct: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, phase: string, pct: number) => callback(phase, pct)
    ipcRenderer.on('parse-progress' satisfies Channel, handler)
    return () => ipcRenderer.removeListener('parse-progress' satisfies Channel, handler)
  },

  setAllowedVideoPath: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('set-allowed-video-path' satisfies Channel, filePath),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  getVideoUrl: (filePath: string): string => {
    // Use pdr-file:// protocol (secure — no webSecurity: false needed)
    const normalized = filePath.replace(/\\/g, '/')
    return `pdr-file:///${normalized}`
  },

  exportCsv: (scope: ExportScope): Promise<boolean> =>
    ipcRenderer.invoke('export-csv' satisfies Channel, scope),

  exportGpx: (scope: ExportScope): Promise<boolean> =>
    ipcRenderer.invoke('export-gpx' satisfies Channel, scope),
})
