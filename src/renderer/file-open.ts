/**
 * OpenPDR Viewer — File open, drag-and-drop, parse flow
 */

import { video, setTelemetry, setCurrentRow, setLapData, dbg, getEditMode } from './state'
import { showHud, resetCarryForward } from './hud'
import { showChartPanel } from './resizer'
import { clampAllToViewport } from './edit-mode'

/** Electron adds a `path` property to dropped File objects */
interface ElectronFile extends File { path: string }

const pdr = window.pdr

// ── DOM refs ──
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement
const btnOpenPrompt = document.getElementById('btn-open-prompt') as HTMLButtonElement
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
  if (!filePath) {
    dbg('Opening file dialog...')
    filePath = await pdr.openFileDialog()
    if (!filePath) { dbg('Dialog canceled'); return }
  }
  dbg('Selected: ' + filePath)

  // Display file name
  const parts = filePath.replace(/\\/g, '/').split('/')
  fileNameEl.textContent = parts[parts.length - 1]

  showProgress('Parsing...')

  pdr.onParseProgress((phase, pct) => {
    showProgress(`${phase} ${pct}%`)
  })

  // Load video via pdr-file:// protocol
  const videoUrl = pdr.getVideoUrl(filePath)
  dbg('Video URL: ' + videoUrl)
  video.src = videoUrl
  video.load()

  // Parse telemetry directly from the MP4 file
  try {
    const result = await pdr.parsePdrFile(filePath)
    const rows = result.rows
    const meta = result.metadata
    dbg(`Parsed ${rows.length} rows, duration ${meta.duration.toFixed(1)}s`)
    if (meta.maxSpeed_kph) dbg(`Max speed: ${meta.maxSpeed_kph.toFixed(1)} kph`)
    if (meta.maxRpm) dbg(`Max RPM: ${meta.maxRpm.toFixed(0)}`)
    setLapData(meta.lapData ?? null)
    setTelemetry(rows, meta.duration)
    // Seed HUD with first row so indicators aren't blank on load
    if (rows.length > 0) setCurrentRow(rows[0])
    if (meta.lapData?.hasLapData) {
      const method = meta.lapData.detectionMethod === 'events'
        ? 'start/finish line events from device' : 'GPS density heuristic'
      dbg(`Laps detected: ${meta.lapData.laps.length} (${method})`)
    } else {
      dbg('No laps detected')
    }
    hideProgress()
  } catch (err) {
    dbg('Parse failed: ' + (err instanceof Error ? err.message : String(err)))
    hideProgress()
    setTelemetry([], 0)
  }

  resetCarryForward()
}

export function initFileOpen(): void {
  btnOpen.addEventListener('click', () => openFile())
  btnOpenPrompt.addEventListener('click', () => openFile())

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

  video.addEventListener('canplay', () => {})
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
    const file = e.dataTransfer?.files[0] as ElectronFile | undefined
    if (file?.path && file.name.toLowerCase().endsWith('.mp4')) {
      openFile(file.path)
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
