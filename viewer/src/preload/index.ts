import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pdr', {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-file-dialog'),

  parsePdrFile: (filePath: string): Promise<unknown> =>
    ipcRenderer.invoke('parse-pdr-file', filePath),

  onParseProgress: (callback: (phase: string, pct: number) => void): void => {
    ipcRenderer.on('parse-progress', (_event, phase, pct) => callback(phase, pct))
  },

  getVideoUrl: (filePath: string): string => {
    // Use pdr-file:// protocol (secure — no webSecurity: false needed)
    const normalized = filePath.replace(/\\/g, '/')
    return `pdr-file:///${normalized}`
  },
})
