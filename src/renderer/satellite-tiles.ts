/**
 * OpenPDR — Satellite tile fetcher
 *
 * Fetches ESRI ArcGIS World Imagery tiles for a GPS bounding box,
 * stitches them into a single composite image, and returns it with
 * the lat/lon bounds of the stitched image for GPS→pixel mapping.
 */

import type { TrackLayout } from './types'

const TILE_URL = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile'
const TILE_SIZE = 256

export interface SatelliteResult {
  image: HTMLCanvasElement
  /** Lat/lon bounds of the stitched tile grid (may be slightly larger than requested) */
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

/** Convert lat/lon to tile x/y at a given zoom level. */
function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = lat * Math.PI / 180
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  return { x, y }
}

/** Convert tile x/y back to the top-left lat/lon corner. */
function tileToLatLon(tx: number, ty: number, zoom: number): { lat: number; lon: number } {
  const n = 2 ** zoom
  const lon = (tx / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n)))
  const lat = latRad * 180 / Math.PI
  return { lat, lon }
}

/** Auto-select zoom level based on bounding box size. */
function chooseZoom(bounds: TrackLayout['bounds']): number {
  const latRange = bounds.maxLat - bounds.minLat
  const lonRange = bounds.maxLon - bounds.minLon
  const diagonal = Math.sqrt(latRange * latRange + lonRange * lonRange)
  // ~0.01° diagonal ≈ 1 km → z17; ~0.03°+ ≈ 3+ km → z16
  if (diagonal < 0.015) return 17
  return 16
}

/**
 * Fetch satellite imagery tiles covering the given GPS bounds.
 * Returns a stitched canvas + the lat/lon bounds of the tile grid.
 * Returns null on complete failure.
 */
export async function fetchSatelliteImage(
  bounds: TrackLayout['bounds'],
  padding = 0.35,
): Promise<SatelliteResult | null> {
  const latRange = bounds.maxLat - bounds.minLat
  const lonRange = bounds.maxLon - bounds.minLon
  if (latRange === 0 || lonRange === 0) return null

  // Pad the bounds
  const padLat = latRange * padding
  const padLon = lonRange * padding
  const paddedBounds = {
    minLat: bounds.minLat - padLat,
    maxLat: bounds.maxLat + padLat,
    minLon: bounds.minLon - padLon,
    maxLon: bounds.maxLon + padLon,
  }

  const zoom = chooseZoom(bounds)

  // Compute tile range
  const topLeft = latLonToTile(paddedBounds.maxLat, paddedBounds.minLon, zoom)
  const bottomRight = latLonToTile(paddedBounds.minLat, paddedBounds.maxLon, zoom)

  const minTX = topLeft.x
  const maxTX = bottomRight.x
  const minTY = topLeft.y
  const maxTY = bottomRight.y

  const countX = maxTX - minTX + 1
  const countY = maxTY - minTY + 1

  // Sanity check — don't fetch more than 100 tiles
  if (countX * countY > 100) return null

  // Fetch all tiles in parallel
  const tilePromises: Array<{ tx: number; ty: number; promise: Promise<HTMLImageElement | null> }> = []

  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const url = `${TILE_URL}/${zoom}/${ty}/${tx}`
      const promise = loadTileImage(url)
      tilePromises.push({ tx, ty, promise })
    }
  }

  const results = await Promise.all(tilePromises.map(t => t.promise))

  // Check if we got at least one tile
  const anyLoaded = results.some(r => r !== null)
  if (!anyLoaded) return null

  // Stitch onto offscreen canvas
  const stitchW = countX * TILE_SIZE
  const stitchH = countY * TILE_SIZE
  const stitchCanvas = document.createElement('canvas')
  stitchCanvas.width = stitchW
  stitchCanvas.height = stitchH
  const sCtx = stitchCanvas.getContext('2d')!

  // Fill with dark background for missing tiles
  sCtx.fillStyle = '#1a1a1a'
  sCtx.fillRect(0, 0, stitchW, stitchH)

  for (let i = 0; i < tilePromises.length; i++) {
    const img = results[i]
    if (!img) continue
    const { tx, ty } = tilePromises[i]
    const px = (tx - minTX) * TILE_SIZE
    const py = (ty - minTY) * TILE_SIZE
    sCtx.drawImage(img, px, py, TILE_SIZE, TILE_SIZE)
  }

  // Compute the lat/lon bounds of the full tile grid
  const gridTopLeft = tileToLatLon(minTX, minTY, zoom)
  const gridBottomRight = tileToLatLon(maxTX + 1, maxTY + 1, zoom)

  return {
    image: stitchCanvas,
    minLat: gridBottomRight.lat,
    maxLat: gridTopLeft.lat,
    minLon: gridTopLeft.lon,
    maxLon: gridBottomRight.lon,
  }
}

/** Load a single tile as an HTMLImageElement. Returns null on error. */
function loadTileImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}
