/**
 * OpenPDR Viewer — Compare Mode: Side B overlay anchor
 *
 * Creates and manages a second HUD overlay anchor that mirrors the A-side
 * overlays over video B, driven by side B telemetry.
 *
 * The anchor is built dynamically when entering compare mode and destroyed
 * when exiting. It reuses the same layout/config as the A anchor but draws
 * into separate DOM elements.
 */

import type { TelemetryRow, OverlayConfig, OverlayKey, SessionInfo } from './types'
import { drawRpmGauge } from './rpm-gauge'
import { rpmConfigB } from './compare-state'
import { drawGForce } from './gforce-ball'
import { drawSteering } from './steering'
import { resolveGearDisplay, formatTimestamp, getBrakeDisplay } from './defaults'

// ── B-side DOM refs (created on enter, nulled on exit) ──
let anchorB: HTMLDivElement | null = null
let speedValueB: HTMLSpanElement | null = null
let gearValueB: HTMLSpanElement | null = null
let throttleFillB: HTMLDivElement | null = null
let brakeFillB: HTMLDivElement | null = null
let gpsLatB: HTMLSpanElement | null = null
let gpsLonB: HTMLSpanElement | null = null
let gpsAltB: HTMLSpanElement | null = null
let rpmSvgB: SVGSVGElement | null = null
let gforceCanvasB: HTMLCanvasElement | null = null
let steeringSvgB: SVGSVGElement | null = null
let steeringLabelB: HTMLSpanElement | null = null

// ── Smoothing state for B-side canvas elements ──
const SMOOTH_RATE = 80
let targetRpmB = 0, displayedRpmB = 0
let targetSteeringB = 0, displayedSteeringB = 0
let targetGLatB = 0, displayedGLatB = 0
let targetGLonB = 0, displayedGLonB = 0
let lastFrameTimeB = 0
let hudBActive = false

// ── Gear carry-forward ──
let lastKnownGearB = '-'

/** Build the B-side overlay anchor and insert it into the video container. */
export function createOverlayB(videoContainer: HTMLDivElement, overlayAnchorA: HTMLDivElement): void {
  // Clone the A anchor structure — this copies all child HTML including the SVG
  anchorB = overlayAnchorA.cloneNode(true) as HTMLDivElement
  anchorB.id = 'video-overlay-anchor-b'

  // Re-ID all elements inside the clone so they don't collide with A-side IDs
  anchorB.querySelectorAll('[id]').forEach(el => {
    el.id = el.id + '-b'
  })

  videoContainer.appendChild(anchorB)

  // Grab refs to B-side elements
  speedValueB = anchorB.querySelector('#hud-speed-value-b') as HTMLSpanElement
  gearValueB = anchorB.querySelector('#hud-gear-value-b') as HTMLSpanElement
  throttleFillB = anchorB.querySelector('#throttle-fill-b') as HTMLDivElement
  brakeFillB = anchorB.querySelector('#brake-fill-b') as HTMLDivElement
  gpsLatB = anchorB.querySelector('#hud-gps-lat-b') as HTMLSpanElement
  gpsLonB = anchorB.querySelector('#hud-gps-lon-b') as HTMLSpanElement
  gpsAltB = anchorB.querySelector('#hud-gps-alt-b') as HTMLSpanElement
  rpmSvgB = anchorB.querySelector('#hud-rpm-gauge-b svg') as SVGSVGElement
  gforceCanvasB = anchorB.querySelector('#gforce-canvas-b') as HTMLCanvasElement
  steeringSvgB = anchorB.querySelector('#steering-svg-b') as unknown as SVGSVGElement
  steeringLabelB = anchorB.querySelector('#steering-label-b') as HTMLSpanElement

  // Remove track map from B — same track for both sides
  anchorB.querySelector('#hud-trackMap-b')?.remove()

  // Remove edit-mode artifacts (cloned from A if edit mode was active)
  anchorB.classList.remove('edit-guides')
  anchorB.querySelectorAll('.resize-handle').forEach(el => el.remove())
  anchorB.querySelectorAll('.hud-element').forEach(el => {
    el.classList.remove('edit-mode', 'dragging')
  })

  // Reset smoothing state
  hudBActive = false
  lastKnownGearB = '-'
  lastFrameTimeB = 0
}

