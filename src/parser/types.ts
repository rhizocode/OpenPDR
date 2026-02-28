/**
 * OpenPDR Telemetry Parser — Type Definitions
 *
 * Parser-specific types live here. Shared types (TelemetryRow, LapInfo,
 * TrackLayout, LapData, ParseResult, ProgressCallback) are re-exported
 * from src/shared/types.ts so existing imports continue to work.
 */

// Re-export shared types so all existing `from './types'` imports keep working
export type {
  TelemetryRow,
  LapInfo,
  TrackLayout,
  LapData,
  AdviInfo,
  SessionInfo,
  ParseResult,
  ProgressCallback,
} from '../shared/types'

/** MP4 box header result */
export interface BoxHeader {
  offset: number
  size: number
  type: string
  headerSize: number
  dataStart: number
}

/** Compact box location: [offset, size, dataStart] */
export type BoxResult = [number, number, number]

/** Track location within the MP4 moov box */
export interface TrackInfo {
  trakOffset: number
  trakSize: number
  trakData: number
  trakEnd: number
}

/** Sample-to-chunk entry from stsc box */
export interface StscEntry {
  firstChunk: number
  samplesPerChunk: number
  descriptionIndex: number
}

/** Parsed sample table */
export interface SampleTable {
  sampleSizes: number[]
  chunkOffsets: number[]
  stscEntries: StscEntry[]
  sampleCount: number
}

/** Rate group from adcr box */
export interface RateGroup {
  period: number
  numChannels: number
  channels: Array<{ channelId: number; width: number }>
  totalWidth: number
}

/** Outing properties from adop box (key-value pairs) */
export interface AdopProps {
  lat?: number
  lon?: number
  /** All decoded key-value string properties */
  properties: Map<string, string>
}

/** GPS reference bounding box for search narrowing */
export interface GpsRefRange {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
}

/** An embedded event extracted from an oversized telemetry packet */
export interface EmbeddedEvent {
  eventId: number          // 0–19, maps to adeg definitions
  eventName: string        // e.g., "com.cosworth.event.lap.start"
  time: number             // seconds from recording start
}
