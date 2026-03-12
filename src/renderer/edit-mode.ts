/**
 * OpenPDR Viewer — Edit mode for overlay layout
 *
 * Allows repositioning and resizing HUD overlay elements via drag & drop.
 * Builds the edit panel UI with show/hide toggles and a reset-layout button.
 * Persists layout to localStorage.
 */

import type { OverlayConfig, OverlayKey, OverlayPosition, OverlayLayout, OverlayOrigin } from './types'
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

// ── Origin helpers ──

const ORIGIN_CSS: Record<OverlayOrigin, string> = {
  tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right',
}

const OPPOSITE_CORNER: Record<string, OverlayOrigin> = {
  tl: 'br', tr: 'bl', bl: 'tr', br: 'tl',
}

const HYSTERESIS = 2 // % deadzone around 50% to prevent origin flicker

/**
 * Compute the origin quadrant from the overlay's visual center.
 * Uses hysteresis: only flips when center moves decisively past 50%.
 */
function computeOrigin(key: OverlayKey): OverlayOrigin {
  const el = hudElements.get(key)
  if (!el) return layout[key].origin ?? 'tl'
  const cRect = container.getBoundingClientRect()
  if (cRect.width === 0 || cRect.height === 0) return layout[key].origin ?? 'tl'
  const eRect = el.getBoundingClientRect()

  const centerXPct = ((eRect.left + eRect.width / 2 - cRect.left) / cRect.width) * 100
  const centerYPct = ((eRect.top + eRect.height / 2 - cRect.top) / cRect.height) * 100

  const prev = layout[key].origin ?? 'tl'
  const wasRight = prev.includes('r')
  const wasBottom = prev.includes('b')

  // Apply hysteresis: only flip when crossing 50 ± HYSTERESIS
  const isRight = wasRight
    ? centerXPct >= 50 - HYSTERESIS
    : centerXPct >= 50 + HYSTERESIS
  const isBottom = wasBottom
    ? centerYPct >= 50 - HYSTERESIS
    : centerYPct >= 50 + HYSTERESIS

  if (isBottom) return isRight ? 'br' : 'bl'
  return isRight ? 'tr' : 'tl'
}

/**
 * Convert layout position from the current origin to a new origin
 * without visually moving the overlay. Reads the element's bounding rect
 * to find the new origin corner's position in container %.
 */
function convertOrigin(key: OverlayKey, newOrigin: OverlayOrigin): void {
  const el = hudElements.get(key)
  if (!el) return
  const cRect = container.getBoundingClientRect()
  if (cRect.width === 0 || cRect.height === 0) return
  const eRect = el.getBoundingClientRect()

  const newLeft = newOrigin.includes('l')
    ? ((eRect.left - cRect.left) / cRect.width) * 100
    : ((eRect.right - cRect.left) / cRect.width) * 100
  const newTop = newOrigin.includes('t')
    ? ((eRect.top - cRect.top) / cRect.height) * 100
    : ((eRect.bottom - cRect.top) / cRect.height) * 100

  layout[key] = { ...layout[key], left: newLeft, top: newTop, origin: newOrigin }
}

// ── Apply positions to DOM ──

