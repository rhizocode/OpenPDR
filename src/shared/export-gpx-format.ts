/**
 * OpenPDR — Shared GPX format helpers
 *
 * XML templates, escaping, and trackpoint formatting shared between
 * the Electron (streaming) and browser (Blob) GPX export implementations.
 */

export const GPX_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="OpenPDR Viewer"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns:openpdr="http://openpdr.org/gpx/1/0"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
`

export const GPX_FOOTER = `  </trkseg>
  </trk>
</gpx>
`

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function formatIsoTime(baseMs: number, offsetSeconds: number): string {
  return new Date(baseMs + offsetSeconds * 1000).toISOString()
}

export function formatTrkpt(
  lat: number, lon: number, ele: number,
  timeIso: string, speedKph: number, headingDeg: number
): string {
  return `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">
      <ele>${ele.toFixed(1)}</ele>
      <time>${timeIso}</time>
      <extensions>
        <openpdr:speed_kph>${speedKph.toFixed(1)}</openpdr:speed_kph>
        <openpdr:heading_deg>${headingDeg.toFixed(1)}</openpdr:heading_deg>
      </extensions>
    </trkpt>\n`
}

export const GPX_BATCH_SIZE = 2000
