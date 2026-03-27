/**
 * OpenPDR Viewer — Remix Mode: UI & Entry/Exit Flow
 *
 * Handles the Remix button, file dialogs, sync fine-tune panel,
 * and keyboard shortcuts for remix mode.
 */

import {
  isRemixMode,
  enterRemixMode,
  exitRemixMode,
  getRemixOffset,
  getRemixUserOffset,
  setRemixUserOffset,
  getRemixConfidence,
  getGoProStore,
  getGoProFileName,
  getPdrFileName,
  onRemixEnter,
  onRemixExit,
  onRemixSyncChange,
  type RemixConfig,
} from './remix-state'
import {
  telemetryStore,
  video,
  setTelemetry,
  setLapData,
  setSessionInfo,
  setAvSyncOffset,
  setCurrentRow,
  onTelemetryLoad,
  dbg,
  sessionInfo,
  lapData,
  duration,
} from './state'
import type { TelemetryStore } from '../shared/telemetry-store'
import { getRow, createTelemetryStore } from '../shared/telemetry-store'
import { computeRemixSync } from './remix-sync'
import { showHud, resetCarryForward } from './hud'
import { showChartPanel } from './resizer'
import { clampAllToViewport } from './edit-mode'
import { isCompareMode } from './compare-state'
import { STORAGE_KEYS } from './storage-keys'

const pdr = window.pdr ?? null

// ── DOM refs ──
const btnRemix = document.getElementById('btn-remix') as HTMLButtonElement | null
const syncPanel = document.getElementById('remix-sync-panel') as HTMLDivElement | null
const syncOffsetDisplay = document.getElementById('remix-offset-display') as HTMLSpanElement | null
const syncConfidenceDisplay = document.getElementById('remix-confidence') as HTMLSpanElement | null

// ── Saved state for restoring after exit ──
let savedPdrStore: TelemetryStore | null = null
let savedPdrDuration = 0
let savedVideoSrc = ''
let savedPdrFilePath = ''

/**
 * Entry flow: PDR already loaded, user picks a GoPro file.
 */
async function enterWithGoPro(): Promise<void> {
  if (!pdr || !telemetryStore || isCompareMode()) return

  const goProPath = await pdr.openFileDialog()
  if (!goProPath) return

  dbg('Remix: parsing GoPro file...')

  await pdr.setAllowedVideoPath(goProPath)

  // Parse GoPro to extract GPS telemetry
  let goProResult
  try {
    goProResult = await pdr.parsePdrFile(goProPath)
  } catch (err) {
    dbg('Remix: GoPro parse failed: ' + (err instanceof Error ? err.message : String(err)))
    return
  }

  const goProStore = goProResult.store
  if (goProStore.length < 10) {
    dbg('Remix: GoPro file has insufficient telemetry data')
    return
  }

  // Save current state for restore on exit
  savedPdrStore = telemetryStore
  savedPdrDuration = duration
  savedVideoSrc = video.src
  savedPdrFilePath = ''

  const pdrStore = telemetryStore
  const goFileName = extractFileName(goProPath)
  const pdrFileName = (document.getElementById('file-name') as HTMLSpanElement).textContent || 'PDR'

  // Compute sync offset
  dbg('Remix: computing sync offset...')
  const goProTimestamp = goProResult.metadata.sessionInfo?.timestamp
  const pdrTimestamp = sessionInfo?.timestamp
  const syncResult = computeRemixSync(goProStore, pdrStore, goProTimestamp, pdrTimestamp)
  dbg(`Remix: sync offset=${syncResult.offset.toFixed(3)}s, confidence=${(syncResult.confidence * 100).toFixed(0)}%`)

  // Load remix user offset from storage if previously saved for this pair
  const storageKey = remixStorageKey(goFileName, pdrFileName)
  const savedUserOffset = loadRemixUserOffset(storageKey)

  const config: RemixConfig = {
    goProStore,
    pdrStore,
    goProFilePath: goProPath,
    pdrFilePath: savedPdrFilePath,
    goProFileName: goFileName,
    pdrFileName,
    baseOffset: syncResult.offset,
    confidence: syncResult.confidence,
    goProSessionInfo: goProResult.metadata.sessionInfo ?? null,
    pdrSessionInfo: sessionInfo,
  }

  // Swap video to GoPro
  video.pause()
  video.src = pdr.getVideoUrl(goProPath)
  video.load()

  // PDR store stays loaded — overlays now show PDR data on GoPro video
  // Apply the sync offset so telemetry aligns with GoPro video
  const totalOffset = syncResult.offset + savedUserOffset
  setAvSyncOffset(totalOffset)

  // Enter remix mode (fires event bus)
  enterRemixMode(config)
  if (savedUserOffset !== 0) {
    setRemixUserOffset(savedUserOffset)
  }

  dbg(`Remix mode entered: ${goFileName} + ${pdrFileName}`)
}

/**
 * Entry flow: fresh start — open GoPro first (it's the video), then PDR.
 */
