/**
 * OpenPDR Viewer — Phase 2: Core Overlays
 *
 * Entry point / orchestrator. Imports all modules, wires them together,
 * and runs the main animation loop.
 */

import './types' // side-effect: augments Window with pdr
import { formatLapTime } from './defaults'
import { STORAGE_KEYS } from './storage-keys'
import { video, findRowAtTime, setCurrentRow, updateInterpolation, fireFrameTick, isDebugVisible, dbg, lapData, duration, viewRange, setViewRange, selectedLapIdx, getSyncedTime, seekToTelemetryTime, onTelemetryLoad, onViewRangeChange, avSyncOffset, setInterpState, getEditMode, setEditMode, onEditModeChange } from './state'
import { initHud } from './hud'
import { initControls, getIsScrubbing } from './controls'
import { initFileOpen } from './file-open'
import { initResizer } from './resizer'
import { initOverlaySettings, initFontScale } from './overlay-settings'
import { initEditMode } from './edit-mode'
import { initChartPanel, getIsChartScrubbing } from './strip-chart'
import { initTrackMap } from './track-map'
import { initLapTable } from './lap-table'
import { initExportMenu } from './export-menu'
import { initOverlayRenderer } from './overlay-renderer'
import { initCompareUI } from './compare-ui'
import { initGearMenu } from './gear-menu'
import { initUpdateUI } from './update-ui'
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

const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
if (window.pdr?.getAppVersion) {
  window.pdr.getAppVersion().then(v => dbg(`Renderer loaded [v${v}], pdr API: OK`))
} else {
  dbg('Renderer loaded, pdr API: OK')
}

// ── Initialize modules ──
initHud()
const controls = initControls()
initFileOpen()
initResizer()
initOverlaySettings()
initFontScale()
initEditMode()
initChartPanel()
initTrackMap(document.getElementById('track-canvas') as HTMLCanvasElement)
initLapTable(document.getElementById('lap-table-container') as HTMLDivElement)
initExportMenu()
initOverlayRenderer()
initCompareUI()
initGearMenu()
initUpdateUI()
initLapSelector()

// ── Mobile hamburger menu ──
{
  const hbBtn = document.getElementById('btn-hamburger')
  const tb = document.getElementById('toolbar')
  const gearPanel = document.getElementById('gear-panel')
  const editMobileBtn = document.getElementById('btn-edit-mobile')
  if (hbBtn && tb && gearPanel && editMobileBtn) {
    const mobileQuery = window.matchMedia('(max-width: 900px)')

    function openMobileMenu(): void {
      tb!.classList.add('mobile-open')
      hbBtn!.classList.add('active')
      // Move gear panel inside toolbar so it scrolls with menu items
      tb!.appendChild(gearPanel!)
    }

    function closeMobileMenu(): void {
      tb!.classList.remove('mobile-open')
      hbBtn!.classList.remove('active')
      // Move gear panel back to original position (sibling after toolbar)
      tb!.parentElement!.insertBefore(gearPanel!, tb!.nextSibling)
      gearPanel!.classList.remove('visible')
    }

    hbBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (tb.classList.contains('mobile-open')) {
        closeMobileMenu()
      } else {
        openMobileMenu()
      }
    })

    // Close on outside click
    document.addEventListener('pointerdown', (e) => {
      if (tb.classList.contains('mobile-open')) {
        const target = e.target as Node
        if (!tb.contains(target)) {
          closeMobileMenu()
        }
      }
    })

    // Close menu after clicking a toolbar button (but NOT gear panel buttons)
    tb.addEventListener('click', (e) => {
      const el = e.target as HTMLElement
      if (el === hbBtn || hbBtn.contains(el)) return
      if (gearPanel.contains(el)) return
      if (el === editMobileBtn || editMobileBtn.contains(el)) return
      if (el.tagName === 'BUTTON' || el.closest('button')) {
        closeMobileMenu()
      }
    })

    // Close on select change (but NOT gear panel selects)
    tb.addEventListener('change', (e) => {
      if (gearPanel.contains(e.target as Node)) return
      closeMobileMenu()
    })

    // Mobile edit mode button
    editMobileBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      setEditMode(!getEditMode())
    })
    onEditModeChange(() => {
      editMobileBtn.classList.toggle('active', getEditMode())
    })

    // If window resizes above breakpoint while menu is open, close cleanly
    mobileQuery.addEventListener('change', () => {
      if (!mobileQuery.matches && tb.classList.contains('mobile-open')) {
        closeMobileMenu()
      }
    })
  }
}

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
const PANEL_STORAGE_KEY = STORAGE_KEYS.panelState
const chartsPanel = document.getElementById('charts-panel') as HTMLElement
const chartToolbar = document.getElementById('chart-toolbar') as HTMLElement
const lapsPanel = document.getElementById('laps-panel') as HTMLElement
const lapsResizeHandle = document.getElementById('laps-resize-handle') as HTMLElement
const chartPanel = document.getElementById('chart-panel') as HTMLElement
const resizeHandle = document.getElementById('resize-handle') as HTMLElement
const contentRow = document.getElementById('chart-content-row') as HTMLElement

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
  if (!chartPanel.classList.contains('active')) return

  const anyActive = Object.values(panelState).some(v => v)

  resizeHandle.classList.toggle('active', anyActive)
  contentRow.style.display = anyActive ? '' : 'none'
  if (!anyActive) {
    chartPanel.style.height = 'auto'
    chartPanel.style.minHeight = '0'
  } else if (chartPanel.style.height === 'auto') {
    const saved = localStorage.getItem(STORAGE_KEYS.chartHeight)
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
      localStorage.setItem(STORAGE_KEYS.lapsPanelWidth, lapsPanel.style.width)
    }
  })

  lapsResizeHandle.addEventListener('lostpointercapture', () => {
    if (dragging) {
      dragging = false
      lapsResizeHandle.classList.remove('dragging')
    }
  })

  const savedWidth = localStorage.getItem(STORAGE_KEYS.lapsPanelWidth)
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

