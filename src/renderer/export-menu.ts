/**
 * OpenPDR Viewer — Export dropdown menu
 *
 * Toolbar button + dropdown with CSV and GPX export options.
 * Supports full recording and per-lap export when laps are detected.
 */

import type { ExportScope } from './types'
import { telemetryStore, lapData, onTelemetryLoad } from './state'

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

async function doExport(format: 'csv' | 'gpx', scope: ExportScope): Promise<void> {
  try {
    if (format === 'csv') {
      await window.pdr.exportCsv(scope)
    } else {
      await window.pdr.exportGpx(scope)
    }
  } catch (err) {
    console.error(`Export ${format} failed:`, err)
  }
}
