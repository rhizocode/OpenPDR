/**
 * OpenPDR Viewer — Export functionality
 *
 * CSV, GPX, and Video export options.
 * Panel content is built by exported functions called from gear-menu.ts.
 * Supports full recording and per-lap export when laps are detected.
 */

import type { ExportScope, VideoExportOptions, OverlayConfig, OverlayLayout, RpmConfig } from './types'
import { telemetryStore, lapData } from './state'

// localStorage keys (match hud.ts, edit-mode.ts, rpm-gauge.ts)
const OVERLAY_CONFIG_KEY = 'pdr-overlay-config'
const OVERLAY_LAYOUT_KEY = 'pdr-overlay-layout'
const RPM_CONFIG_KEY = 'pdr-rpm-config'

const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  speed: true, rpmGauge: true, gear: true, gforce: true,
  pedals: true, steering: true, gps: true, trackMap: true,
  session: true,
}

const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = {
  speed:    { left: 1.5, top: 82, scale: 1 },
  rpmGauge: { left: 13,  top: 78, scale: 1 },
  gear:     { left: 27,  top: 82, scale: 1 },
  steering: { left: 33,  top: 76, scale: 1 },
  gforce:   { left: 82,  top: 68, scale: 1 },
  pedals:   { left: 68,  top: 84, scale: 1 },
  gps:      { left: 85,  top: 2,  scale: 1 },
  trackMap: { left: 1.5, top: 2,  scale: 1 },
  session:  { left: 50,  top: 2,  scale: 1 },
}

const DEFAULT_RPM_CONFIG: RpmConfig = {
  yellowStart: 5500,
  redline: 6500,
  maxRpm: 7000,
}

/** Read current overlay/layout/RPM config from localStorage */
function getVideoExportOptions(): VideoExportOptions {
  let overlayConfig = DEFAULT_OVERLAY_CONFIG
  let overlayLayout = DEFAULT_OVERLAY_LAYOUT
  let rpmConfig = DEFAULT_RPM_CONFIG

  try {
    const saved = localStorage.getItem(OVERLAY_CONFIG_KEY)
    if (saved) overlayConfig = { ...DEFAULT_OVERLAY_CONFIG, ...JSON.parse(saved) }
  } catch { /* use defaults */ }

  try {
    const saved = localStorage.getItem(OVERLAY_LAYOUT_KEY)
    if (saved) overlayLayout = { ...DEFAULT_OVERLAY_LAYOUT, ...JSON.parse(saved) }
  } catch { /* use defaults */ }

  try {
    const saved = localStorage.getItem(RPM_CONFIG_KEY)
    if (saved) rpmConfig = { ...DEFAULT_RPM_CONFIG, ...JSON.parse(saved) }
  } catch { /* use defaults */ }

  return { overlayConfig, overlayLayout, rpmConfig }
}

// ── Export Progress UI ──

const EXPORT_PHASES = ['Analyze video', 'Encoding video'] as const

let exportProgressEl: HTMLDivElement | null = null
let phaseStartTime = 0
let currentPhase = ''
let smoothedEta = 0

