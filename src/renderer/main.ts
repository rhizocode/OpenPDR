/**
 * OpenPDR Viewer — Phase 2: Core Overlays
 *
 * Entry point / orchestrator. Imports all modules, wires them together,
 * and runs the main animation loop.
 */

import './types' // side-effect: augments Window with pdr
import { video, findRowAtTime, setCurrentRow, updateInterpolation, fireFrameTick, isDebugVisible, dbg, lapData, duration, viewRange, setViewRange, selectedLapIdx, getSyncedTime, seekToTelemetryTime, onTelemetryLoad, onViewRangeChange, avSyncOffset, setInterpState } from './state'
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
import { initCompareUI } from './compare-ui'
import { initGearMenu } from './gear-menu'
import {
  isCompareMode,
  videoA as getVideoA,
  videoB as getVideoB,
  storeA, storeB,
  syncDataA, syncDataB,
  setTrackPosition,
  setCurrentRowA, setCurrentRowB,
  updateInterpolationA, updateInterpolationB,
  findRowInStore,
  onCompareEnter, onCompareExit,
  interpPrevA, interpNextA, interpAlphaA,
  interpPrevB, interpNextB, interpAlphaB,
  currentRowB,
} from './compare-state'
import { updateOverlayBRow, smoothAndDrawB, updateAnchorBBounds } from './compare-overlay-b'
import { timeToTrackPosition, trackPositionToTime } from './compare-sync'
import { createEmptyRow } from '../shared/telemetry-store'

const BUILD_ID = 'phase4-v1'
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
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
initCompareUI()
initGearMenu()
initLapSelector()

// ── Video overlay anchor sizing ──
// The anchor div matches the video's rendered bounds inside the container,
// so overlay % positions map 1:1 between preview and export.
const videoContainer = document.getElementById('video-container') as HTMLDivElement
const overlayAnchor = document.getElementById('video-overlay-anchor') as HTMLDivElement

function updateAnchorBounds(): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  // In compare mode #video is 50% wide; use its clientWidth/Height as the slot
  // so the anchor covers only video A's rendered area, not the full container.
  const cw = video.clientWidth || videoContainer.clientWidth
  const ch = video.clientHeight || videoContainer.clientHeight
  if (!cw || !ch) return

  if (!vw || !vh) {
    // No video loaded — anchor fills the video's slot
    overlayAnchor.style.left = '0px'
    overlayAnchor.style.top = '0px'
    overlayAnchor.style.width = `${cw}px`
    overlayAnchor.style.height = `${ch}px`
    overlayAnchor.style.transform = ''
    return
  }

  // Compute rendered video rectangle (object-fit: contain) within the slot
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
  if (isCompareMode()) {
    const vB = getVideoB
    if (vB) updateAnchorBBounds(vB)
  }
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

// ── Compare mode scratch rows (pre-allocated, reused every frame) ──
const _scratchRowA = createEmptyRow()
const _scratchRowB = createEmptyRow()

// ── Animation loop (demand-driven) ──
// Only schedules frames when the video is playing, scrubbing, or a seek occurred.
let lastVideoTime = -1
let animationRunning = false

function onCompareAnimationFrame(): void {
  const vA = getVideoA
  const vB = getVideoB
  if (!vA || !vB || !syncDataA || !syncDataB || !storeA || !storeB) return

  const tA = vA.currentTime
  const telTimeA = tA + avSyncOffset

  // Master track position from video A
  const pos = timeToTrackPosition(syncDataA, telTimeA)
  setTrackPosition(pos)

  // Sync video B to match track position
  const telTimeB = trackPositionToTime(syncDataB, pos)
  const videoTimeB = telTimeB - avSyncOffset
  const errorB = videoTimeB - vB.currentTime

  if (vA.paused) {
    // When paused, hard-seek for precise frame positioning
    if (Math.abs(errorB) > 0.02) {
      vB.currentTime = videoTimeB
    }
  } else {
    // While playing, use playbackRate adjustment for smooth sync.
    // Compute ideal rate: how fast should B advance per unit of A time
    // at this track position (local slope of B-time vs A-time).
    const dp = 0.005
    const posNext = Math.min(1, pos + dp)
    const dtA = trackPositionToTime(syncDataA, posNext) - trackPositionToTime(syncDataA, pos)
    const dtB = trackPositionToTime(syncDataB, posNext) - trackPositionToTime(syncDataB, pos)
    const idealRate = dtA > 0.0001 ? (dtB / dtA) : 1.0

    if (Math.abs(errorB) > 0.5) {
      // Large desync — hard-seek to recover
      vB.currentTime = videoTimeB
      vB.playbackRate = Math.max(0.1, Math.min(4.0, idealRate * vA.playbackRate))
    } else {
      // Proportional correction: nudge rate to close the gap
      const correctedRate = idealRate + errorB * 3.0
      vB.playbackRate = Math.max(0.1, Math.min(4.0, correctedRate * vA.playbackRate))
    }
  }

  // Update rows + interpolation for both sides
  setCurrentRowA(findRowInStore(storeA, telTimeA, _scratchRowA))
  setCurrentRowB(findRowInStore(storeB, telTimeB, _scratchRowB))
  updateInterpolationA(telTimeA)
  updateInterpolationB(telTimeB)

  // Feed side A into the single-video HUD path so overlays render side A telemetry.
  // hud.ts subscribes to onRowUpdate (state.ts) and reads state.interpPrev/Next/Alpha.
  setInterpState(interpPrevA, interpNextA, interpAlphaA)
  setCurrentRow(_scratchRowA)

  // Update side B overlay anchor
  updateOverlayBRow(currentRowB)
  smoothAndDrawB(interpPrevB, interpNextB, interpAlphaB)

  // Update controls
  controls.updateCompareScrubBar(pos)
  controls.updateCompareTimeDisplay(telTimeA, telTimeB)
  fireFrameTick()
  updateFpsCounter()

  // Clamp: pause when reaching end of lap A
  if (!vA.paused && pos >= 0.999) {
    vA.pause()
    vB.pause()
    btnPlay.innerHTML = '&#9654;'
  }

  // Keep looping while playing or scrubbing
  if (!vA.paused || getIsScrubbing() || getIsChartScrubbing()) {
    requestAnimationFrame(onAnimationFrame)
  } else {
    animationRunning = false
  }
}