async function enterFreshRemix(): Promise<void> {
  if (!pdr || isCompareMode()) return

  // Step 1: Open GoPro
  const goProPath = await pdr.openFileDialog()
  if (!goProPath) return

  await pdr.setAllowedVideoPath(goProPath)

  dbg('Remix: parsing GoPro file...')
  let goProResult
  try {
    goProResult = await pdr.parsePdrFile(goProPath)
  } catch (err) {
    dbg('Remix: GoPro parse failed: ' + (err instanceof Error ? err.message : String(err)))
    return
  }

  const goProStore = goProResult.store

  // Step 2: Open PDR
  const pdrPath = await pdr.openFileDialog()
  if (!pdrPath) return

  await pdr.setAllowedVideoPath(pdrPath)

  dbg('Remix: parsing PDR file...')
  let pdrResult
  try {
    pdrResult = await pdr.parsePdrFile(pdrPath)
  } catch (err) {
    dbg('Remix: PDR parse failed: ' + (err instanceof Error ? err.message : String(err)))
    return
  }

  const pdrStore = pdrResult.store
  if (pdrStore.length < 10) {
    dbg('Remix: PDR file has insufficient telemetry data')
    return
  }

  savedPdrStore = null
  savedPdrDuration = 0
  savedVideoSrc = ''
  savedPdrFilePath = pdrPath

  const goFileName = extractFileName(goProPath)
  const pdrFileName = extractFileName(pdrPath)

  // Set PDR as the active telemetry
  setLapData(pdrResult.metadata.lapData ?? null)
  setSessionInfo(pdrResult.metadata.sessionInfo ?? null)
  setTelemetry(pdrStore, pdrResult.metadata.duration)
  if (pdrStore.length > 0) setCurrentRow(getRow(pdrStore, 0))

  // Compute sync
  dbg('Remix: computing sync offset...')
  const syncResult = computeRemixSync(goProStore, pdrStore,
    goProResult.metadata.sessionInfo?.timestamp,
    pdrResult.metadata.sessionInfo?.timestamp)
  dbg(`Remix: sync offset=${syncResult.offset.toFixed(3)}s, confidence=${(syncResult.confidence * 100).toFixed(0)}%`)

  const config: RemixConfig = {
    goProStore,
    pdrStore,
    goProFilePath: goProPath,
    pdrFilePath: pdrPath,
    goProFileName: goFileName,
    pdrFileName,
    baseOffset: syncResult.offset,
    confidence: syncResult.confidence,
    goProSessionInfo: goProResult.metadata.sessionInfo ?? null,
    pdrSessionInfo: pdrResult.metadata.sessionInfo ?? null,
  }

  // Load GoPro as video
  video.src = pdr.getVideoUrl(goProPath)
  video.load()
  setAvSyncOffset(syncResult.offset)

  enterRemixMode(config)
  showHud()
  showChartPanel()
  requestAnimationFrame(() => clampAllToViewport())

  // Update file name display
  const fileNameEl = document.getElementById('file-name') as HTMLSpanElement
  fileNameEl.textContent = `${goFileName} + ${pdrFileName}`

  dbg(`Remix mode entered: ${goFileName} + ${pdrFileName}`)
}

/** Exit remix mode and restore previous state. */
function doExitRemix(): void {
  if (!isRemixMode()) return

  // Save user offset for this pair
  const storageKey = remixStorageKey(getGoProFileName(), getPdrFileName())
  saveRemixUserOffset(storageKey, getRemixUserOffset())

  exitRemixMode()

  // Restore previous video + telemetry if we had a PDR loaded before
  if (savedPdrStore && savedVideoSrc) {
    video.src = savedVideoSrc
    video.load()
    setTelemetry(savedPdrStore, savedPdrDuration)
    setAvSyncOffset(parseFloat(localStorage.getItem(STORAGE_KEYS.avSync) || '0'))
  }

  savedPdrStore = null
  savedPdrDuration = 0
  savedVideoSrc = ''

  dbg('Remix mode exited')
}

/** Re-run auto-sync. */
function rerunAutoSync(): void {
  if (!isRemixMode()) return
  const goStore = getGoProStore()
  const pdrStore = telemetryStore
  if (!goStore || !pdrStore) return

  dbg('Remix: re-running auto-sync...')
  const syncResult = computeRemixSync(goStore, pdrStore)
  // Update the base offset (remixBaseOffset) by re-entering with new config
  // For simplicity, just update the avSyncOffset
  const newOffset = syncResult.offset + getRemixUserOffset()
  setAvSyncOffset(newOffset)
  updateSyncDisplay()
  dbg(`Remix: new offset=${syncResult.offset.toFixed(3)}s, confidence=${(syncResult.confidence * 100).toFixed(0)}%`)
}

// ── Sync panel updates ──

function updateSyncDisplay(): void {
  if (!syncOffsetDisplay) return
  const offset = getRemixOffset()
  const sign = offset >= 0 ? '+' : ''
  syncOffsetDisplay.textContent = `${sign}${offset.toFixed(3)}s`

  if (syncConfidenceDisplay) {
    syncConfidenceDisplay.textContent = `${(getRemixConfidence() * 100).toFixed(0)}%`
  }
}

