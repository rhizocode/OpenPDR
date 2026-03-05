/**
 * OpenPDR Viewer — Renderer type definitions
 *
 * Shared types (TelemetryRow, LapInfo, TrackLayout, LapData, ParseResult,
 * overlay types) are re-exported from src/shared/types.ts.
 * Renderer-only types live here.
 */

// Re-export shared types so all existing `from './types'` imports keep working
export type {
  TelemetryRow,
  LapInfo,
  TrackLayout,
  LapData,
  ParseResult,
  ExportScope,
  OverlayConfig,
  OverlayKey,
  OverlayPosition,
  OverlayLayout,
  RpmConfig,
  SessionInfo,
  VideoExportOptions,
  RenderOverlayRequest,
  UpdateStatus,
  ReleaseNote,
} from '../shared/types'

export interface PdrApi {
  openFileDialog(): Promise<string | null>
  parsePdrFile(filePath: string): Promise<import('../shared/types').ParseResult>
  onParseProgress(callback: (phase: string, pct: number) => void): () => void
  setAllowedVideoPath(filePath: string): Promise<void>
  resetAllowedVideoPaths(): Promise<void>
  getPathForFile(file: File): string
  getVideoUrl(filePath: string): string
  exportCsv(scope: import('../shared/types').ExportScope): Promise<boolean>
  exportGpx(scope: import('../shared/types').ExportScope): Promise<boolean>
  exportVideo(scope: import('../shared/types').ExportScope, options: import('../shared/types').VideoExportOptions): Promise<boolean>
  onRenderOverlayFrames(callback: (request: import('../shared/types').RenderOverlayRequest) => void): () => void
  cancelVideoExport(): void
  onExportVideoProgress(callback: (phase: string, pct: number) => void): () => void
  sendOverlayFrameData(idx: number, buffer: Uint8Array): Promise<void>
  sendOverlayFramesDone(): void
  // Auto-update
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdateStatus(callback: (status: import('../shared/types').UpdateStatus) => void): () => void
  getAppVersion(): Promise<string>
}

declare global {
  interface Window { pdr: PdrApi }
}
