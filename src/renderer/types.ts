/**
 * OpenPDR Viewer — Renderer type definitions
 *
 * Shared types (TelemetryRow, LapInfo, TrackLayout, LapData, ParseResult)
 * are re-exported from src/shared/types.ts. Renderer-only types live here.
 */

// Re-export shared types so all existing `from './types'` imports keep working
export type {
  TelemetryRow,
  LapInfo,
  TrackLayout,
  LapData,
  ParseResult,
} from '../shared/types'

export interface PdrApi {
  openFileDialog(): Promise<string | null>
  parsePdrFile(filePath: string): Promise<import('../shared/types').ParseResult>
  onParseProgress(callback: (phase: string, pct: number) => void): () => void
  getVideoUrl(filePath: string): string
}

declare global {
  interface Window { pdr: PdrApi }
}

/** Overlay visibility configuration */
export interface OverlayConfig {
  speed: boolean
  rpmGauge: boolean
  gear: boolean
  gforce: boolean
  pedals: boolean
  steering: boolean
  gps: boolean
  trackMap: boolean
}

/** RPM gauge zone configuration */
export interface RpmConfig {
  yellowStart: number
  redline: number
  maxRpm: number
}

/** Overlay key — matches keys of OverlayConfig */
export type OverlayKey = keyof OverlayConfig

/** Position + scale for a single overlay element (% of video-container) */
export interface OverlayPosition {
  left: number
  top: number
  scale: number
}

/** Stored layout for all overlay elements */
export type OverlayLayout = Record<OverlayKey, OverlayPosition>
