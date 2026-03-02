/**
 * OpenPDR Viewer — Overlay settings
 *
 * RPM gauge zone configuration and A/V sync offset.
 * Panel content is built by exported functions called from gear-menu.ts.
 * HUD overlay toggles are in the Edit panel (edit-mode.ts).
 */

import type { OverlayConfig, RpmConfig } from './types'
import { applyOverlayConfig, getOverlayConfig, setOverlayConfig } from './hud'
import { saveRpmConfig, getRpmConfig, loadRpmConfig } from './rpm-gauge'
import { avSyncOffset, setAvSyncOffset } from './state'

const OVERLAY_STORAGE_KEY = 'pdr-overlay-config'

export function initOverlaySettings(): void {
  loadRpmConfig()

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

/** Build RPM zones inputs into the provided container */
export function buildRpmPanel(container: HTMLDivElement): void {
  const rpmConfig = getRpmConfig()

  container.appendChild(buildNumberRow('Yellow Zone', rpmConfig.yellowStart, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, yellowStart: val })
  }))

  container.appendChild(buildNumberRow('Redline', rpmConfig.redline, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, redline: val })
  }))

  container.appendChild(buildNumberRow('Max RPM', rpmConfig.maxRpm, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, maxRpm: val })
  }))
}

/** Build A/V sync offset input into the provided container */
export function buildAvSyncPanel(container: HTMLDivElement): void {
  const syncRow = document.createElement('div')
  syncRow.className = 'settings-row'

  const syncLabel = document.createElement('label')
  syncLabel.textContent = 'Offset (ms)'
  syncLabel.title = 'Positive = telemetry leads video to match audio timing'

  const syncInput = document.createElement('input')
  syncInput.type = 'number'
  syncInput.value = Math.round(avSyncOffset * 1000).toString()
  syncInput.step = '25'
  syncInput.min = '-500'
  syncInput.max = '2000'
  syncInput.addEventListener('change', () => {
    const ms = parseInt(syncInput.value, 10)
    if (!isNaN(ms)) {
      setAvSyncOffset(ms / 1000)
    }
  })

  syncRow.appendChild(syncLabel)
  syncRow.appendChild(syncInput)
  container.appendChild(syncRow)
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
