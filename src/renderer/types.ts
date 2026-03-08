/**
 * OpenPDR Viewer — Renderer type definitions
 *
 * Shared types (TelemetryRow, LapInfo, TrackLayout, LapData, ParseResult,
 * overlay types, PdrApi) are re-exported from src/shared/types.ts.
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
  OverlayOrigin,
  OverlayPosition,
  OverlayLayout,
  RpmConfig,
  SessionInfo,
  VideoExportOptions,
  RenderOverlayRequest,
  TrackMapExportConfig,
  UpdateStatus,
  ReleaseNote,
  PdrApi,
} from '../shared/types'

declare global {
  interface Window { pdr: import('../shared/types').PdrApi }
  /** Injected by Vite `define` at build time */
  const __APP_VERSION__: string
}