function onAnimationFrame(): void {
  if (isCompareMode()) {
    onCompareAnimationFrame()
    return
  }

  const t = video.currentTime
  lastVideoTime = t
  setCurrentRow(findRowAtTime(t))    // A/V sync offset applied internally
  updateInterpolation(t)             // A/V sync offset applied internally
  controls.updateScrubBar(t)
  controls.updateTimeDisplay(t)
  fireFrameTick()
  updateFpsCounter()

  // Playback clamping: pause when reaching end of view range
  if (!video.paused && getSyncedTime() >= viewRange.endTime) {
    video.pause()
    btnPlay.innerHTML = '&#9654;'
    seekToTelemetryTime(viewRange.endTime - 0.001)
  }

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

// When entering compare mode, wire video A events to restart the animation loop
onCompareEnter(() => {
  const vA = getVideoA
  if (vA && vA !== video) {
    vA.addEventListener('play', startAnimationLoop)
    vA.addEventListener('seeked', startAnimationLoop)
  }
  // Re-measure anchor bounds: #video is now 50% wide; position B anchor too.
  // Use two rAF passes: first lets the flex layout settle, second measures.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    updateAnchorBounds()
    const vB = getVideoB
    if (vB) {
      updateAnchorBBounds(vB)
      // Also re-measure once video B has its native dimensions
      vB.addEventListener('loadedmetadata', () => updateAnchorBBounds(vB), { once: true })
    }
  }))
  startAnimationLoop()
})

onCompareExit(() => {
  // Stop video B and reset its playback rate
  const vB = getVideoB
  if (vB) {
    vB.pause()
    vB.playbackRate = 1.0
  }
  // Animation loop already falls through to normal mode when isCompareMode() is false
  // Re-measure anchor bounds: #video returns to full width
  requestAnimationFrame(updateAnchorBounds)
  startAnimationLoop()
})

// Initial kick — render the first frame if anything is loaded
startAnimationLoop()

// ── Lap selector dropdown ──
function initLapSelector(): void {
  const selector = document.getElementById('lap-selector') as HTMLSelectElement

  function formatLapTime(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = seconds - m * 60
    const sFmt = s < 10 ? '0' + s.toFixed(3) : s.toFixed(3)
    return `${m}:${sFmt}`
  }

  onTelemetryLoad(() => {
    selector.innerHTML = ''

    const fullOpt = document.createElement('option')
    fullOpt.value = 'full'
    fullOpt.textContent = 'Full Recording'
    selector.appendChild(fullOpt)

    const ld = lapData
    if (ld?.hasLapData && ld.laps.length > 0) {
      const bestTime = Math.min(...ld.laps.map(l => l.lapTime))

      for (const lap of ld.laps) {
        const opt = document.createElement('option')
        opt.value = String(lap.lapNumber - 1)
        let label = `Lap ${lap.lapNumber}  ${formatLapTime(lap.lapTime)}`
        if (lap.lapTime === bestTime) {
          label += '  best'
        } else {
          label += `  +${(lap.lapTime - bestTime).toFixed(3)}`
        }
        opt.textContent = label
        selector.appendChild(opt)
      }

      selector.style.display = ''
    } else {
      selector.style.display = 'none'
    }

    selector.value = 'full'
  })

  selector.addEventListener('change', () => {
    const val = selector.value
    if (val === 'full') {
      setViewRange({ startTime: 0, endTime: duration }, null)
    } else {
      const idx = parseInt(val, 10)
      const ld = lapData
      if (ld?.hasLapData && ld.laps[idx]) {
        const lap = ld.laps[idx]
        setViewRange({ startTime: lap.startTime, endTime: lap.endTime }, idx)
        seekToTelemetryTime(lap.startTime)
      }
    }
  })

  onViewRangeChange(() => {
    if (selectedLapIdx === null) {
      selector.value = 'full'
    } else {
      selector.value = String(selectedLapIdx)
    }
  })
}
