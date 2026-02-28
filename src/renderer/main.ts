/**
 * OpenPDR Viewer — Phase 2: Core Overlays
 *
 * Entry point / orchestrator. Imports all modules, wires them together,
 * and runs the main animation loop.
 */

import './types' // side-effect: augments Window with pdr
import { video, findRowAtTime, setCurrentRow, updateInterpolation, avSyncOffset, fireFrameTick, isDebugVisible, dbg } from './state'
import { initHud } from './hud'
import { initControls, getIsScrubbing } from './controls'
import { initFileOpen } from './file-open'
import { initResizer } from './resizer'
import { initOverlaySettings } from './overlay-settings'
import { initEditMode } from './edit-mode'
import { initChartPanel, getIsChartScrubbing } from './strip-chart'
import { initTrackMap } from './track-map'
import { initLapTable } from './lap-table'
import { initExportMenu } from './export-menu'
import { initOverlayRenderer } from './overlay-renderer'

const BUILD_ID = 'phase4-v1'
dbg(`Renderer loaded [${BUILD_ID}], pdr API: ${window.pdr ? 'OK' : 'MISSING'}`)

// ── Initialize modules ──
initHud()
const controls = initControls()
initFileOpen()
initResizer()
initOverlaySettings()
initEditMode()
initChartPanel()
initTrackMap(document.getElementById('track-canvas') as HTMLCanvasElement)
initLapTable(document.getElementById('lap-table-container') as HTMLDivElement)
initExportMenu()
initOverlayRenderer()

// ── Video overlay anchor sizing ──
// The anchor div matches the video's rendered bounds inside the container,
// so overlay % positions map 1:1 between preview and export.
const videoContainer = document.getElementById('video-container') as HTMLDivElement
const overlayAnchor = document.getElementById('video-overlay-anchor') as HTMLDivElement

function updateAnchorBounds(): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const cw = videoContainer.clientWidth
  const ch = videoContainer.clientHeight
  if (!cw || !ch) return

  if (!vw || !vh) {
    // No video loaded — anchor fills container at natural size
    overlayAnchor.style.left = '0px'
    overlayAnchor.style.top = '0px'
    overlayAnchor.style.width = `${cw}px`
    overlayAnchor.style.height = `${ch}px`
    overlayAnchor.style.transform = ''
    return
  }

  // Compute rendered video rectangle (object-fit: contain)
  const videoAR = vw / vh
  const containerAR = cw / ch
  let rw: number, rh: number
  if (videoAR > containerAR) {
    rw = cw
    rh = cw / videoAR
  } else {
    rw = ch * videoAR
    rh = ch
  }

  // Set anchor to video's native resolution and scale to fit.
  // This makes overlay pixel sizes (fonts, canvases) scale proportionally
  // with the video — matching what the export renderer produces.
  const scaleFactor = rw / vw
  overlayAnchor.style.left = `${(cw - rw) / 2}px`
  overlayAnchor.style.top = `${(ch - rh) / 2}px`
  overlayAnchor.style.width = `${vw}px`
  overlayAnchor.style.height = `${vh}px`
  overlayAnchor.style.transform = `scale(${scaleFactor})`
}

new ResizeObserver(() => {
  updateAnchorBounds()
  updateChartPanelCollapse()
}).observe(videoContainer)

video.addEventListener('loadedmetadata', () => {
  updateAnchorBounds()
})

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

/** Collapse chart panel content+handle when no sub-panels are active */
function updateChartPanelCollapse(): void {
  const chartPanel = document.getElementById('chart-panel')!
  if (!chartPanel.classList.contains('active')) return

  const anyActive = Object.values(panelState).some(v => v)
  const resizeHandle = document.getElementById('resize-handle')!
  const contentRow = document.getElementById('chart-content-row')!

  resizeHandle.classList.toggle('active', anyActive)
  contentRow.style.display = anyActive ? '' : 'none'
  if (!anyActive) {
    chartPanel.style.height = 'auto'
    chartPanel.style.minHeight = '0'
  } else if (chartPanel.style.height === 'auto') {
    const saved = localStorage.getItem('pdr-chart-height')
    chartPanel.style.height = saved || '200px'
    chartPanel.style.minHeight = ''
  }
}

document.querySelectorAll<HTMLButtonElement>('.panel-toggle').forEach((btn) => {
  const panelKey = btn.dataset.panel!
  // Restore saved state; default charts to on if no saved state
  const defaultOn = panelKey === 'charts'
  const isOn = panelKey in panelState ? panelState[panelKey] : defaultOn
  panelState[panelKey] = isOn
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
    updateChartPanelCollapse()
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
  // Apply A/V sync offset: telemetry lookup leads the video frame to match audio timing
  const tSync = t + avSyncOffset
  setCurrentRow(findRowAtTime(tSync))  // Only fires listeners if row changed
  updateInterpolation(tSync)           // Compute bracketing rows + alpha for smooth lerp
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