function applyPosition(key: OverlayKey): void {
  const el = hudElements.get(key)
  if (!el) return
  const pos = layout[key]
  const origin = pos.origin ?? 'tl'

  // Clear all directional properties
  el.style.left = ''
  el.style.right = ''
  el.style.top = ''
  el.style.bottom = ''

  // Position from the origin corner
  if (origin.includes('l')) {
    el.style.left = `${pos.left}%`
  } else {
    el.style.right = `${100 - pos.left}%`
  }
  if (origin.includes('t')) {
    el.style.top = `${pos.top}%`
  } else {
    el.style.bottom = `${100 - pos.top}%`
  }

  el.style.transformOrigin = ORIGIN_CSS[origin]
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
 * Origin-aware: adjusts the stored origin-corner position.
 */
export function clampAllToViewport(): void {
  const cRect = container.getBoundingClientRect()
  if (cRect.width === 0 || cRect.height === 0) return

  for (const [key, el] of hudElements) {
    if (!el.classList.contains('active')) continue
    const eRect = el.getBoundingClientRect()
    const origin = layout[key].origin ?? 'tl'
    let leftPct = layout[key].left
    let topPct = layout[key].top

    // Compute overflow on each edge
    const rOver = eRect.right - cRect.right
    const bOver = eRect.bottom - cRect.bottom
    const lOver = cRect.left - eRect.left
    const tOver = cRect.top - eRect.top

    // For left-anchored origins, shift left to fix right overflow, shift right to fix left overflow
    // For right-anchored origins, the directions are reversed
    const xSign = origin.includes('l') ? 1 : -1
    if (rOver > 0) leftPct -= xSign * (rOver / cRect.width) * 100
    if (lOver > 0) leftPct += xSign * (lOver / cRect.width) * 100

    const ySign = origin.includes('t') ? 1 : -1
    if (bOver > 0) topPct -= ySign * (bOver / cRect.height) * 100
    if (tOver > 0) topPct += ySign * (tOver / cRect.height) * 100

    leftPct = Math.max(0, Math.min(100, leftPct))
    topPct = Math.max(0, Math.min(100, topPct))

    if (leftPct !== layout[key].left || topPct !== layout[key].top) {
      layout[key] = { ...layout[key], left: leftPct, top: topPct }
      applyPosition(key)
    }
  }
}

// ── Drag logic ──

let dragTarget: OverlayKey | null = null
let dragPointerId = -1
let dragOffsetX = 0
let dragOffsetY = 0

/** Get the screen-space position of an element's origin corner. */
function originCornerPx(el: HTMLElement, origin: OverlayOrigin): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return {
    x: origin.includes('l') ? r.left : r.right,
    y: origin.includes('t') ? r.top : r.bottom,
  }
}

function onPointerDown(key: OverlayKey, el: HTMLElement, e: PointerEvent): void {
  if ((e.target as HTMLElement).classList.contains('resize-handle')) return

  e.preventDefault()
  e.stopPropagation()
  dragTarget = key
  dragPointerId = e.pointerId
  el.classList.add('dragging')
  el.setPointerCapture(e.pointerId)

  const origin = layout[key].origin ?? 'tl'
  const corner = originCornerPx(el, origin)
  dragOffsetX = e.clientX - corner.x
  dragOffsetY = e.clientY - corner.y
}

function onPointerMove(e: PointerEvent): void {
  if (!dragTarget || e.pointerId !== dragPointerId) return
  const el = hudElements.get(dragTarget)
  if (!el) return

  const cRect = container.getBoundingClientRect()
  const newCornerX = e.clientX - dragOffsetX
  const newCornerY = e.clientY - dragOffsetY
  const newLeft = ((newCornerX - cRect.left) / cRect.width) * 100
  const newTop = ((newCornerY - cRect.top) / cRect.height) * 100

  layout[dragTarget] = {
    ...layout[dragTarget],
    left: Math.max(0, Math.min(100, newLeft)),
    top: Math.max(0, Math.min(100, newTop)),
  }
  applyPosition(dragTarget)

  // Recompute origin based on new center position
  const newOrigin = computeOrigin(dragTarget)
  const curOrigin = layout[dragTarget].origin ?? 'tl'
  if (newOrigin !== curOrigin) {
    convertOrigin(dragTarget, newOrigin)
    applyPosition(dragTarget)
    // Update drag offset for the new origin corner
    const corner = originCornerPx(el, newOrigin)
    dragOffsetX = e.clientX - corner.x
    dragOffsetY = e.clientY - corner.y
  }

  syncPositionsToB(container)
}

function onPointerUp(e: PointerEvent): void {
  if (!dragTarget || e.pointerId !== dragPointerId) return
  const el = hudElements.get(dragTarget)
  if (el) el.classList.remove('dragging')
  dragTarget = null
  dragPointerId = -1
  saveLayout()
}

// ── Resize logic ──

let resizeTarget: OverlayKey | null = null
let resizePointerId = -1
let resizeCorner: OverlayOrigin = 'br'
let resizeFixedPx = { x: 0, y: 0 }
let resizeStartDiag = 0
let resizeStartScale = 1
let resizeOrigOrigin: OverlayOrigin = 'tl'

