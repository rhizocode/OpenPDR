/**
 * OpenPDR Viewer — Compare Mode: UI & Entry/Exit Flow
 *
 * Handles the Compare button, dropdown menu, color-coded lap selectors,
 * and layout transitions for entering/exiting compare mode.
 */

import {
  isCompareMode,
  enterCompareMode,
  exitCompareMode,
  setCompareLapA,
  setCompareLapB,
  lapA,
  lapB,
  lapDataA as cmpLapDataA,
  lapDataB as cmpLapDataB,
  onCompareEnter,
  onCompareExit,
  onCompareLapChange,
  videoA as cmpVideoA,
  type CompareConfig,
} from './compare-state'
import {
  telemetryStore,
  lapData,
  video,
  onTelemetryLoad,
  avSyncOffset,
  seekToTelemetryTime,
  sessionInfo,
  dbg,
} from './state'
import type { LapInfo, LapData } from './types'
import type { TelemetryStore } from '../shared/telemetry-store'
import { createOverlayB, destroyOverlayB, applyOverlayConfigB, updateAnchorBBounds, populateSessionB } from './compare-overlay-b'
import { getOverlayConfig } from './hud'
import { formatLapTime } from './defaults'

const pdr = window.pdr

// ── DOM refs ──
const btnCompare = document.getElementById('btn-compare') as HTMLButtonElement
const lapSelector = document.getElementById('lap-selector') as HTMLSelectElement
const compareLapA = document.getElementById('compare-lap-a') as HTMLSelectElement
const compareLapB = document.getElementById('compare-lap-b') as HTMLSelectElement
const videoContainer = document.getElementById('video-container') as HTMLDivElement

// Track file paths for display
let currentFilePath = ''
let currentFileName = ''

// ── Dropdown menu ──
let dropdown: HTMLDivElement | null = null

function showDropdown(): void {
  if (dropdown) { hideDropdown(); return }

  dropdown = document.createElement('div')
  dropdown.className = 'compare-dropdown visible'

  const hasMultipleLaps = (lapData?.laps.length ?? 0) >= 2

  // Option 1: Compare laps in same file
  const itemSame = document.createElement('div')
  itemSame.className = 'compare-dropdown-item' + (hasMultipleLaps ? '' : ' disabled')
  itemSame.textContent = 'Compare laps in this file'
  if (hasMultipleLaps) {
    itemSame.addEventListener('click', () => {
      hideDropdown()
      enterSameFile()
    })
  }
  dropdown.appendChild(itemSame)

  // Option 2: Compare with another file
  const itemOther = document.createElement('div')
  itemOther.className = 'compare-dropdown-item'
  itemOther.textContent = 'Compare with another file\u2026'
  itemOther.addEventListener('click', () => {
    hideDropdown()
    enterDifferentFile()
  })
  dropdown.appendChild(itemOther)

  // Position relative to the compare button (right-aligned so it stays on screen)
  const rect = btnCompare.getBoundingClientRect()
  dropdown.style.right = `${window.innerWidth - rect.right}px`
  dropdown.style.left = 'auto'
  dropdown.style.top = `${rect.bottom + 4}px`
  document.body.appendChild(dropdown)

  // Close on outside click (delayed to avoid immediate close)
  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', outsideClickHandler, { once: true })
  })
}

function hideDropdown(): void {
  if (dropdown) {
    dropdown.remove()
    dropdown = null
  }
}

function outsideClickHandler(e: PointerEvent): void {
  if (dropdown && !dropdown.contains(e.target as Node)) {
    hideDropdown()
  }
}

// ── Format helpers ──

function findBestLapIdx(laps: LapInfo[]): number {
  let best = 0
  for (let i = 1; i < laps.length; i++) {
    if (laps[i].lapTime < laps[best].lapTime) best = i
  }
  return best
}

function findSecondBestIdx(laps: LapInfo[], bestIdx: number): number {
  let second = bestIdx === 0 ? 1 : 0
  for (let i = 0; i < laps.length; i++) {
    if (i === bestIdx) continue
    if (laps[i].lapTime < laps[second].lapTime) second = i
  }
  return second
}