/** Populate the B-side session overlay with file B's metadata. */
export function populateSessionB(info: SessionInfo | null): void {
  if (!anchorB) return
  const contentB = anchorB.querySelector('#hud-session-content-b') as HTMLDivElement | null
  if (!contentB) return
  contentB.innerHTML = ''
  if (!info) return

  const dateStr = info.timestamp ? formatTimestamp(info.timestamp) : undefined

  const vehicleParts = [info.year, info.vehicle]
    .filter(Boolean)
    .map(s => s!.replace(/[()]/g, ''))
  const vehicleStr = vehicleParts.length ? vehicleParts.join(' ') : undefined

  const fields: Array<[string, string | undefined]> = [
    ['Vehicle', vehicleStr],
    ['Engine', info.engine],
    ['Date', dateStr],
  ]

  for (const [label, value] of fields) {
    if (!value) continue
    const row = document.createElement('div')
    const lbl = document.createElement('span')
    lbl.className = 'session-label'
    lbl.textContent = label + ' '
    const val = document.createElement('span')
    val.className = 'session-value'
    val.textContent = value
    row.appendChild(lbl)
    row.appendChild(val)
    contentB.appendChild(row)
  }
}

/** Remove the B-side overlay anchor from the DOM. */
export function destroyOverlayB(): void {
  anchorB?.remove()
  anchorB = null
  speedValueB = null
  gearValueB = null
  throttleFillB = null
  brakeFillB = null
  gpsLatB = null
  gpsLonB = null
  gpsAltB = null
  rpmSvgB = null
  gforceCanvasB = null
  steeringSvgB = null
  steeringLabelB = null
  hudBActive = false
}

// Display values for each overlay when visible — mirrors the per-ID CSS rules in styles.css
const OVERLAY_DISPLAY: Partial<Record<OverlayKey, string>> = {
  speed: 'flex',
  rpmGauge: 'block',
  rpmBar: 'block',
  gear: 'flex',
  steering: 'block',
  gforce: 'block',
  pedals: 'flex',
  gps: 'flex',
  trackMap: 'block',
  session: 'flex',
}

/** Apply overlay visibility config to the B anchor via inline styles (no CSS ID rules needed). */
export function applyOverlayConfigB(config: OverlayConfig): void {
  if (!anchorB) return
  for (const el of anchorB.querySelectorAll<HTMLElement>('.hud-element[data-overlay]')) {
    const key = el.dataset.overlay as OverlayKey
    if (key in config) {
      el.style.display = config[key] ? (OVERLAY_DISPLAY[key] ?? 'block') : 'none'
    }
  }
}

/**
 * Position the B anchor to cover video B's rendered area.
 * Uses the same object-fit:contain math as the A anchor.
 */
export function updateAnchorBBounds(videoB: HTMLVideoElement): void {
  if (!anchorB) return

  const vw = videoB.videoWidth
  const vh = videoB.videoHeight
  const cw = videoB.clientWidth
  const ch = videoB.clientHeight

  if (!cw || !ch) return

  if (!vw || !vh) {
    anchorB.style.left = `${videoB.offsetLeft}px`
    anchorB.style.top = '0px'
    anchorB.style.width = `${cw}px`
    anchorB.style.height = `${ch}px`
    anchorB.style.transform = ''
    return
  }

  const videoAR = vw / vh
  const containerAR = cw / ch
  let rw: number, rh: number
  if (videoAR > containerAR) {
    rw = cw
    rh = cw / videoAR
  } else {
    rw = ch * videoAR
    rh = ch
  }

  const scaleFactor = rw / vw
  // video B starts at videoB.offsetLeft within the container
  anchorB.style.left = `${videoB.offsetLeft + (cw - rw) / 2}px`
  anchorB.style.top = `${(ch - rh) / 2}px`
  anchorB.style.width = `${vw}px`
  anchorB.style.height = `${vh}px`
  anchorB.style.transform = `scale(${scaleFactor})`
  anchorB.style.transformOrigin = '0 0'
}

