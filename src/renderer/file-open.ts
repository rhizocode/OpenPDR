/**
 * OpenPDR Viewer — File open, drag-and-drop, parse flow
 */

import { video, setTelemetry, setLapData, dbg, getEditMode } from './state'
import { showHud, resetCarryForward } from './hud'
import { showChartPanel } from './resizer'

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
    setTelemetry(rows, meta.duration)
    setLapData(meta.lapData ?? null)
    if (meta.lapData?.hasLapData) {
      dbg(`Laps detected: ${meta.lapData.laps.length}`)
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
  })

  video.addEventListener('canplay', () => dbg('Video canplay'))
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
    const file = e.dataTransfer?.files[0]
    if (file && (file as any).path && file.name.toLowerCase().endsWith('.mp4')) {
      openFile((file as any).path)
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
