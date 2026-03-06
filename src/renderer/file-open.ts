/**
 * OpenPDR Viewer — File open, drag-and-drop, parse flow
 */

import { video, setTelemetry, setCurrentRow, setLapData, setSessionInfo, dbg, getEditMode } from './state'
import { getRow, createTelemetryStore } from '../shared/telemetry-store'
import { showHud, resetCarryForward } from './hud'
import { showChartPanel } from './resizer'
import { clampAllToViewport } from './edit-mode'
import { setCompareFilePath } from './compare-ui'

const pdr = window.pdr ?? null

// ── DOM refs ──
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement
const fileNameEl = document.getElementById('file-name') as HTMLSpanElement
const noFilePrompt = document.getElementById('no-file-prompt') as HTMLDivElement
const parseProgress = document.getElementById('parse-progress') as HTMLDivElement
const videoContainer = document.getElementById('video-container') as HTMLDivElement
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement

function showProgress(msg: string): void {
  parseProgress.textContent = msg
  parseProgress.classList.add('active')
}

function hideProgress(): void {
  parseProgress.classList.remove('active')
}

async function openFile(filePath?: string): Promise<void> {
  if (!pdr) { dbg('pdr API not available (web build)'); return }

  if (!filePath) {
    dbg('Opening file dialog...')
    filePath = await pdr.openFileDialog() ?? undefined
    if (!filePath) { dbg('Dialog canceled'); return }
  }
  dbg('Selected: ' + filePath)

  // New primary file — clear previously allowed video paths
  await pdr.resetAllowedVideoPaths()

  // Display file name
  const parts = filePath.replace(/\\/g, '/').split('/')
  fileNameEl.textContent = parts[parts.length - 1]

  showProgress('Parsing...')

  let parseDone = false
  const removeProgressListener = pdr.onParseProgress((phase, pct) => {
    if (!parseDone) showProgress(`${phase} ${pct}%`)
  })

  // Track file path for compare mode
  setCompareFilePath(filePath)

  // Ensure protocol handler accepts this path (dialog sets it automatically, but drag-and-drop doesn't)
  await pdr.setAllowedVideoPath(filePath)

  // Load video via pdr-file:// protocol
  const videoUrl = pdr.getVideoUrl(filePath)
  dbg('Video URL: ' + videoUrl)
  video.src = videoUrl
  video.load()

  // Parse telemetry directly from the MP4 file
  try {
    const result = await pdr.parsePdrFile(filePath)
    parseDone = true
    removeProgressListener()
    const store = result.store
    const meta = result.metadata
    dbg(`Parsed ${store.length} rows, duration ${meta.duration.toFixed(1)}s`)
    if (meta.maxSpeed_kph) dbg(`Max speed: ${meta.maxSpeed_kph.toFixed(1)} kph`)
    if (meta.maxRpm) dbg(`Max RPM: ${meta.maxRpm.toFixed(0)}`)
    if (meta.sessionInfo) {
      const si = meta.sessionInfo
      if (si.vehicle) dbg(`Vehicle: ${si.vehicle}`)
      if (si.engine) dbg(`Engine: ${si.engine}`)
      if (si.year) dbg(`Year: ${si.year}`)
      if (si.timestamp) dbg(`Recorded: ${si.timestamp}`)
      if (si.generation !== undefined) dbg(`Generation: ${si.generation}`)
      if (si.mmpVersion !== undefined) dbg(`MMP firmware: v${si.mmpVersion}`)
    }
    setLapData(meta.lapData ?? null)
    setSessionInfo(meta.sessionInfo ?? null)
    setTelemetry(store, meta.duration)
    // Seed HUD with first row so indicators aren't blank on load
    if (store.length > 0) setCurrentRow(getRow(store, 0))
    if (meta.lapData?.hasLapData) {
      const method = meta.lapData.detectionMethod === 'events'
        ? 'start/finish line events from device' : 'GPS density heuristic'
      dbg(`Laps detected: ${meta.lapData.laps.length} (${method})`)
    } else {
      dbg('No laps detected')
    }
    hideProgress()
  } catch (err) {
    parseDone = true
    removeProgressListener()
    dbg('Parse failed: ' + (err instanceof Error ? err.message : String(err)))
    hideProgress()
    setTelemetry(createTelemetryStore(0), 0)
  }

  resetCarryForward()
}

export function initFileOpen(): void {
  btnOpen.addEventListener('click', () => openFile())

  // ── Video events ──
  video.addEventListener('loadedmetadata', () => {
    dbg(`Video metadata loaded — duration: ${video.duration.toFixed(1)}s, ${video.videoWidth}x${video.videoHeight}`)
    video.classList.add('loaded')
    noFilePrompt.classList.add('hidden')
    showHud()
    showChartPanel()
    // Clamp overlay positions now that elements are visible and laid out
    requestAnimationFrame(() => clampAllToViewport())
  })

  video.addEventListener('error', () => {
    const e = video.error
    dbg(`VIDEO ERROR: code=${e?.code} message="${e?.message}"`)
  })

  // ── Drag-and-drop ──
  videoContainer.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    videoContainer.classList.add('drag-over')
  })

  videoContainer.addEventListener('dragleave', () => {
    videoContainer.classList.remove('drag-over')
  })

  videoContainer.addEventListener('drop', (e) => {
    e.preventDefault()
    videoContainer.classList.remove('drag-over')
    if (!pdr) return
    const file = e.dataTransfer?.files[0]
    if (file && file.name.toLowerCase().endsWith('.mp4')) {
      const filePath = pdr.getPathForFile(file)
      if (filePath) openFile(filePath)
    }
  })

  // Click on video area to toggle play/pause
  videoContainer.addEventListener('click', (e) => {
    if (getEditMode()) return  // Don't toggle play in edit mode
    if ((e.target as HTMLElement).closest('#no-file-prompt')) return
    if ((e.target as HTMLElement).closest('.hud-element')) return
    if (!video.src) return
    btnPlay.click()
  })
}
