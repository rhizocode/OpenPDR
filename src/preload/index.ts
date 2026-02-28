import { contextBridge, ipcRenderer } from 'electron'
import type { ParseResult, IpcChannels } from '../shared/types'

type Channel = keyof IpcChannels

contextBridge.exposeInMainWorld('pdr', {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-file-dialog' satisfies Channel),

  parsePdrFile: (filePath: string): Promise<ParseResult> =>
    ipcRenderer.invoke('parse-pdr-file' satisfies Channel, filePath),

  onParseProgress: (callback: (phase: string, pct: number) => void): void => {
    ipcRenderer.on('parse-progress' satisfies Channel, (_event, phase, pct) => callback(phase, pct))
  },

  getVideoUrl: (filePath: string): string => {
    // Use pdr-file:// protocol (secure — no webSecurity: false needed)
    const normalized = filePath.replace(/\\/g, '/')
    return `pdr-file:///${normalized}`
  },
})