// ── Populate a compare select with laps ──
function populateCompareSelect(select: HTMLSelectElement, ld: LapData, selectedIdx: number): void {
  select.innerHTML = ''
  const bestTime = Math.min(...ld.laps.map(l => l.lapTime))
  for (let i = 0; i < ld.laps.length; i++) {
    const lap = ld.laps[i]
    const opt = document.createElement('option')
    opt.value = String(i)
    let label = `Lap ${lap.lapNumber}  ${formatLapTime(lap.lapTime)}`
    if (lap.lapTime === bestTime) label += '  best'
    else label += `  +${(lap.lapTime - bestTime).toFixed(3)}`
    opt.textContent = label
    select.appendChild(opt)
  }
  select.value = String(selectedIdx)
}

// ── Entry flow: same file ──
function enterSameFile(): void {
  const store = telemetryStore
  const ld = lapData
  if (!store || !ld?.hasLapData || ld.laps.length < 2) return

  const bestIdx = findBestLapIdx(ld.laps)
  const secondIdx = findSecondBestIdx(ld.laps, bestIdx)

  // Create video B element (clone of same video)
  const videoB = document.createElement('video') as HTMLVideoElement
  videoB.id = 'video-b'
  videoB.preload = 'auto'
  videoB.src = video.src
  videoB.load()

  const config: CompareConfig = {
    storeA: store,
    storeB: store,
    lapDataA: ld,
    lapDataB: ld,
    lapA: ld.laps[bestIdx],
    lapB: ld.laps[secondIdx],
    videoA: video,
    videoB,
    filePathA: currentFilePath,
    filePathB: currentFilePath,
    fileNameA: currentFileName,
    fileNameB: currentFileName,
    sessionInfoA: sessionInfo,
    sessionInfoB: sessionInfo,
  }

  enterCompareMode(config)
  applyCompareLayout(config, bestIdx, secondIdx)
}

// ── Entry flow: different file ──
async function enterDifferentFile(): Promise<void> {
  const storeA = telemetryStore
  const ldA = lapData
  if (!storeA || !ldA?.hasLapData || ldA.laps.length < 1) return

  // Open file B
  dbg('Compare: opening file B...')
  const filePathB = await pdr.openFileDialog()
  if (!filePathB) { dbg('Compare: dialog canceled'); return }

  await pdr.setAllowedVideoPath(filePathB)

  // Create video B element
  const videoB = document.createElement('video') as HTMLVideoElement
  videoB.id = 'video-b'
  videoB.preload = 'auto'
  videoB.src = pdr.getVideoUrl(filePathB)
  videoB.load()

  // Parse file B
  dbg('Compare: parsing file B...')
  let resultB
  try {
    resultB = await pdr.parsePdrFile(filePathB)
  } catch (err) {
    dbg('Compare: parse failed for file B: ' + (err instanceof Error ? err.message : String(err)))
    return
  }

  const storeB = resultB.store
  const ldB = resultB.metadata.lapData
  if (!ldB?.hasLapData || ldB.laps.length < 1) {
    dbg('Compare: file B has no laps')
    return
  }

  const bestA = findBestLapIdx(ldA.laps)
  const bestB = findBestLapIdx(ldB.laps)
  const partsB = filePathB.replace(/\\/g, '/').split('/')
  const fileNameB = partsB[partsB.length - 1]

  const config: CompareConfig = {
    storeA,
    storeB,
    lapDataA: ldA,
    lapDataB: ldB,
    lapA: ldA.laps[bestA],
    lapB: ldB.laps[bestB],
    videoA: video,
    videoB,
    filePathA: currentFilePath,
    filePathB: filePathB,
    fileNameA: currentFileName,
    fileNameB: fileNameB,
    sessionInfoA: sessionInfo,
    sessionInfoB: resultB.metadata.sessionInfo ?? null,
  }

  enterCompareMode(config)
  applyCompareLayout(config, bestA, bestB)
}

