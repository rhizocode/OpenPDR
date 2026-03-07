/**
 * OpenPDR Viewer — HUD manager
 *
 * Coordinates all HUD overlay elements: speed, RPM gauge, gear, g-force,
 * pedals, steering, GPS. Handles carry-forward for sparse-rate channels
 * and applies overlay visibility config.
 *
 * Each overlay is an independent absolutely-positioned .hud-element
 * inside #video-container (no flex wrapper).
 */

import type { TelemetryRow, OverlayConfig, OverlayKey } from './types'
import { onRowUpdate, onTelemetryLoad, onFrameTick, currentRow, interpPrev, interpNext, interpAlpha, sessionInfo } from './state'
import { initGForceBall, drawGForce } from './gforce-ball'
import { initRpmGauge, drawRpmGauge } from './rpm-gauge'
import { initRpmBar, drawRpmBar } from './rpm-bar'
import { initSteeringIndicator, drawSteering } from './steering'
import { applyOverlayConfigB } from './compare-overlay-b'
import { isCompareMode, rpmConfigA } from './compare-state'
import { DEFAULT_OVERLAY, resolveGearDisplay, formatTimestamp, getBrakeDisplay } from './defaults'
import { STORAGE_KEYS } from './storage-keys'

const OVERLAY_STORAGE_KEY = STORAGE_KEYS.overlayConfig

// ── DOM refs ──
const hudSpeedValue = document.getElementById('hud-speed-value') as HTMLSpanElement
const hudGearValue = document.getElementById('hud-gear-value') as HTMLSpanElement
const throttleFill = document.getElementById('throttle-fill') as HTMLDivElement
const brakeFill = document.getElementById('brake-fill') as HTMLDivElement
const videoContainer = document.getElementById('video-container') as HTMLDivElement
const gpsLat = document.getElementById('hud-gps-lat') as HTMLSpanElement
const gpsLon = document.getElementById('hud-gps-lon') as HTMLSpanElement
const gpsAlt = document.getElementById('hud-gps-alt') as HTMLSpanElement
const sessionContent = document.getElementById('hud-session-content') as HTMLDivElement

// ── Overlay config (cached for skipping disabled canvas draws) ──
let overlayConfig: OverlayConfig = loadOverlayConfig()

function loadOverlayConfig(): OverlayConfig {
  const saved = localStorage.getItem(OVERLAY_STORAGE_KEY)
  if (saved) {
    try {
      return { ...DEFAULT_OVERLAY, ...JSON.parse(saved) }
    } catch {
      return { ...DEFAULT_OVERLAY }
    }
  }
  return { ...DEFAULT_OVERLAY }
}

export function getOverlayConfig(): OverlayConfig {
  return { ...overlayConfig }
}

export function setOverlayConfig(config: OverlayConfig): void {
  overlayConfig = { ...config }
}

// ── Smoothing for canvas-drawn indicators ──
// Target values come from telemetry (discrete 100Hz). Displayed values
// lerp toward targets every animation frame for smooth visual movement.
const SMOOTH_RATE = 80  // exponential decay rate (per second) — higher = snappier

let targetRpm = 0, displayedRpm = 0
let targetSteeringDeg = 0, displayedSteeringDeg = 0
let targetGLat = 0, displayedGLat = 0
let targetGLon = 0, displayedGLon = 0
let lastFrameTime = 0
let hudActive = false  // true after first telemetry row received

// ── Gear label → display mapping (from defaults.ts) ──

// ── Carry-forward state for sparse channels ──
let lastKnownGear = '-'

// ── Shift indicator ──
const shiftArrow = document.getElementById('hud-shift-arrow') as HTMLSpanElement
let shiftFlashTimer: ReturnType<typeof setTimeout> | null = null

/** Numeric rank for numbered gears; non-numbered gears return -1 */
function gearRank(display: string): number {
  const n = parseInt(display, 10)
  return Number.isNaN(n) ? -1 : n
}

function flashShift(direction: 'up' | 'down'): void {
  // Cancel any in-progress flash
  if (shiftFlashTimer) { clearTimeout(shiftFlashTimer); shiftFlashTimer = null }
  shiftArrow.className = 'shift-arrow'  // reset
  shiftArrow.textContent = direction === 'up' ? '\u25B2' : '\u25BC'   // ▲ or ▼
  // Force reflow so animation restarts
  void shiftArrow.offsetWidth
  shiftArrow.classList.add(direction === 'up' ? 'upshift' : 'downshift', 'flash')
  shiftFlashTimer = setTimeout(() => {
    shiftArrow.className = 'shift-arrow'
    shiftFlashTimer = null
  }, 650)
}

export function resetCarryForward(): void {
  lastKnownGear = '-'
  if (shiftFlashTimer) { clearTimeout(shiftFlashTimer); shiftFlashTimer = null }
  shiftArrow.className = 'shift-arrow'
}

