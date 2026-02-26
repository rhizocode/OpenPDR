/**
 * OpenPDR Viewer — Phase 0 PoC
 *
 * Validates that Electron <video> seeking is acceptable for track analysis.
 * Loads a hardcoded telemetry JSON and syncs HUD overlays via
 * requestAnimationFrame + binary search on video.currentTime.
 */

// Typing for the preload API
interface PdrApi {
  openFileDialog(): Promise<string | null>
  loadTelemetry(jsonPath: string): Promise<TelemetryRow[]>
  getVideoUrl(filePath: string): string
}

interface TelemetryRow {
  time: number
  speed_kph: number
  speed_mph: number
  rpm: number
  gear: string
  throttle: number
  brake: number
  lat: number
  lon: number
  gforce_lat: number
  gforce_lon: number
  steering_deg: number
}

declare global {
  interface Window { pdr: PdrApi }
}

const pdr = window.pdr

// ── Debug panel ──
const debugPanel = document.getElementById('debug-panel') as HTMLDivElement
function dbg(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  debugPanel.textContent = (debugPanel.textContent || '') + line + '\n'
  debugPanel.scrollTop = debugPanel.scrollHeight
}

dbg('Renderer loaded, pdr API: ' + (pdr ? 'OK' : 'MISSING'))

// ── DOM elements ──
const video = document.getElementById('video') as HTMLVideoElement
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement
const btnOpenPrompt = document.getElementById('btn-open-prompt') as HTMLButtonElement
const fileName = document.getElementById('file-name') as HTMLSpanElement
const noFilePrompt = document.getElementById('no-file-prompt') as HTMLDivElement
const hud = document.getElementById('hud') as HTMLDivElement
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
const timeCurrent = document.getElementById('time-current') as HTMLSpanElement
const timeTotal = document.getElementById('time-total') as HTMLSpanElement
const scrubContainer = document.getElementById('scrub-container') as HTMLDivElement
const scrubProgress = document.getElementById('scrub-progress') as HTMLDivElement
const scrubThumb = document.getElementById('scrub-thumb') as HTMLDivElement
const playbackRate = document.getElementById('playback-rate') as HTMLSelectElement

// HUD elements
const hudSpeedValue = document.getElementById('hud-speed-value') as HTMLSpanElement
const hudRpmValue = document.getElementById('hud-rpm-value') as HTMLSpanElement
const hudGearValue = document.getElementById('hud-gear-value') as HTMLSpanElement
const throttleFill = document.getElementById('throttle-fill') as HTMLDivElement
const brakeFill = document.getElementById('brake-fill') as HTMLDivElement
const gforceCanvas = document.getElementById('gforce-canvas') as HTMLCanvasElement

// ── Gear label → display mapping ──
const GEAR_DISPLAY: Record<string, string> = {
  park: 'P', neutral: 'N', reverse: 'R',
  first: '1', second: '2', third: '3',
  fourth: '4', fifth: '5', sixth: '6',
  seventh: '7', eighth: '8', ninth: '9', tenth: '10',
}

// ── State ──
let telemetry: TelemetryRow[] = []
let currentRow: TelemetryRow | null = null
let animFrameId = 0
let isScrubbing = false
let lastKnownGear = '-'

// ── Binary search: find the telemetry row closest to a given time ──
function findRowAtTime(t: number): TelemetryRow | null {
  if (telemetry.length === 0) return null

  let lo = 0
  let hi = telemetry.length - 1

  // Clamp to range
  if (t <= telemetry[0].time) return telemetry[0]
  if (t >= telemetry[hi].time) return telemetry[hi]

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (telemetry[mid].time < t) {
      lo = mid + 1
    } else if (telemetry[mid].time > t) {
      hi = mid - 1
    } else {
      return telemetry[mid]
    }
  }

  // lo is the first element > t, hi is the last element < t
  // Return whichever is closer
  if (lo >= telemetry.length) return telemetry[hi]
  if (hi < 0) return telemetry[lo]
  return (t - telemetry[hi].time) <= (telemetry[lo].time - t)
    ? telemetry[hi]
    : telemetry[lo]
}

// ── Format time as M:SS.d ──
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const sStr = s < 10 ? '0' + s.toFixed(1) : s.toFixed(1)
  return `${m}:${sStr}`
}

// ── Update HUD elements from a telemetry row ──
function updateHud(row: TelemetryRow | null): void {
  if (!row) {
    hudSpeedValue.textContent = '--'
    hudRpmValue.textContent = '--'
    hudGearValue.textContent = '-'
    throttleFill.style.width = '0%'
    brakeFill.style.width = '0%'
    return
  }

  hudSpeedValue.textContent = Math.round(row.speed_mph).toString()
  hudRpmValue.textContent = Math.round(row.rpm).toString()

  // Gear: map word labels to short display, hold last known value for sparse (5 Hz) data
  if (row.gear && row.gear !== '-') {
    lastKnownGear = GEAR_DISPLAY[row.gear] ?? row.gear
  }
  hudGearValue.textContent = lastKnownGear
  throttleFill.style.width = `${(row.throttle * 100).toFixed(0)}%`
  brakeFill.style.width = `${(row.brake * 100).toFixed(0)}%`

  drawGForce(row.gforce_lat, row.gforce_lon)
}