function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.ceil(seconds)}s remaining`
  const m = Math.floor(seconds / 60)
  const s = Math.ceil(seconds % 60)
  return `~${m}:${s.toString().padStart(2, '0')} remaining`
}

function ensureExportProgressEl(): HTMLDivElement {
  if (exportProgressEl) return exportProgressEl

  const el = document.createElement('div')
  el.id = 'export-progress'
  el.innerHTML =
    '<div class="ep-title">Exporting Video</div>' +
    '<div class="ep-steps"></div>' +
    '<div class="ep-bar"><div class="ep-bar-fill"></div></div>' +
    '<div class="ep-info"><span class="ep-pct"></span><span class="ep-eta"></span></div>' +
    '<button class="ep-cancel">Cancel</button>'

  document.getElementById('video-container')!.appendChild(el)

  el.querySelector('.ep-cancel')!.addEventListener('click', () => {
    window.pdr.cancelVideoExport()
    hideExportProgress()
  })

  exportProgressEl = el
  return el
}

function showExportProgress(): void {
  const el = ensureExportProgressEl()
  currentPhase = ''
  phaseStartTime = 0
  el.style.display = 'flex'
  updateExportSteps('', 0)
}

function hideExportProgress(): void {
  if (exportProgressEl) exportProgressEl.style.display = ''
}

function updateExportSteps(phase: string, pct: number): void {
  const el = ensureExportProgressEl()
  const phaseIdx = EXPORT_PHASES.indexOf(phase as typeof EXPORT_PHASES[number])

  // Steps
  const stepsHtml = EXPORT_PHASES.map((p, i) => {
    let icon: string, cls: string
    if (i < phaseIdx) { icon = '\u2713'; cls = 'done' }
    else if (i === phaseIdx) { icon = '\u25B8'; cls = 'active' }
    else { icon = '\u25CB'; cls = 'pending' }
    return `<div class="ep-step ${cls}"><span class="ep-step-icon">${icon}</span> ${p}</div>`
  }).join('')
  el.querySelector('.ep-steps')!.innerHTML = stepsHtml

  // Progress bar
  const fill = el.querySelector('.ep-bar-fill') as HTMLDivElement
  fill.style.width = `${pct}%`

  // Percentage
  el.querySelector('.ep-pct')!.textContent = `${pct}%`

  // ETA — smoothed with exponential moving average to avoid jumpiness
  const elapsed = (performance.now() - phaseStartTime) / 1000
  let etaText = ''
  if (pct > 2 && elapsed > 0.5) {
    const rawEta = (100 - pct) / (pct / elapsed)
    smoothedEta = smoothedEta > 0 ? smoothedEta * 0.8 + rawEta * 0.2 : rawEta
    etaText = formatEta(smoothedEta)
  }
  el.querySelector('.ep-eta')!.textContent = etaText
}

function onExportProgress(phase: string, pct: number): void {
  if (phase === 'Complete') { hideExportProgress(); return }

  if (phase !== currentPhase) {
    currentPhase = phase
    phaseStartTime = performance.now()
    smoothedEta = 0
  }
  updateExportSteps(phase, pct)
}

// ── Init (export progress listener only) ──

export function initExportMenu(): void {
  window.pdr.onExportVideoProgress(onExportProgress)
}

// ── Panel building (called by gear-menu) ──

/** Build export panel content based on current telemetry/lap state */
export function buildExportPanel(container: HTMLDivElement): void {
  container.innerHTML = ''

  if (!telemetryStore) {
    const empty = document.createElement('div')
    empty.className = 'export-empty'
    empty.textContent = 'Load a file to export'
    container.appendChild(empty)
    return
  }

  const laps = lapData?.hasLapData ? lapData.laps : []

  // CSV section
  addSectionTitle(container, 'CSV')
  addItem(container, 'Full Recording', () => doExport('csv', { type: 'full' }))
  for (const lap of laps) {
    addItem(container, `Lap ${lap.lapNumber}`, () =>
      doExport('csv', { type: 'lap', lapNumber: lap.lapNumber })
    )
  }

  // GPX section
  addSectionTitle(container, 'GPX')
  addItem(container, 'Full Recording', () => doExport('gpx', { type: 'full' }))
  for (const lap of laps) {
    addItem(container, `Lap ${lap.lapNumber}`, () =>
      doExport('gpx', { type: 'lap', lapNumber: lap.lapNumber })
    )
  }

  // Video section
  addSectionTitle(container, 'Video (with overlays)')
  addItem(container, 'Full Recording', () => doExport('video', { type: 'full' }))
  for (const lap of laps) {
    addItem(container, `Lap ${lap.lapNumber}`, () =>
      doExport('video', { type: 'lap', lapNumber: lap.lapNumber })
    )
  }
}

function addSectionTitle(parent: HTMLElement, text: string): void {
  const el = document.createElement('div')
  el.className = 'export-section-title'
  el.textContent = text
  parent.appendChild(el)
}

function addItem(parent: HTMLElement, label: string, onClick: () => void): void {
  const el = document.createElement('div')
  el.className = 'export-item'
  el.textContent = label
  el.addEventListener('click', () => {
    // Close the gear panel
    document.getElementById('gear-panel')?.classList.remove('visible')
    document.getElementById('btn-gear')?.classList.remove('active')
    onClick()
  })
  parent.appendChild(el)
}

async function doExport(format: 'csv' | 'gpx' | 'video', scope: ExportScope): Promise<void> {
  try {
    if (format === 'csv') {
      await window.pdr.exportCsv(scope)
    } else if (format === 'gpx') {
      await window.pdr.exportGpx(scope)
    } else {
      const options = getVideoExportOptions()
      showExportProgress()
      const success = await window.pdr.exportVideo(scope, options)
      if (!success) hideExportProgress()
    }
  } catch (err) {
    hideExportProgress()
    console.error(`Export ${format} failed:`, err)
  }
}