// ── Set target values + update cheap DOM elements (called on row change) ──
function updateHud(row: TelemetryRow | null): void {
  if (!row) {
    hudSpeedValue.textContent = '--'
    hudGearValue.textContent = '-'
    throttleFill.style.width = '0%'
    brakeFill.style.width = '0%'
    hudActive = false
    return
  }

  const wasActive = hudActive
  hudActive = true

  // Set smoothing targets (canvas elements drawn in smoothAndDraw)
  targetRpm = row.rpm
  targetSteeringDeg = row.steering_deg
  targetGLat = row.gforce_lat
  targetGLon = row.gforce_lon

  // First activation: snap displayed values and force-draw canvases
  if (!wasActive) {
    displayedRpm = targetRpm
    displayedSteeringDeg = targetSteeringDeg
    displayedGLat = targetGLat
    displayedGLon = targetGLon
    // Draw immediately (elements may already be visible via showHud)
    smoothAndDraw()
  }

  // Speed (cheap DOM text update)
  if (overlayConfig.speed) {
    hudSpeedValue.textContent = Math.round(row.speed_mph).toString()
  }

  // Gear (carry forward sparse value — cheap DOM text update + shift detection)
  if (row.gear !== undefined) {
    const newDisplay = resolveGearDisplay(row.gear)
    if (newDisplay !== lastKnownGear && overlayConfig.gear) {
      const prevRank = gearRank(lastKnownGear)
      const newRank = gearRank(newDisplay)
      if (prevRank > 0 && newRank > 0) {
        flashShift(newRank > prevRank ? 'up' : 'down')
      }
    }
    lastKnownGear = newDisplay
  }
  if (overlayConfig.gear) {
    hudGearValue.textContent = lastKnownGear
  }

  // Pedal bars (cheap DOM style update)
  if (overlayConfig.pedals) {
    throttleFill.style.width = `${(row.throttle * 100).toFixed(0)}%`
    brakeFill.style.width = `${(getBrakeDisplay(row.brake) * 100).toFixed(0)}%`
  }

  // GPS display (cheap DOM text update)
  if (overlayConfig.gps) {
    gpsLat.textContent = row.lat.toFixed(6)
    gpsLon.textContent = row.lon.toFixed(6)
    gpsAlt.textContent = `${row.altitude_m.toFixed(0)}m`
  }
}

// ── Lerp displayed values toward targets + draw canvases (called every frame) ──
function smoothAndDraw(): void {
  if (!hudActive) return

  const now = performance.now()
  const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0.016
  lastFrameTime = now

  // Interpolate targets between bracketing rows for frame-accurate movement.
  // This makes RPM/steering/g-force move continuously rather than stepping
  // every 100ms on row change.
  if (interpPrev && interpNext && interpPrev !== interpNext) {
    const a = interpAlpha
    targetRpm = interpPrev.rpm + (interpNext.rpm - interpPrev.rpm) * a
    targetSteeringDeg = interpPrev.steering_deg + (interpNext.steering_deg - interpPrev.steering_deg) * a
    targetGLat = interpPrev.gforce_lat + (interpNext.gforce_lat - interpPrev.gforce_lat) * a
    targetGLon = interpPrev.gforce_lon + (interpNext.gforce_lon - interpPrev.gforce_lon) * a
  }

  // Exponential smoothing on top of interpolated targets — just enough to
  // prevent single-frame jitter without adding perceptible lag.
  const alpha = 1 - Math.exp(-SMOOTH_RATE * dt)

  displayedRpm += (targetRpm - displayedRpm) * alpha
  displayedSteeringDeg += (targetSteeringDeg - displayedSteeringDeg) * alpha
  displayedGLat += (targetGLat - displayedGLat) * alpha
  displayedGLon += (targetGLon - displayedGLon) * alpha

  if (overlayConfig.rpmGauge) drawRpmGauge(displayedRpm, undefined, isCompareMode() ? rpmConfigA : undefined)
  if (overlayConfig.rpmBar) drawRpmBar(displayedRpm)
  if (overlayConfig.steering) drawSteering(displayedSteeringDeg)
  if (overlayConfig.gforce) drawGForce(displayedGLat, displayedGLon)
}

// ── Overlay visibility ──
export function applyOverlayConfig(config: OverlayConfig): void {
  overlayConfig = { ...config }
  // Each .hud-element has data-overlay matching a config key
  for (const el of videoContainer.querySelectorAll<HTMLElement>('.hud-element[data-overlay]')) {
    const key = el.dataset.overlay as OverlayKey
    if (key in config) {
      if (config[key]) {
        el.classList.add('active')
      } else {
        el.classList.remove('active')
      }
    }
  }
  // Keep B-side overlay visibility in sync
  applyOverlayConfigB(config)
}

export function showHud(): void {
  // Activate all overlays that are enabled in config
  applyOverlayConfig(overlayConfig)
  // Force-draw canvases if data was already seeded before elements became visible
  if (hudActive) smoothAndDraw()
}

// ── Session overlay (static — set once on file load) ──
function populateSessionOverlay(): void {
  sessionContent.innerHTML = ''
  const info = sessionInfo
  if (!info) return

  const dateStr = info.timestamp ? formatTimestamp(info.timestamp) : undefined

  // Combine year + vehicle into a single line, stripping parentheses
  // vehicle already includes model in parens, e.g. "Chevrolet (Corvette)"
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
    sessionContent.appendChild(row)
  }
}

// ── Initialize ──
export function initHud(): void {
  initGForceBall()
  initRpmGauge()
  initRpmBar()
  initSteeringIndicator()

  // Row change: set targets + update DOM text
  onRowUpdate(() => updateHud(currentRow))

  // Every frame: smooth-lerp canvas indicators toward targets
  onFrameTick(() => smoothAndDraw())

  // Session info: populate once when telemetry is loaded
  onTelemetryLoad(() => populateSessionOverlay())
}