// ── Mobile sleep/wake video recovery ──
// When a mobile device sleeps, the OS may release the hardware video decoder.
// On wake the UI is fine but video frames are frozen. We detect this and
// attempt recovery; if that fails we show a toast prompting the user to tap.
{
  const toast = document.getElementById('video-recovery-toast')!
  let wasPlaying = false

  document.addEventListener('visibilitychange', () => {
    if (!video.src) return

    if (document.hidden) {
      // Entering sleep — remember playback state
      wasPlaying = !video.paused
      return
    }

    // Waking up — attempt to nudge the decoder back to life
    const savedTime = video.currentTime
    dbg('Visibility restored — attempting video decoder recovery')

    // Nudge seek forces decoder re-init on most mobile browsers
    video.currentTime = savedTime

    // Give the decoder a moment, then check if it recovered
    const timeout = setTimeout(() => {
      // readyState < HAVE_CURRENT_DATA means decoder didn't recover
      if (video.readyState < 2 || video.error) {
        dbg(`Video decoder lost (readyState=${video.readyState}), showing recovery toast`)
        toast.classList.remove('hidden')
      } else if (wasPlaying) {
        video.play().catch(() => {})
      }
    }, 500)

    // If the seek actually works, we're fine — hide any toast and resume
    video.addEventListener('seeked', function onRecovery() {
      video.removeEventListener('seeked', onRecovery)
      clearTimeout(timeout)
      toast.classList.add('hidden')
      if (wasPlaying) {
        video.play().catch(() => {})
      }
    }, { once: true })
  })

  // Toast tap: reload video source at the same position
  toast.addEventListener('click', () => {
    const t = video.currentTime
    const src = video.src
    dbg('User tapped recovery toast — reloading video')
    toast.classList.add('hidden')
    video.src = ''
    video.src = src
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = t
      startAnimationLoop()
    }, { once: true })
  })
}

// When entering compare mode, wire video A events to restart the animation loop
let comparePlayHandler: (() => void) | null = null
let compareSeekedHandler: (() => void) | null = null

onCompareEnter(() => {
  const vA = getVideoA
  if (vA && vA !== video) {
    comparePlayHandler = startAnimationLoop
    compareSeekedHandler = startAnimationLoop
    vA.addEventListener('play', comparePlayHandler)
    vA.addEventListener('seeked', compareSeekedHandler)
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
  // Remove video A compare listeners to prevent leaks
  const vA = getVideoA
  if (vA && vA !== video) {
    if (comparePlayHandler) vA.removeEventListener('play', comparePlayHandler)
    if (compareSeekedHandler) vA.removeEventListener('seeked', compareSeekedHandler)
  }
  comparePlayHandler = null
  compareSeekedHandler = null

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
