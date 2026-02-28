/**
 * OpenPDR Viewer — Playback controls
 *
 * Play/pause, scrub bar, keyboard shortcuts, playback rate.
 * Uses pointer events for future PWA/touch compatibility.
 */

import { video, formatTime, toggleDebugPanel } from './state'

let isScrubbing = false

export function getIsScrubbing(): boolean {
  return isScrubbing
}

export interface Controls {
  updateScrubBar: (t: number) => void
  updateTimeDisplay: (t: number) => void
}

export function initControls(): Controls {
  const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
  const timeCurrent = document.getElementById('time-current') as HTMLSpanElement
  const timeTotal = document.getElementById('time-total') as HTMLSpanElement
  const scrubContainer = document.getElementById('scrub-container') as HTMLDivElement
  const scrubProgress = document.getElementById('scrub-progress') as HTMLDivElement
  const scrubThumb = document.getElementById('scrub-thumb') as HTMLDivElement
  const playbackRate = document.getElementById('playback-rate') as HTMLSelectElement

  // ── Scrub bar update (called from animation loop) ──
  function updateScrubBar(t: number): void {
    if (video.duration && isFinite(video.duration)) {
      const pct = (t / video.duration) * 100
      scrubProgress.style.width = `${pct}%`
      scrubThumb.style.left = `${pct}%`
    }
  }

  function updateTimeDisplay(t: number): void {
    timeCurrent.textContent = formatTime(t)
  }


  // ── Scrub bar interaction ──
  function scrubToPosition(e: PointerEvent): void {
    const rect = scrubContainer.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    if (video.duration && isFinite(video.duration)) {
      video.currentTime = pct * video.duration
    }
  }

  scrubContainer.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    isScrubbing = true
    scrubToPosition(e)
    scrubContainer.setPointerCapture(e.pointerId)
  })

  scrubContainer.addEventListener('pointermove', (e) => {
    if (isScrubbing) scrubToPosition(e)
  })

  scrubContainer.addEventListener('pointerup', () => {
    isScrubbing = false
  })

  // ── Play/pause ──
  btnPlay.addEventListener('click', () => {
    if (video.paused) {
      video.play()
      btnPlay.innerHTML = '&#9646;&#9646;'
    } else {
      video.pause()
      btnPlay.innerHTML = '&#9654;'
    }
  })

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    // Don't capture when typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return

    if (e.code === 'Space') {
      e.preventDefault()
      btnPlay.click()
    } else if (e.code === 'ArrowRight') {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
    } else if (e.code === 'ArrowLeft') {
      video.currentTime = Math.max(0, video.currentTime - 5)
    } else if (e.code === 'Period' && video.paused) {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 30)
    } else if (e.code === 'Comma' && video.paused) {
      video.currentTime = Math.max(0, video.currentTime - 1 / 30)
    } else if (e.code === 'F2') {
      e.preventDefault()
      toggleDebugPanel()
    } else if (e.code === 'KeyC') {
      // Toggle chart panel visibility
      const chartPanel = document.getElementById('chart-panel')!
      const resizeHandle = document.getElementById('resize-handle')!
      chartPanel.classList.toggle('active')
      resizeHandle.classList.toggle('active')
    }
  })

  // ── Playback rate ──
  playbackRate.addEventListener('change', () => {
    video.playbackRate = parseFloat(playbackRate.value)
  })

  // ── Video events ──
  video.addEventListener('loadedmetadata', () => {
    timeTotal.textContent = formatTime(video.duration)
  })

  video.addEventListener('ended', () => {
    btnPlay.innerHTML = '&#9654;'
  })

  return { updateScrubBar, updateTimeDisplay }
}