function nudgeOffset(delta: number): void {
  if (!isRemixMode()) return
  const newUserOffset = getRemixUserOffset() + delta
  setRemixUserOffset(newUserOffset)
  setAvSyncOffset(getRemixOffset())
  updateSyncDisplay()
}

// ── Storage helpers ──

function remixStorageKey(goFile: string, pdrFile: string): string {
  return `${STORAGE_KEYS.remixUserOffset}:${goFile}:${pdrFile}`
}

function loadRemixUserOffset(key: string): number {
  const saved = localStorage.getItem(key)
  if (saved) {
    const v = parseFloat(saved)
    if (!isNaN(v)) return v
  }
  return 0
}

function saveRemixUserOffset(key: string, value: number): void {
  if (value === 0) {
    localStorage.removeItem(key)
  } else {
    localStorage.setItem(key, value.toFixed(4))
  }
}

function extractFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1]
}

// ── Dropdown menu ──
let dropdown: HTMLDivElement | null = null

function showDropdown(): void {
  if (dropdown) { hideDropdown(); return }
  if (!btnRemix) return

  dropdown = document.createElement('div')
  dropdown.className = 'remix-dropdown visible'

  const hasTelemetry = !!telemetryStore && telemetryStore.length > 0

  // Option 1: Remix current PDR with a GoPro
  const itemOverlay = document.createElement('div')
  itemOverlay.className = 'remix-dropdown-item' + (hasTelemetry ? '' : ' disabled')
  itemOverlay.textContent = 'Overlay PDR on GoPro video\u2026'
  if (hasTelemetry) {
    itemOverlay.addEventListener('click', () => {
      hideDropdown()
      enterWithGoPro()
    })
  }
  dropdown.appendChild(itemOverlay)

  // Option 2: Fresh remix (pick both files)
  const itemFresh = document.createElement('div')
  itemFresh.className = 'remix-dropdown-item'
  itemFresh.textContent = 'Open GoPro + PDR files\u2026'
  itemFresh.addEventListener('click', () => {
    hideDropdown()
    enterFreshRemix()
  })
  dropdown.appendChild(itemFresh)

  // Position
  const rect = btnRemix.getBoundingClientRect()
  dropdown.style.right = `${window.innerWidth - rect.right}px`
  dropdown.style.left = 'auto'
  dropdown.style.top = `${rect.bottom + 4}px`
  document.body.appendChild(dropdown)

  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', outsideClickHandler)
  })
}

function hideDropdown(): void {
  if (dropdown) {
    dropdown.remove()
    dropdown = null
  }
  document.removeEventListener('pointerdown', outsideClickHandler)
}

function outsideClickHandler(e: PointerEvent): void {
  if (dropdown && !dropdown.contains(e.target as Node)) {
    hideDropdown()
  }
}

// ── Initialization ──

export function initRemixUI(): void {
  if (!btnRemix) return

  // Remix requires Electron APIs (file dialogs, parser IPC) — hide on web
  if (!pdr) {
    btnRemix.style.display = 'none'
    return
  }

  btnRemix.style.display = ''

  // Remix button click
  btnRemix.addEventListener('click', () => {
    if (isRemixMode()) {
      doExitRemix()
    } else if (isCompareMode()) {
      // Can't remix while in compare mode
      return
    } else {
      showDropdown()
    }
  })

  // Wire sync panel buttons
  const btnAutoAlign = document.getElementById('remix-auto-align')
  const btnExitRemix = document.getElementById('remix-exit')
  const nudgeButtons = document.querySelectorAll<HTMLButtonElement>('[data-remix-nudge]')

  btnAutoAlign?.addEventListener('click', rerunAutoSync)
  btnExitRemix?.addEventListener('click', doExitRemix)

  nudgeButtons.forEach(btn => {
    const delta = parseFloat(btn.dataset.remixNudge || '0')
    btn.addEventListener('click', () => nudgeOffset(delta))
  })

  // Keyboard shortcuts for remix mode
  document.addEventListener('keydown', (e) => {
    if (!isRemixMode()) return
    // Don't capture when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return

    switch (e.key) {
      case '[':
        e.preventDefault()
        nudgeOffset(-1 / 59.94) // -1 frame
        break
      case ']':
        e.preventDefault()
        nudgeOffset(1 / 59.94) // +1 frame
        break
      case '{':
        e.preventDefault()
        nudgeOffset(-0.1)
        break
      case '}':
        e.preventDefault()
        nudgeOffset(0.1)
        break
    }
  })

  // Show/hide sync panel on enter/exit
  onRemixEnter(() => {
    if (syncPanel) syncPanel.style.display = ''
    if (btnRemix) {
      btnRemix.classList.add('active')
      btnRemix.textContent = 'Exit Remix'
    }
    updateSyncDisplay()
  })

  onRemixExit(() => {
    if (syncPanel) syncPanel.style.display = 'none'
    if (btnRemix) {
      btnRemix.classList.remove('active')
      btnRemix.textContent = 'Remix'
    }
  })

  // Update display when sync changes
  onRemixSyncChange(() => {
    updateSyncDisplay()
  })
}
