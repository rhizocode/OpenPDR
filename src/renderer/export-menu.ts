/**
 * OpenPDR Viewer — Export dropdown menu
 *
 * Toolbar button + dropdown with CSV, GPX, and Video export options.
 * Supports full recording and per-lap export when laps are detected.
 */

import type { ExportScope, VideoExportOptions, OverlayConfig, OverlayLayout, RpmConfig } from './types'
import { telemetryStore, lapData, onTelemetryLoad } from './state'

// localStorage keys (match hud.ts, edit-mode.ts, rpm-gauge.ts)
const OVERLAY_CONFIG_KEY = 'pdr-overlay-config'
const OVERLAY_LAYOUT_KEY = 'pdr-overlay-layout'
const RPM_CONFIG_KEY = 'pdr-rpm-config'

const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  speed: true, rpmGauge: true, gear: true, gforce: true,
  pedals: true, steering: true, gps: true, trackMap: true,
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

// ── Progress UI ──

const progressOverlay = document.getElementById('parse-progress') as HTMLDivElement

function showProgress(phase: string, pct: number): void {
  progressOverlay.textContent = `${phase}... ${pct}%`
  progressOverlay.style.display = 'flex'
}

function hideProgress(): void {
  progressOverlay.style.display = ''
  progressOverlay.textContent = ''
}

export function initExportMenu(): void {
  const btn = document.getElementById('btn-export') as HTMLButtonElement
  const panel = document.getElementById('export-panel') as HTMLDivElement

  // Enable button and rebuild dropdown when a file is loaded
  onTelemetryLoad(() => {
    btn.disabled = !telemetryStore
    buildPanel(panel)
  })

  // Toggle dropdown
  btn.addEventListener('click', (e) => {
    if (btn.disabled) return
    e.stopPropagation()
    panel.classList.toggle('visible')
    // Close other panels
    document.getElementById('overlay-settings-panel')?.classList.remove('visible')
    document.getElementById('edit-panel')?.classList.remove('visible')
  })

  // Close on outside click
  document.addEventListener('pointerdown', (e) => {
    if (!panel.contains(e.target as Node) && e.target !== btn) {
      panel.classList.remove('visible')
    }
  })

  // Listen for video export progress from main process
  window.pdr.onExportVideoProgress((phase, pct) => {
    if (phase === 'Complete') {
      hideProgress()
    } else {
      showProgress(phase, pct)
    }
  })
}

function buildPanel(panel: HTMLDivElement): void {
  panel.innerHTML = ''

  const laps = lapData?.hasLapData ? lapData.laps : []

  // CSV section
  addSectionTitle(panel, 'CSV')
  addItem(panel, 'Full Recording', () => doExport('csv', { type: 'full' }))
  for (const lap of laps) {
    addItem(panel, `Lap ${lap.lapNumber}`, () =>
      doExport('csv', { type: 'lap', lapNumber: lap.lapNumber })
    )
  }

  // GPX section
  addSectionTitle(panel, 'GPX')
  addItem(panel, 'Full Recording', () => doExport('gpx', { type: 'full' }))
  for (const lap of laps) {
    addItem(panel, `Lap ${lap.lapNumber}`, () =>
      doExport('gpx', { type: 'lap', lapNumber: lap.lapNumber })
    )
  }

  // Video section
  addSectionTitle(panel, 'Video (with overlays)')
  addItem(panel, 'Full Recording', () => doExport('video', { type: 'full' }))
  for (const lap of laps) {
    addItem(panel, `Lap ${lap.lapNumber}`, () =>
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
    parent.classList.remove('visible')
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
      showProgress('Starting export', 0)
      const success = await window.pdr.exportVideo(scope, options)
      if (!success) hideProgress()
    }
  } catch (err) {
    hideProgress()
    console.error(`Export ${format} failed:`, err)
  }
}
