/**
 * OpenPDR Viewer — Overlay settings
 *
 * RPM gauge zone configuration and A/V sync offset.
 * Panel content is built by exported functions called from gear-menu.ts.
 * HUD overlay toggles are in the Edit panel (edit-mode.ts).
 */

import type { OverlayConfig } from './types'
import type { BrakeMode } from './defaults'
import { applyOverlayConfig, getOverlayConfig, setOverlayConfig } from './hud'
import { saveRpmConfig, getRpmConfig, loadRpmConfig, getDetectedEngine, isManualOverride, setManualOverride } from './rpm-gauge'
import { avSyncOffset, setAvSyncOffset } from './state'
import { STORAGE_KEYS } from './storage-keys'
import { getBrakeMode, setBrakeMode } from './defaults'

const OVERLAY_STORAGE_KEY = STORAGE_KEYS.overlayConfig

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
  container.innerHTML = ''
  const rpmConfig = getRpmConfig()
  const detected = getDetectedEngine()

  // Detection status row
  const statusRow = document.createElement('div')
  statusRow.className = 'settings-row'
  const statusLabel = document.createElement('label')
  statusLabel.textContent = 'Detected'
  const statusValue = document.createElement('span')
  statusValue.className = 'rpm-detected-engine'
  statusValue.textContent = detected
    ? `${detected.label} (${detected.redline} RPM)`
    : 'No file loaded'
  statusRow.appendChild(statusLabel)
  statusRow.appendChild(statusValue)
  container.appendChild(statusRow)

  // Manual override checkbox
  const overrideRow = document.createElement('div')
  overrideRow.className = 'settings-row'
  const overrideLabel = document.createElement('label')
  overrideLabel.textContent = 'Manual Override'
  const overrideCb = document.createElement('input')
  overrideCb.type = 'checkbox'
  overrideCb.checked = isManualOverride()
  overrideCb.addEventListener('change', () => {
    setManualOverride(overrideCb.checked)
    buildRpmPanel(container)
  })
  overrideRow.appendChild(overrideLabel)
  overrideRow.appendChild(overrideCb)
  container.appendChild(overrideRow)

  // Redline and Max RPM inputs (disabled when auto-detected and not overridden)
  const inputsDisabled = !!detected && !isManualOverride()

  container.appendChild(buildNumberRow('Redline', rpmConfig.redline, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, redline: val })
  }, inputsDisabled))

  container.appendChild(buildNumberRow('Max RPM', rpmConfig.maxRpm, (val) => {
    const c = getRpmConfig()
    saveRpmConfig({ ...c, maxRpm: val })
  }, inputsDisabled))
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

/* ── Font size scaling ── */

const FONT_SIZE_KEY = STORAGE_KEYS.fontSize
const DEFAULT_SIZE = 100          // percent
const MIN_SIZE = 50
const MAX_SIZE = 300
const STEP = 10

/** CSS selectors for UI chrome — overlays are intentionally excluded */
const UI_SELECTORS = [
  '#toolbar', '#controls', '#chart-panel',
  '#no-file-prompt', '#parse-progress', '#debug-panel',
]

/** Gear panel scales at 75% of the main UI scale to match toolbar button size */
const GEAR_PANEL_RATIO = 0.75

let fontStyleEl: HTMLStyleElement | null = null
let currentFontScale = DEFAULT_SIZE
const fontScaleListeners: Array<() => void> = []

/** Current font scale as a multiplier (1.0 = 100%) */
export function getFontScale(): number { return currentFontScale / 100 }

/** Register a callback fired when font scale changes */
export function onFontScaleChange(cb: () => void): void { fontScaleListeners.push(cb) }

function applyFontScale(pct: number): void {
  currentFontScale = pct
  if (!fontStyleEl) {
    fontStyleEl = document.createElement('style')
    fontStyleEl.id = 'ui-font-scale'
    document.head.appendChild(fontStyleEl)
  }
  const gearPct = Math.round(pct * GEAR_PANEL_RATIO)
  fontStyleEl.textContent = UI_SELECTORS
    .map(s => `${s} { font-size: ${pct}%; }`)
    .join('\n') + `\n#gear-panel { font-size: ${gearPct}%; }`
  for (const cb of fontScaleListeners) cb()
}

export function initFontScale(): void {
  const saved = localStorage.getItem(FONT_SIZE_KEY)
  if (saved) {
    const pct = parseInt(saved, 10)
    if (!isNaN(pct) && pct >= MIN_SIZE && pct <= MAX_SIZE) {
      applyFontScale(pct)
    }
  }
}

/** Build font-size +/- stepper into the provided container */
export function buildFontSizePanel(container: HTMLDivElement): void {
  const saved = localStorage.getItem(FONT_SIZE_KEY)
  let current = saved ? parseInt(saved, 10) : DEFAULT_SIZE
  if (isNaN(current) || current < MIN_SIZE || current > MAX_SIZE) current = DEFAULT_SIZE

  const row = document.createElement('div')
  row.className = 'settings-row font-size-row'

  const label = document.createElement('label')
  label.textContent = 'Font Scale'

  const minus = document.createElement('button')
  minus.className = 'font-size-btn'
  minus.textContent = '\u2212'   // minus sign
  minus.title = 'Decrease'

  const display = document.createElement('span')
  display.className = 'font-size-display'
  display.textContent = `${current}%`

  const plus = document.createElement('button')
  plus.className = 'font-size-btn'
  plus.textContent = '+'
  plus.title = 'Increase'

  function update(pct: number): void {
    current = Math.max(MIN_SIZE, Math.min(MAX_SIZE, pct))
    display.textContent = `${current}%`
    minus.disabled = current <= MIN_SIZE
    plus.disabled = current >= MAX_SIZE
    applyFontScale(current)
    localStorage.setItem(FONT_SIZE_KEY, current.toString())
  }

  minus.addEventListener('click', () => update(current - STEP))
  plus.addEventListener('click', () => update(current + STEP))

  // Set initial disabled state
  minus.disabled = current <= MIN_SIZE
  plus.disabled = current >= MAX_SIZE

  row.appendChild(label)
  row.appendChild(minus)
  row.appendChild(display)
  row.appendChild(plus)
  container.appendChild(row)
}

/** Build Brake Display mode toggle (Raw / Enhanced) */
export function buildBrakeDisplayPanel(container: HTMLDivElement): void {
  container.innerHTML = ''

  const row = document.createElement('div')
  row.className = 'settings-row'

  const label = document.createElement('label')
  label.textContent = 'Mode'

  const select = document.createElement('select')
  const options: { value: BrakeMode; label: string }[] = [
    { value: 'enhanced', label: 'Enhanced' },
    { value: 'raw', label: 'Raw Pedal' },
  ]
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    select.appendChild(el)
  }
  select.value = getBrakeMode()
  select.addEventListener('change', () => {
    setBrakeMode(select.value as BrakeMode)
  })

  row.appendChild(label)
  row.appendChild(select)
  container.appendChild(row)

  const hint = document.createElement('div')
  hint.className = 'settings-hint'
  hint.textContent = 'Enhanced scales pedal travel to braking effort. Raw shows true pedal position.'
  container.appendChild(hint)
}

function buildNumberRow(label: string, value: number, onChange: (val: number) => void, disabled = false): HTMLDivElement {
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
  input.disabled = disabled
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
