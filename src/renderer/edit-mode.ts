/**
 * OpenPDR Viewer — Edit mode for overlay layout
 *
 * Allows repositioning and resizing HUD overlay elements via drag & drop.
 * Builds the edit panel UI with show/hide toggles and a reset-layout button.
 * Persists layout to localStorage.
 */

import type { OverlayConfig, OverlayKey, OverlayPosition, OverlayLayout } from './types'
import { getEditMode, setEditMode, onEditModeChange } from './state'
import { applyOverlayConfig, getOverlayConfig, setOverlayConfig } from './hud'
import { syncPositionsToB } from './compare-overlay-b'
import { DEFAULT_LAYOUT, getTrackMapConfig, setTrackMapConfig } from './defaults'
import type { TrackMapColorMode, TrackMapBgMode } from './defaults'
import { STORAGE_KEYS } from './storage-keys'

const LAYOUT_STORAGE_KEY = STORAGE_KEYS.overlayLayout
const OVERLAY_STORAGE_KEY = STORAGE_KEYS.overlayConfig

const OVERLAY_LABELS: Record<OverlayKey, string> = {
  speed: 'Speed',
  rpmGauge: 'RPM Gauge',
  rpmBar: 'RPM Bar',
  gear: 'Gear',
  gforce: 'G-Force',
  pedals: 'Pedals',
  steering: 'Steering',
  gps: 'GPS',
  trackMap: 'Track Map',
  session: 'Session',
}

let layout: OverlayLayout
const container = document.getElementById('video-overlay-anchor') as HTMLDivElement
const videoContainer = document.getElementById('video-container') as HTMLDivElement
const hudElements = new Map<OverlayKey, HTMLElement>()

// ── Layout persistence ──

function loadLayout(): OverlayLayout {
  const saved = localStorage.getItem(LAYOUT_STORAGE_KEY)
  if (saved) {
    try {
      return { ...DEFAULT_LAYOUT, ...JSON.parse(saved) }
    } catch {
      return { ...DEFAULT_LAYOUT }
    }
  }
  return { ...DEFAULT_LAYOUT }
}

function saveLayout(): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
}

// ── Apply positions to DOM ──

function applyPosition(key: OverlayKey): void {
  const el = hudElements.get(key)
  if (!el) return
  const pos = layout[key]
  // Clear any CSS default positioning — we use left/top % exclusively
  el.style.right = ''
  el.style.bottom = ''
  el.style.left = `${pos.left}%`
  el.style.top = `${pos.top}%`
  el.style.transform = pos.scale !== 1 ? `scale(${pos.scale})` : ''
}

export function applyAllPositions(): void {
  for (const key of Object.keys(layout) as OverlayKey[]) {
    applyPosition(key)
  }
  syncPositionsToB(container)
}

/**
 * Clamp every overlay so it sits fully inside the visible container.
 * Call after applying positions to guarantee nothing is off-screen.
 */
export function clampAllToViewport(): void {
  const cRect = container.getBoundingClientRect()
  if (cRect.width === 0 || cRect.height === 0) return

  for (const [key, el] of hudElements) {
    // Skip hidden elements — getBoundingClientRect returns zeros for display:none
    if (!el.classList.contains('active')) continue
    const elRect = el.getBoundingClientRect()
    // Compute percentage position that keeps the element fully inside
    let leftPct = layout[key].left
    let topPct = layout[key].top

    // Right edge overflow
    const rightOverflow = (elRect.right - cRect.right)
    if (rightOverflow > 0) {
      leftPct -= (rightOverflow / cRect.width) * 100
    }
    // Bottom edge overflow
    const bottomOverflow = (elRect.bottom - cRect.bottom)
    if (bottomOverflow > 0) {
      topPct -= (bottomOverflow / cRect.height) * 100
    }
    // Left edge overflow
    const leftOverflow = (cRect.left - elRect.left)
    if (leftOverflow > 0) {
      leftPct += (leftOverflow / cRect.width) * 100
    }
    // Top edge overflow
    const topOverflow = (cRect.top - elRect.top)
    if (topOverflow > 0) {
      topPct += (topOverflow / cRect.height) * 100
    }

    leftPct = Math.max(0, leftPct)
    topPct = Math.max(0, topPct)

    if (leftPct !== layout[key].left || topPct !== layout[key].top) {
      layout[key] = { ...layout[key], left: leftPct, top: topPct }
      applyPosition(key)
    }
  }
}

// ── Drag logic ──

let dragTarget: OverlayKey | null = null
let dragOffsetX = 0
let dragOffsetY = 0