// ── Apply visual layout for compare mode ──
function applyCompareLayout(config: CompareConfig, idxA: number, idxB: number): void {
  // Add video B to container
  videoContainer.appendChild(config.videoB)
  videoContainer.classList.add('compare-mode')

  // Add video labels
  const labelA = document.createElement('div')
  labelA.className = 'compare-video-label label-a'
  labelA.textContent = `A: ${config.fileNameA}`
  videoContainer.appendChild(labelA)

  const labelB = document.createElement('div')
  labelB.className = 'compare-video-label label-b'
  labelB.textContent = `B: ${config.fileNameB}`
  videoContainer.appendChild(labelB)

  // Switch toolbar: hide lap-selector, show compare selects
  lapSelector.style.display = 'none'
  compareLapA.style.display = ''
  compareLapB.style.display = ''

  populateCompareSelect(compareLapA, config.lapDataA, idxA)
  populateCompareSelect(compareLapB, config.lapDataB, idxB)

  // Create B-side overlay anchor (mirrors A overlays over video B)
  const overlayAnchorA = document.getElementById('video-overlay-anchor') as HTMLDivElement
  createOverlayB(videoContainer, overlayAnchorA)
  populateSessionB(config.sessionInfoB)
  applyOverlayConfigB(getOverlayConfig())
  // Position anchor B immediately — rAF in main.ts may fire before anchorB exists
  requestAnimationFrame(() => {
    const vB = config.videoB
    if (vB.videoWidth) {
      // Video dimensions already known (e.g. same file, cloned src)
      updateAnchorBBounds(vB)
    } else {
      // Dimensions not yet known; wait for loadedmetadata
      vB.addEventListener('loadedmetadata', () => updateAnchorBBounds(vB), { once: true })
      // Still position over the correct column (no video dimensions yet)
      updateAnchorBBounds(vB)
    }
  })

  // Toggle compare button to "active" state (click to exit)
  btnCompare.classList.add('active')
  btnCompare.textContent = 'Exit Compare'

  // Seek video A to start of lap A
  seekToTelemetryTime(config.lapA.startTime)

  dbg(`Compare mode entered: Lap ${config.lapA.lapNumber} vs Lap ${config.lapB.lapNumber}`)
}

// ── Exit compare mode layout ──
function removeCompareLayout(): void {
  // Remove video B, overlay B, and labels
  const videoB = document.getElementById('video-b')
  if (videoB) videoB.remove()
  destroyOverlayB()

  videoContainer.querySelectorAll('.compare-video-label').forEach(el => el.remove())
  videoContainer.classList.remove('compare-mode')

  // Restore toolbar
  if (lapData?.hasLapData && (lapData.laps.length ?? 0) > 0) {
    lapSelector.style.display = ''
  }
  compareLapA.style.display = 'none'
  compareLapB.style.display = 'none'

  btnCompare.classList.remove('active')
  btnCompare.textContent = 'Compare'

  dbg('Compare mode exited')
}

// ── Initialization ──
export function initCompareUI(): void {
  // Show compare button when laps are loaded
  onTelemetryLoad(() => {
    const ld = lapData
    if (ld?.hasLapData && ld.laps.length > 0) {
      btnCompare.style.display = ''
      // Track file info from the file-name element
      currentFileName = (document.getElementById('file-name') as HTMLSpanElement).textContent || ''
    } else {
      btnCompare.style.display = 'none'
    }
  })

  // Compare button click
  btnCompare.addEventListener('click', () => {
    if (isCompareMode()) {
      exitCompareMode()
    } else {
      showDropdown()
    }
  })

  // Lap selector changes in compare mode
  compareLapA.addEventListener('change', () => {
    setCompareLapA(parseInt(compareLapA.value, 10))
  })

  compareLapB.addEventListener('change', () => {
    setCompareLapB(parseInt(compareLapB.value, 10))
  })

  // Wire exit cleanup
  onCompareExit(removeCompareLayout)

  // Update selects when laps change
  onCompareLapChange(() => {
    if (lapA && cmpLapDataA) {
      const idx = cmpLapDataA.laps.indexOf(lapA)
      if (idx >= 0) compareLapA.value = String(idx)
    }
    if (lapB && cmpLapDataB) {
      const idx = cmpLapDataB.laps.indexOf(lapB)
      if (idx >= 0) compareLapB.value = String(idx)
    }
  })
}

/** Called by file-open to track the current file path */
export function setCompareFilePath(filePath: string): void {
  currentFilePath = filePath
  const parts = filePath.replace(/\\/g, '/').split('/')
  currentFileName = parts[parts.length - 1]
}