function onResizePointerDown(key: OverlayKey, corner: OverlayOrigin, e: PointerEvent): void {
  e.preventDefault()
  e.stopPropagation()
  resizeTarget = key
  resizePointerId = e.pointerId
  resizeCorner = corner
  resizeStartScale = layout[key].scale
  resizeOrigOrigin = layout[key].origin ?? 'tl'

  const el = hudElements.get(key)!
  const r = el.getBoundingClientRect()

  // The fixed corner is diagonally opposite the dragged corner
  const fixed = OPPOSITE_CORNER[corner]
  resizeFixedPx = {
    x: fixed.includes('l') ? r.left : r.right,
    y: fixed.includes('t') ? r.top : r.bottom,
  }

  resizeStartDiag = Math.hypot(e.clientX - resizeFixedPx.x, e.clientY - resizeFixedPx.y)

  // Temporarily set origin to the fixed corner so CSS keeps it pinned
  if (fixed !== resizeOrigOrigin) {
    convertOrigin(key, fixed)
    applyPosition(key)
  }

  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onResizePointerMove(e: PointerEvent): void {
  if (!resizeTarget || e.pointerId !== resizePointerId) return
  if (resizeStartDiag === 0) return

  const currentDiag = Math.hypot(e.clientX - resizeFixedPx.x, e.clientY - resizeFixedPx.y)
  const ratio = currentDiag / resizeStartDiag
  const newScale = Math.max(0.2, Math.min(6.0, resizeStartScale * ratio))

  layout[resizeTarget] = { ...layout[resizeTarget], scale: newScale }
  applyPosition(resizeTarget)
  syncPositionsToB(container)
}

function onResizePointerUp(e: PointerEvent): void {
  if (!resizeTarget || e.pointerId !== resizePointerId) return

  // Recompute the natural origin from center position
  const newOrigin = computeOrigin(resizeTarget)
  const curOrigin = layout[resizeTarget].origin ?? 'tl'
  if (newOrigin !== curOrigin) {
    convertOrigin(resizeTarget, newOrigin)
    applyPosition(resizeTarget)
  }

  resizeTarget = null
  resizePointerId = -1
  saveLayout()
}

/** Clean up drag/resize state when the pointer is cancelled (e.g. browser gesture). */
function onPointerCancel(e: PointerEvent): void {
  if (dragTarget && e.pointerId === dragPointerId) {
    const el = hudElements.get(dragTarget)
    if (el) el.classList.remove('dragging')
    dragTarget = null
    dragPointerId = -1
    saveLayout()
  }
  if (resizeTarget && e.pointerId === resizePointerId) {
    resizeTarget = null
    resizePointerId = -1
    saveLayout()
  }
}

// ── Edit mode enter/exit ──

const CORNERS: OverlayOrigin[] = ['tl', 'tr', 'bl', 'br']

function enterEditMode(): void {
  for (const [, el] of hudElements) {
    el.classList.add('edit-mode')

    // Add 4 corner resize handles if not already present
    for (const corner of CORNERS) {
      if (!el.querySelector(`.resize-handle[data-corner="${corner}"]`)) {
        const handle = document.createElement('div')
        handle.className = 'resize-handle'
        handle.dataset.corner = corner
        el.appendChild(handle)
      }
    }
  }

  // Show centre guide lines
  container.classList.add('edit-guides')

  // Attach global move/up/cancel listeners
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointercancel', onPointerCancel)
  document.addEventListener('pointermove', onResizePointerMove)
  document.addEventListener('pointerup', onResizePointerUp)
}

function exitEditMode(): void {
  // Clear any in-progress drag/resize
  dragTarget = null
  dragPointerId = -1
  resizeTarget = null
  resizePointerId = -1

  for (const [, el] of hudElements) {
    el.classList.remove('edit-mode')
    el.classList.remove('dragging')
  }

  container.classList.remove('edit-guides')

  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.removeEventListener('pointercancel', onPointerCancel)
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
  { const el = document.createElement('option'); el.value = 'none'; el.textContent = 'None'; trackSelect.appendChild(el) }
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
    const corner = (target.dataset.corner ?? 'br') as OverlayOrigin
    if (key) onResizePointerDown(key, corner, e)
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
