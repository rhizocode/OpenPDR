/**
 * OpenPDR Viewer — Overlay settings dropdown
 *
 * Settings panel for configuring RPM gauge zones.
 * HUD overlay toggles have moved to the Edit panel (edit-mode.ts).
 */

import type { OverlayConfig, RpmConfig } from './types'
import { applyOverlayConfig, getOverlayConfig, setOverlayConfig } from './hud'
import { saveRpmConfig, getRpmConfig, loadRpmConfig } from './rpm-gauge'

const OVERLAY_STORAGE_KEY = 'pdr-overlay-config'

export function initOverlaySettings(): void {
  const config = getOverlayConfig()
  const rpmConfig = loadRpmConfig()

  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement
  const panel = document.getElementById('overlay-settings-panel') as HTMLDivElement

  // Build settings panel content (RPM zones only)
  buildPanel(panel, rpmConfig)

  // Apply initial config
  applyOverlayConfig(config)

  // Toggle panel visibility
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation()
    panel.classList.toggle('visible')
    // Close edit panel when opening settings
    document.getElementById('edit-panel')?.classList.remove('visible')
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
      const config = getOverlayConfig()
      const allOn = Object.values(config).every(v => v)
      const keys = Object.keys(config) as (keyof OverlayConfig)[]
      for (const key of keys) {
        config[key] = !allOn
      }
      setOverlayConfig(config)
      applyOverlayConfig(config)
      localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(config))
      // Update edit panel checkboxes if they exist
      for (const cb of document.querySelectorAll<HTMLInputElement>('input[data-edit-overlay-key]')) {
        cb.checked = !allOn
      }
    }
  })
}

function buildPanel(panel: HTMLDivElement, rpmConfig: RpmConfig): void {
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
