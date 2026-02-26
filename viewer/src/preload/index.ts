import { contextBridge, ipcRenderer } from 'electron'

export interface TelemetryRow {
  time: number        // seconds from start
  speed_kph: number
  speed_mph: number
  rpm: number
  gear: string
  throttle: number    // 0–1
  brake: number       // 0–1
  lat: number
  lon: number
  gforce_lat: number  // g
  gforce_lon: number  // g
  steering_deg: number
}

contextBridge.exposeInMainWorld('pdr', {
  openFileDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('open-file-dialog'),

  loadTelemetry: (jsonPath: string): Promise<TelemetryRow[]> =>
    ipcRenderer.invoke('load-telemetry', jsonPath),

  getVideoUrl: (filePath: string): string => {
    // Phase 0: use file:// directly (webSecurity: false allows this)
    // Normalize backslashes to forward slashes for URL
    const normalized = filePath.replace(/\\/g, '/')
    return 'file:///' + normalized
  }
})