/** Update B-side DOM text + set smoothing targets from a telemetry row. */
export function updateOverlayBRow(row: TelemetryRow | null): void {
  if (!anchorB) return

  if (!row) {
    if (speedValueB) speedValueB.textContent = '--'
    if (gearValueB) gearValueB.textContent = '-'
    if (throttleFillB) throttleFillB.style.width = '0%'
    if (brakeFillB) brakeFillB.style.width = '0%'
    hudBActive = false
    return
  }

  hudBActive = true

  targetRpmB = row.rpm
  targetSteeringB = row.steering_deg
  targetGLatB = row.gforce_lat
  targetGLonB = row.gforce_lon

  if (speedValueB) speedValueB.textContent = Math.round(row.speed_mph).toString()

  if (row.gear !== undefined) lastKnownGearB = resolveGearDisplay(row.gear)
  if (gearValueB) gearValueB.textContent = lastKnownGearB

  if (throttleFillB) throttleFillB.style.width = `${(row.throttle * 100).toFixed(0)}%`
  if (brakeFillB) brakeFillB.style.width = `${(getBrakeDisplay(row.brake) * 100).toFixed(0)}%`

  if (gpsLatB) gpsLatB.textContent = row.lat.toFixed(6)
  if (gpsLonB) gpsLonB.textContent = row.lon.toFixed(6)
  if (gpsAltB) gpsAltB.textContent = `${row.altitude_m.toFixed(0)}m`
}

/**
 * Smooth-lerp B-side canvas indicators toward targets and draw them.
 * Call every animation frame (after updateOverlayBRow).
 */
export function smoothAndDrawB(
  interpPrevB: { rpm: number, steering_deg: number, gforce_lat: number, gforce_lon: number } | null,
  interpNextB: { rpm: number, steering_deg: number, gforce_lat: number, gforce_lon: number } | null,
  interpAlphaB: number,
): void {
  if (!anchorB || !hudBActive) return

  const now = performance.now()
  const dt = lastFrameTimeB ? (now - lastFrameTimeB) / 1000 : 0.016
  lastFrameTimeB = now

  if (interpPrevB && interpNextB && interpPrevB !== interpNextB) {
    const a = interpAlphaB
    targetRpmB = interpPrevB.rpm + (interpNextB.rpm - interpPrevB.rpm) * a
    targetSteeringB = interpPrevB.steering_deg + (interpNextB.steering_deg - interpPrevB.steering_deg) * a
    targetGLatB = interpPrevB.gforce_lat + (interpNextB.gforce_lat - interpPrevB.gforce_lat) * a
    targetGLonB = interpPrevB.gforce_lon + (interpNextB.gforce_lon - interpPrevB.gforce_lon) * a
  }

  const alpha = 1 - Math.exp(-SMOOTH_RATE * dt)
  displayedRpmB += (targetRpmB - displayedRpmB) * alpha
  displayedSteeringB += (targetSteeringB - displayedSteeringB) * alpha
  displayedGLatB += (targetGLatB - displayedGLatB) * alpha
  displayedGLonB += (targetGLonB - displayedGLonB) * alpha

  if (rpmSvgB) drawRpmGauge(displayedRpmB, rpmSvgB, rpmConfigB)
  if (steeringSvgB && steeringLabelB) drawSteering(displayedSteeringB, steeringSvgB, steeringLabelB)
  if (gforceCanvasB) drawGForce(displayedGLatB, displayedGLonB, gforceCanvasB)
}

/**
 * Copy inline position styles from A-side overlay elements to their B-side clones.
 * Call after edit-mode drag/resize to keep both sides in sync.
 */
export function syncPositionsToB(overlayAnchorA: HTMLDivElement): void {
  if (!anchorB) return
  for (const elA of overlayAnchorA.querySelectorAll<HTMLElement>('.hud-element[data-overlay]')) {
    const key = elA.dataset.overlay
    if (!key) continue
    const elB = anchorB.querySelector<HTMLElement>(`.hud-element[data-overlay="${key}"]`)
    if (!elB) continue
    elB.style.left = elA.style.left
    elB.style.top = elA.style.top
    elB.style.right = elA.style.right
    elB.style.bottom = elA.style.bottom
    elB.style.transform = elA.style.transform
    elB.style.transformOrigin = elA.style.transformOrigin
  }
}

/** Returns the B overlay anchor element (for positioning and visibility). */
export function getAnchorB(): HTMLDivElement | null {
  return anchorB
}