// ── G-force ball ──
function drawGForce(lat: number, lon: number): void {
  const ctx = gforceCanvas.getContext('2d')
  if (!ctx) return
  const w = gforceCanvas.width
  const h = gforceCanvas.height
  const cx = w / 2
  const cy = h / 2
  const maxG = 1.5 // scale: 1.5g = edge of circle
  const radius = (w / 2) - 8

  ctx.clearRect(0, 0, w, h)

  // Background circle
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fill()

  // Grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
  ctx.lineWidth = 1
  for (const g of [0.5, 1.0]) {
    const r = (g / maxG) * radius
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  // Crosshairs
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()

  // G-force dot
  const clampG = (v: number) => Math.max(-maxG, Math.min(maxG, v))
  const dotX = cx + (clampG(lat) / maxG) * radius
  const dotY = cy - (clampG(lon) / maxG) * radius // positive lon = forward = up
  ctx.beginPath()
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2)
  ctx.fillStyle = '#ff6b00'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.stroke()
}

// ── Animation loop ──
function onAnimationFrame(): void {
  if (!video.paused || isScrubbing) {
    const t = video.currentTime
    currentRow = findRowAtTime(t)
    updateHud(currentRow)
    updateScrubBar(t)
    timeCurrent.textContent = formatTime(t)
  }
  animFrameId = requestAnimationFrame(onAnimationFrame)
}

function updateScrubBar(t: number): void {
  if (video.duration && isFinite(video.duration)) {
    const pct = (t / video.duration) * 100
    scrubProgress.style.width = `${pct}%`
    scrubThumb.style.left = `${pct}%`
  }
}

// ── Scrub bar interaction ──
function scrubToPosition(e: MouseEvent): void {
  const rect = scrubContainer.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  dbg(`scrub: clientX=${e.clientX} rect.left=${rect.left.toFixed(0)} rect.width=${rect.width.toFixed(0)} pct=${pct.toFixed(3)} duration=${video.duration}`)
  if (video.duration && isFinite(video.duration)) {
    video.currentTime = pct * video.duration
  }
}

scrubContainer.addEventListener('mousedown', (e) => {
  e.preventDefault()
  isScrubbing = true
  scrubToPosition(e)
})

document.addEventListener('mousemove', (e) => {
  if (isScrubbing) scrubToPosition(e)
})

document.addEventListener('mouseup', () => {
  isScrubbing = false
})

// ── Play/pause ──
btnPlay.addEventListener('click', () => {
  if (video.paused) {
    video.play()
    btnPlay.innerHTML = '&#9646;&#9646;' // pause icon
  } else {
    video.pause()
    btnPlay.innerHTML = '&#9654;' // play icon
  }
})

// Keyboard: space = play/pause, arrows = seek
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault()
    btnPlay.click()
  } else if (e.code === 'ArrowRight') {
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
  } else if (e.code === 'ArrowLeft') {
    video.currentTime = Math.max(0, video.currentTime - 5)
  } else if (e.code === 'Period' && video.paused) {
    // Frame step forward (~1/30s)
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 30)
  } else if (e.code === 'Comma' && video.paused) {
    // Frame step backward
    video.currentTime = Math.max(0, video.currentTime - 1 / 30)
  }
})

// Playback rate
playbackRate.addEventListener('change', () => {
  video.playbackRate = parseFloat(playbackRate.value)
})

// ── Video events ──
video.addEventListener('loadedmetadata', () => {
  dbg(`Video metadata loaded — duration: ${video.duration.toFixed(1)}s, ${video.videoWidth}x${video.videoHeight}`)
  timeTotal.textContent = formatTime(video.duration)
  video.classList.add('loaded')
  noFilePrompt.classList.add('hidden')
  hud.classList.add('active')
})

video.addEventListener('canplay', () => dbg('Video canplay'))
video.addEventListener('error', () => {
  const e = video.error
  dbg(`VIDEO ERROR: code=${e?.code} message="${e?.message}"`)
})

video.addEventListener('ended', () => {
  btnPlay.innerHTML = '&#9654;'
})

// ── File open flow ──
async function openFile(): Promise<void> {
  dbg('Opening file dialog...')
  const filePath = await pdr.openFileDialog()
  if (!filePath) { dbg('Dialog canceled'); return }
  dbg('Selected: ' + filePath)

  // Display file name
  const parts = filePath.replace(/\\/g, '/').split('/')
  fileName.textContent = parts[parts.length - 1]

  // Load video via custom protocol
  const videoUrl = pdr.getVideoUrl(filePath)
  dbg('Video URL: ' + videoUrl)
  video.src = videoUrl
  video.load()
  dbg('video.load() called')

  // Load telemetry — look for a .json sidecar next to the video
  const jsonPath = filePath.replace(/\.mp4$/i, '_telemetry.json')
  dbg('Telemetry path: ' + jsonPath)
  try {
    telemetry = await pdr.loadTelemetry(jsonPath)
    dbg(`Loaded ${telemetry.length} telemetry rows (first time: ${telemetry[0]?.time}s)`)
  } catch (err) {
    dbg('Telemetry load failed: ' + (err instanceof Error ? err.message : String(err)))
    telemetry = []
  }
}

btnOpen.addEventListener('click', openFile)
btnOpenPrompt.addEventListener('click', openFile)

// Click on video area to toggle play/pause
const videoContainer = document.getElementById('video-container') as HTMLDivElement
videoContainer.addEventListener('click', (e) => {
  // Ignore if clicking the open-file prompt buttons
  if ((e.target as HTMLElement).closest('#no-file-prompt')) return
  if (!video.src) return
  btnPlay.click()
})

// ── Start animation loop ──
animFrameId = requestAnimationFrame(onAnimationFrame)
