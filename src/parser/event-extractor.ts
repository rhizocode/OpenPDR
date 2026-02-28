/**
 * OpenPDR Telemetry Parser — Embedded Event Extractor
 *
 * Extracts performance timing events from oversized telemetry packets.
 * The AliveDrive firmware embeds event records as extra bytes appended
 * after the normal telemetry payload when events fire during that second.
 *
 * Event record format (11 bytes each):
 *   Offset  Size  Type      Field
 *   0       8     u64 BE    timestamp (100 ns ticks from recording start)
 *   8       2     u16 BE    flags (observed: 0x0200)
 *   10      1     u8        event_id (0–19, maps to adeg definitions)
 */

import { readUint32BE } from '../shared/binary-reader'
import type { EmbeddedEvent } from './types'

const EVENT_RECORD_SIZE = 11
const TICKS_PER_SECOND = 10_000_000

/** Pre-built Map for O(1) event name lookups. Lazily built on first call. */
let eventDefMap: Map<number, string> | null = null
let eventDefSource: Array<{ eventId: number; name: string }> | null = null

function getEventDefMap(eventDefs: Array<{ eventId: number; name: string }>): Map<number, string> {
  if (eventDefMap && eventDefSource === eventDefs) return eventDefMap
  eventDefMap = new Map(eventDefs.map(e => [e.eventId, e.name]))
  eventDefSource = eventDefs
  return eventDefMap
}

export function extractEvents(
  packet: Uint8Array,
  nominalSize: number,
  eventDefs: Array<{ eventId: number; name: string }>
): EmbeddedEvent[] {
  if (packet.length <= nominalSize) return []

  const extra = packet.subarray(nominalSize)
  if (extra.length % EVENT_RECORD_SIZE !== 0) return []

  const defMap = getEventDefMap(eventDefs)
  const events: EmbeddedEvent[] = []
  const numEvents = Math.floor(extra.length / EVENT_RECORD_SIZE)

  for (let i = 0; i < numEvents; i++) {
    const off = i * EVENT_RECORD_SIZE

    // Read 8-byte timestamp as two u32s (JS doesn't have native u64)
    const tsHi = readUint32BE(extra, off)
    const tsLo = readUint32BE(extra, off + 4)
    const timeSec = (tsHi * 0x100000000 + tsLo) / TICKS_PER_SECOND

    const eventId = extra[off + 10]
    const eventName = defMap.get(eventId) ?? `unknown_event_${eventId}`

    events.push({ eventId, eventName, time: timeSec })
  }

  return events
}
