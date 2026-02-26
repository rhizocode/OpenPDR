/**
 * OpenPDR Viewer — Overlay settings dropdown
 *
 * Settings panel for toggling HUD overlay elements and configuring
 * RPM gauge zones. Persists to localStorage.
 */

import type { OverlayConfig, RpmConfig } from './types'
import { applyOverlayConfig } from './hud'
import { saveRpmConfig, getRpmConfig, loadRpmConfig } from './rpm-gauge'

const OVERLAY_STORAGE_KEY = 'pdr-overlay-config'

const DEFAULT_OVERLAY: OverlayConfig = {
  speed: true,
  rpmGauge: true,
  gear: true,
  gforce: true,
  pedals: true,
  steering: true,
  gps: true,
}

const OVERLAY_LABELS: Record<keyof OverlayConfig, string> = {
  speed: 'Speed',
  rpmGauge: 'RPM Gauge',
  gear: 'Gear',
  gforce: 'G-Force',
  pedals: 'Pedals',
  steering: 'Steering',
  gps: 'GPS',
}

let config: OverlayConfig

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

function saveOverlayConfig(): void {
  localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(config))
}

export function initOverlaySettings(): void {
  config = loadOverlayConfig()
  const rpmConfig = loadRpmConfig()

  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement
  const panel = document.getElementById('overlay-settings-panel') as HTMLDivElement

  // Build settings panel content
  buildPanel(panel, rpmConfig)

  // Apply initial config
  applyOverlayConfig(config)

  // Toggle panel visibility
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation()
    panel.classList.toggle('visible')
  })

  // Close panel when clicking outside
  document.addEventListener('pointerdown', (e) => {
    if (!panel.contains(e.target as Node) && e.target !== btnSettings) {
      panel.classList.remove('visible')
    }
  })

  // Keyboard shortcut: H to toggle all HUD
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return

    if (e.code === 'KeyH') {
      // Toggle all overlays
      const allOn = Object.values(config).every(v => v)
      const keys = Object.keys(config) as (keyof OverlayConfig)[]
      for (const key of keys) {
        config[key] = !allOn
      }
      applyOverlayConfig(config)
      saveOverlayConfig()
      // Update checkboxes
      for (const cb of panel.querySelectorAll<HTMLInputElement>('input[data-overlay-key]')) {
        cb.checked = !allOn
      }
    }
  })
}

function buildPanel(panel: HTMLDivElement, rpmConfig: RpmConfig): void {
  // HUD toggles section
  const hudSection = document.createElement('div')
  hudSection.className = 'settings-section'
  hudSection.innerHTML = '<div class="settings-section-title">HUD Overlays</div>'

  for (const [key, label] of Object.entries(OVERLAY_LABELS)) {
    const row = document.createElement('div')
    row.className = 'settings-row'

    const lbl = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = config[key as keyof OverlayConfig]
    cb.setAttribute('data-overlay-key', key)
    cb.addEventListener('change', () => {
      config[key as keyof OverlayConfig] = cb.checked
      applyOverlayConfig(config)
      saveOverlayConfig()
    })

    lbl.appendChild(cb)
    lbl.appendChild(document.createTextNode(label))
    row.appendChild(lbl)
    hudSection.appendChild(row)
  }
  panel.appendChild(hudSection)

  // RPM zones section
  const rpmSection = document.createElement('div')
  rpmSection.className = 'settings-section'
  rpmSection.innerHTML = '<div class="settings-section-title">RPM Zones</div>'

  rpmSection.appendChild(buildNumberRow('Yellow Zone', rpmConfig.yellowStart, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, yellowStart: val })
  }))

  rpmSection.appendChild(buildNumberRow('Redline', rpmConfig.redline, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, redline: val })
  }))

  rpmSection.appendChild(buildNumberRow('Max RPM', rpmConfig.maxRpm, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, maxRpm: val })
  }))

  panel.appendChild(rpmSection)
}

function buildNumberRow(label: string, value: number, onChange: (val: number) => void): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'settings-row'

  const lbl = document.createElement('label')
  lbl.textContent = label

  const input = document.createElement('input')
  input.type = 'number'
  input.value = value.toString()
  input.step = '100'
  input.min = '0'
  input.max = '15000'
  input.addEventListener('change', () => {
    const val = parseInt(input.value, 10)
    if (!isNaN(val) && val > 0) {
      onChange(val)
    }
  })

  row.appendChild(lbl)
  row.appendChild(input)
  return row
}
