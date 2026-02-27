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
import { initChartPanel } from './strip-chart'

const BUILD_ID = 'phase2-v1'
dbg(`Renderer loaded [${BUILD_ID}], pdr API: ${window.pdr ? 'OK' : 'MISSING'}`)

// ── Initialize modules ──
initHud()
initControls()
initFileOpen()
initResizer()
initOverlaySettings()
initEditMode()
initChartPanel()

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

// ── Animation loop ──
// Track last known time so we detect seeks while paused (e.g. chart click-to-seek)
let lastVideoTime = -1

function onAnimationFrame(): void {
  const t = video.currentTime
  if (!video.paused || getIsScrubbing() || t !== lastVideoTime) {
    lastVideoTime = t
    setCurrentRow(findRowAtTime(t))  // Only fires listeners if row changed
    controls.updateScrubBar(t)
    controls.updateTimeDisplay(t)
    fireFrameTick()  // Always fires — chart playhead needs smooth animation
    updateFpsCounter()
  }
  requestAnimationFrame(onAnimationFrame)
}

requestAnimationFrame(onAnimationFrame)