function onPointerDown(key: OverlayKey, el: HTMLElement, e: PointerEvent): void {
  // Ignore if clicking on the resize handle
  if ((e.target as HTMLElement).classList.contains('resize-handle')) return

  e.preventDefault()
  e.stopPropagation()
  dragTarget = key
  el.classList.add('dragging')
  el.setPointerCapture(e.pointerId)

  const rect = el.getBoundingClientRect()
  dragOffsetX = e.clientX - rect.left
  dragOffsetY = e.clientY - rect.top
}

function onPointerMove(e: PointerEvent): void {
  if (!dragTarget) return
  const el = hudElements.get(dragTarget)
  if (!el) return

  const cRect = container.getBoundingClientRect()
  const newLeft = ((e.clientX - dragOffsetX - cRect.left) / cRect.width) * 100
  const newTop = ((e.clientY - dragOffsetY - cRect.top) / cRect.height) * 100

  layout[dragTarget] = {
    ...layout[dragTarget],
    left: Math.max(0, Math.min(95, newLeft)),
    top: Math.max(0, Math.min(95, newTop)),
  }
  applyPosition(dragTarget)
  syncPositionsToB(container)
}

function onPointerUp(): void {
  if (!dragTarget) return
  const el = hudElements.get(dragTarget)
  if (el) el.classList.remove('dragging')
  dragTarget = null
  saveLayout()
}

// ── Resize logic ──

let resizeTarget: OverlayKey | null = null
let resizeStartX = 0
let resizeStartScale = 1

function onResizePointerDown(key: OverlayKey, e: PointerEvent): void {
  e.preventDefault()
  e.stopPropagation()
  resizeTarget = key
  resizeStartX = e.clientX
  resizeStartScale = layout[key].scale
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onResizePointerMove(e: PointerEvent): void {
  if (!resizeTarget) return
  const delta = (e.clientX - resizeStartX) / 100
  const newScale = Math.max(0.4, Math.min(2.5, resizeStartScale + delta))
  layout[resizeTarget] = { ...layout[resizeTarget], scale: newScale }
  applyPosition(resizeTarget)
  syncPositionsToB(container)
}

function onResizePointerUp(): void {
  if (!resizeTarget) return
  resizeTarget = null
  saveLayout()
}

// ── Edit mode enter/exit ──

function enterEditMode(): void {
  for (const [, el] of hudElements) {
    el.classList.add('edit-mode')

    // Add resize handle if not already present
    if (!el.querySelector('.resize-handle')) {
      const handle = document.createElement('div')
      handle.className = 'resize-handle'
      el.appendChild(handle)
    }
  }

  // Show centre guide lines
  container.classList.add('edit-guides')

  // Attach global move/up listeners
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointermove', onResizePointerMove)
  document.addEventListener('pointerup', onResizePointerUp)
}

function exitEditMode(): void {
  for (const [, el] of hudElements) {
    el.classList.remove('edit-mode')
    el.classList.remove('dragging')
  }

  container.classList.remove('edit-guides')

  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.removeEventListener('pointermove', onResizePointerMove)
  document.removeEventListener('pointerup', onResizePointerUp)

  saveLayout()
}

// ── Build panel UI (called by gear-menu) ──

export function buildEditPanel(panel: HTMLDivElement): void {
  const config = getOverlayConfig()

  // Checkboxes for each overlay
  for (const [key, label] of Object.entries(OVERLAY_LABELS)) {
    const row = document.createElement('div')
    row.className = 'edit-row'

    const lbl = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = config[key as OverlayKey]
    cb.setAttribute('data-edit-overlay-key', key)
    cb.addEventListener('change', () => {
      const c = getOverlayConfig()
      c[key as OverlayKey] = cb.checked
      setOverlayConfig(c)
      applyOverlayConfig(c)
      localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(c))
    })

    lbl.appendChild(cb)
    lbl.appendChild(document.createTextNode(label))
    row.appendChild(lbl)
    panel.appendChild(row)

    // Track Map sub-settings: dot color + track color dropdowns
    if (key === 'trackMap') {
      panel.appendChild(buildTrackMapSubSettings())
    }
  }

  // Reset layout button
  const actions = document.createElement('div')
  actions.className = 'edit-actions'
  const resetBtn = document.createElement('button')
  resetBtn.textContent = 'Reset Layout'
  resetBtn.addEventListener('click', () => {
    // Reset positions + scale
    layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT))
    applyAllPositions()

    // Re-enable all overlays
    const allOn: OverlayConfig = {
      speed: true, rpmGauge: true, rpmBar: true, gear: true, gforce: true,
      pedals: true, steering: true, gps: true, trackMap: true, session: true,
    }
    setOverlayConfig(allOn)
    applyOverlayConfig(allOn)
    localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(allOn))

    // Sync checkboxes in the panel
    for (const cb of panel.querySelectorAll<HTMLInputElement>('input[data-edit-overlay-key]')) {
      cb.checked = true
    }

    // Clamp any overlays that ended up outside the visible area
    clampAllToViewport()
    saveLayout()
  })
  actions.appendChild(resetBtn)
  panel.appendChild(actions)
}

