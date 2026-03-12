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

/** Run-length entry from stts (decoding time to sample) box */
export interface SttsEntry {
  count: number
  delta: number
}

/** Track timing metadata from mdhd + stts + edts/elst boxes */
export interface TrackTiming {
  /** mdhd timescale (ticks per second) */
  timescale: number
  /** mdhd duration in timescale units */
  duration: number
  /** stts entries (run-length encoded per-sample durations) */
  sttsEntries: SttsEntry[]
  /** Delay from edts/elst empty edit (seconds), 0 if no edit list */
  elstDelay: number
  /** Media start time from first non-empty edit list entry (seconds), 0 if none */
  mediaStartTime: number
  /** Per-sample presentation times in seconds (elst delay + cumulative stts - mediaStartTime) */
  sampleTimes: Float64Array
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

/** An embedded event extracted from an oversized telemetry packet */
export interface EmbeddedEvent {
  eventId: number          // 0–19, maps to adeg definitions
  eventName: string        // e.g., "com.cosworth.event.lap.start"
  time: number             // seconds from recording start
}

// ── Format Detection ──────────────────────────────────────────────────────────

/** Known PDR telemetry formats */
export type FormatType = 'alivedrive' | 'marlin'

/** Result of format detection on a moov buffer */
export interface FormatDetection {
  format: FormatType
  trackInfo: TrackInfo
}

// ── Marlin-specific types ─────────────────────────────────────────────────────

/** A single channel definition from the Marlin mrld dictionary (448-byte record). */
export interface MarlinChannel {
  channelId: number
  typeId: number
  units: string
  intervalTicks: number   // sample interval in 100 ns units
  multiplier: number      // raw → SI conversion multiplier
  offset: number          // raw → SI conversion offset
  name: string
  description: string
}

/** Recording metadata from the Marlin mrlv box. */
export interface MarlinMetadata {
  recordingId: string
  startDate: string
  startTime: string
  endTime: string
  endDate: string
  timezone: string
  trackName: string
  country: string
  language: string
  softwareVersion: string
  unitSystem: string
  recordingType: string
  startTimestampTicks: number  // 100 ns since Unix epoch
}
