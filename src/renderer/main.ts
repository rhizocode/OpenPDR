/**
 * OpenPDR Viewer — Phase 2: Core Overlays
 *
 * Entry point / orchestrator. Imports all modules, wires them together,
 * and runs the main animation loop.
 */

import './types' // side-effect: augments Window with pdr
import { video, findRowAtTime, setCurrentRow, fireFrameTick, isDebugVisible, dbg } from './state'
import { initHud } from './hud'
import { initControls, controls, getIsScrubbing } from './controls'
import { initFileOpen } from './file-open'
import { initResizer } from './resizer'
import { initOverlaySettings } from './overlay-settings'
import { initEditMode } from './edit-mode'
import { initChartPanel, getIsChartScrubbing } from './strip-chart'
import { initTrackMap } from './track-map'
import { initLapTable } from './lap-table'

const BUILD_ID = 'phase3-v1'
dbg(`Renderer loaded [${BUILD_ID}], pdr API: ${window.pdr ? 'OK' : 'MISSING'}`)

// ── Initialize modules ──
initHud()
initControls()
initFileOpen()
initResizer()
initOverlaySettings()
initEditMode()
initChartPanel()
initTrackMap(document.getElementById('track-canvas') as HTMLCanvasElement)
initLapTable(document.getElementById('lap-table-container') as HTMLDivElement)

// ── Panel toggles ──
const PANEL_STORAGE_KEY = 'pdr-panel-state'
const chartsPanel = document.getElementById('charts-panel') as HTMLElement
const chartToolbar = document.getElementById('chart-toolbar') as HTMLElement
const lapsPanel = document.getElementById('laps-panel') as HTMLElement
const lapsResizeHandle = document.getElementById('laps-resize-handle') as HTMLElement

function loadPanelState(): Record<string, boolean> {
  const saved = localStorage.getItem(PANEL_STORAGE_KEY)
  if (saved) { try { return JSON.parse(saved) } catch { /* ignore */ } }
  return {}
}

function savePanelState(state: Record<string, boolean>): void {
  localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(state))
}

const panelState = loadPanelState()

function activatePanel(key: string, show: boolean): void {
  if (key === 'charts') {
    chartsPanel.classList.toggle('active', show)
    chartToolbar.style.display = show ? '' : 'none'
  } else if (key === 'laps') {
    lapsPanel.classList.toggle('active', show)
    lapsResizeHandle.classList.toggle('active', show)
  }
}

document.querySelectorAll<HTMLButtonElement>('.panel-toggle').forEach((btn) => {
  const panelKey = btn.dataset.panel!
  // Restore saved state; default charts to on if no saved state
  const defaultOn = panelKey === 'charts'
  const isOn = panelKey in panelState ? panelState[panelKey] : defaultOn
  if (isOn) {
    btn.classList.add('active')
    activatePanel(panelKey, true)
  } else {
    btn.classList.remove('active')
    activatePanel(panelKey, false)
  }
  btn.addEventListener('click', () => {
    const isActive = btn.classList.toggle('active')
    activatePanel(panelKey, isActive)
    panelState[panelKey] = isActive
    savePanelState(panelState)
  })
})

// ── Laps panel horizontal resize ──
{
  let dragging = false
  let startX = 0
  let startWidth = 0

  lapsResizeHandle.addEventListener('pointerdown', (e) => {
    dragging = true
    startX = e.clientX
    startWidth = lapsPanel.offsetWidth
    lapsResizeHandle.setPointerCapture(e.pointerId)
    lapsResizeHandle.classList.add('dragging')
    e.preventDefault()
  })

  lapsResizeHandle.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const delta = startX - e.clientX
    const newW = Math.max(150, Math.min(window.innerWidth * 0.5, startWidth + delta))
    lapsPanel.style.width = `${newW}px`
  })

  lapsResizeHandle.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false
      lapsResizeHandle.classList.remove('dragging')
      localStorage.setItem('pdr-laps-panel-width', lapsPanel.style.width)
    }
  })

  const savedWidth = localStorage.getItem('pdr-laps-panel-width')
  if (savedWidth) lapsPanel.style.width = savedWidth
}

// ── FPS counter (only active when debug panel is visible via F2) ──
const fpsEl = document.getElementById('fps-counter') as HTMLSpanElement
let fpsFrameCount = 0
let fpsLastTime = performance.now()

function updateFpsCounter(): void {
  if (!isDebugVisible()) {
    // Reset so the first reading after F2 toggle is fresh
    fpsFrameCount = 0
    fpsLastTime = performance.now()
    return
  }
  fpsFrameCount++
  const now = performance.now()
  const elapsed = now - fpsLastTime
  if (elapsed >= 1000) {
    const fps = Math.round((fpsFrameCount * 1000) / elapsed)
    fpsEl.textContent = `${fps} fps`
    fpsFrameCount = 0
    fpsLastTime = now
  }
}

// ── Animation loop (demand-driven) ──
// Only schedules frames when the video is playing, scrubbing, or a seek occurred.
let lastVideoTime = -1
let animationRunning = false

function onAnimationFrame(): void {
  const t = video.currentTime
  lastVideoTime = t
  setCurrentRow(findRowAtTime(t))  // Only fires listeners if row changed
  controls.updateScrubBar(t)
  controls.updateTimeDisplay(t)
  fireFrameTick()
  updateFpsCounter()

  // Keep looping while playing or scrubbing; stop when idle
  if (!video.paused || getIsScrubbing() || getIsChartScrubbing()) {
    requestAnimationFrame(onAnimationFrame)
  } else {
    animationRunning = false
  }
}

/** Ensure the animation loop is running. Safe to call multiple times. */
function startAnimationLoop(): void {
  if (animationRunning) return
  animationRunning = true
  requestAnimationFrame(onAnimationFrame)
}

// Start loop on play
video.addEventListener('play', startAnimationLoop)

// Restart loop on any seek (scrub bar, chart click, keyboard seek, etc.)
video.addEventListener('seeked', startAnimationLoop)

// Also restart on timeupdate as a safety net
video.addEventListener('timeupdate', startAnimationLoop)

// Initial kick — render the first frame if anything is loaded
startAnimationLoop()