// ── Track Map sub-settings ──

function buildTrackMapSubSettings(): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'trackmap-sub-settings'

  const options: { value: TrackMapColorMode; label: string }[] = [
    { value: 'solid', label: 'Solid' },
    { value: 'speed', label: 'Speed' },
    { value: 'throttle', label: 'Throttle' },
    { value: 'brake', label: 'Brake' },
  ]

  const config = getTrackMapConfig()

  // Vehicle Dot Color
  const dotRow = document.createElement('div')
  dotRow.className = 'settings-row'
  const dotLabel = document.createElement('label')
  dotLabel.textContent = 'Dot Color'
  const dotSelect = document.createElement('select')
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    dotSelect.appendChild(el)
  }
  dotSelect.value = config.dotColor
  dotSelect.addEventListener('change', () => {
    const c = getTrackMapConfig()
    setTrackMapConfig({ ...c, dotColor: dotSelect.value as TrackMapColorMode })
  })
  dotRow.appendChild(dotLabel)
  dotRow.appendChild(dotSelect)
  wrapper.appendChild(dotRow)

  // Track Color
  const trackRow = document.createElement('div')
  trackRow.className = 'settings-row'
  const trackLabel = document.createElement('label')
  trackLabel.textContent = 'Track Color'
  const trackSelect = document.createElement('select')
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    trackSelect.appendChild(el)
  }
  trackSelect.value = config.trackColor
  trackSelect.addEventListener('change', () => {
    const c = getTrackMapConfig()
    setTrackMapConfig({ ...c, trackColor: trackSelect.value as TrackMapColorMode })
  })
  trackRow.appendChild(trackLabel)
  trackRow.appendChild(trackSelect)
  wrapper.appendChild(trackRow)

  // Map Background
  const bgOptions: { value: TrackMapBgMode; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'satellite', label: 'Satellite' },
    { value: 'solid', label: 'Solid' },
  ]
  const bgRow = document.createElement('div')
  bgRow.className = 'settings-row'
  const bgLabel = document.createElement('label')
  bgLabel.textContent = 'Map'
  const bgSelect = document.createElement('select')
  for (const opt of bgOptions) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    bgSelect.appendChild(el)
  }
  bgSelect.value = config.mapBackground
  bgSelect.addEventListener('change', () => {
    const c = getTrackMapConfig()
    setTrackMapConfig({ ...c, mapBackground: bgSelect.value as TrackMapBgMode })
  })
  bgRow.appendChild(bgLabel)
  bgRow.appendChild(bgSelect)
  wrapper.appendChild(bgRow)

  return wrapper
}

// ── Initialize ──

export function initEditMode(): void {
  // Gather all HUD elements
  for (const el of container.querySelectorAll<HTMLElement>('.hud-element')) {
    const key = el.dataset.overlay as OverlayKey
    if (key) {
      hudElements.set(key, el)

      // Attach per-element drag listeners (active only in edit mode)
      el.addEventListener('pointerdown', (e) => {
        if (!getEditMode()) return
        onPointerDown(key, el, e)
      })
    }
  }

  // Load and apply saved layout
  layout = loadLayout()
  applyAllPositions()

  // Attach resize handle listeners via event delegation
  container.addEventListener('pointerdown', (e) => {
    if (!getEditMode()) return
    const target = e.target as HTMLElement
    if (!target.classList.contains('resize-handle')) return
    const overlayEl = target.closest('.hud-element') as HTMLElement | null
    if (!overlayEl) return
    const key = overlayEl.dataset.overlay as OverlayKey
    if (key) onResizePointerDown(key, e)
  })

  // Pencil button toggles edit mode
  const editBtn = document.getElementById('btn-edit') as HTMLButtonElement
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    setEditMode(!getEditMode())
  })

  // React to edit mode state changes
  onEditModeChange(() => {
    const active = getEditMode()
    editBtn.classList.toggle('active', active)
    if (active) {
      enterEditMode()
    } else {
      exitEditMode()
    }
  })

  // Keyboard shortcut: E to toggle edit mode
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'SELECT') return

    if (e.code === 'KeyE') {
      setEditMode(!getEditMode())
    }
  })
}
