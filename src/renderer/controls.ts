/**
 * OpenPDR Viewer — Playback controls
 *
 * Play/pause, scrub bar, keyboard shortcuts, playback rate.
 * Uses pointer events for future PWA/touch compatibility.
 */

import { video, formatTime, toggleDebugPanel, viewRange, getViewDuration, viewFractionToTime, getSyncedTime, seekToTelemetryTime, avSyncOffset, onViewRangeChange } from './state'
import { isCompareMode, videoA as cmpVideoA, videoB as cmpVideoB, syncDataA, syncDataB, lapA, lapB, trackPosition } from './compare-state'
import { trackPositionToTime, timeToTrackPosition } from './compare-sync'

let isScrubbing = false

export function getIsScrubbing(): boolean {
  return isScrubbing
}

export interface Controls {
  updateScrubBar: (t: number) => void
  updateTimeDisplay: (t: number) => void
  updateCompareScrubBar: (trackPos: number) => void
  updateCompareTimeDisplay: (telTimeA: number, telTimeB: number) => void
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
    const d = getViewDuration()
    if (d > 0) {
      const telTime = t + avSyncOffset
      const pct = Math.max(0, Math.min(100, ((telTime - viewRange.startTime) / d) * 100))
      scrubProgress.style.width = `${pct}%`
      scrubThumb.style.left = `${pct}%`
    }
  }

  function updateTimeDisplay(t: number): void {
    const telTime = t + avSyncOffset
    const lapRelative = Math.max(0, telTime - viewRange.startTime)
    timeCurrent.textContent = formatTime(lapRelative)
  }


  // ── Compare mode: scrub bar + time display ──
  function updateCompareScrubBar(trackPos: number): void {
    const pct = Math.max(0, Math.min(100, trackPos * 100))
    scrubProgress.style.width = `${pct}%`
    scrubThumb.style.left = `${pct}%`
  }

  function updateCompareTimeDisplay(telTimeA: number, telTimeB: number): void {
    const lapRelA = lapA ? Math.max(0, telTimeA - lapA.startTime) : 0
    const lapRelB = lapB ? Math.max(0, telTimeB - lapB.startTime) : 0
    timeCurrent.innerHTML =
      `<span class="compare-time compare-time-a">A ${formatTime(lapRelA)}</span>` +
      ` <span class="compare-time compare-time-b">B ${formatTime(lapRelB)}</span>`
  }

  // ── Compare mode: seek by track position ──
  function compareSeekToTrackPos(pos: number): void {
    pos = Math.max(0, Math.min(1, pos))
    if (!syncDataA) return
    const telTime = trackPositionToTime(syncDataA, pos)
    seekToTelemetryTime(telTime)
  }

  // ── Scrub bar interaction ──
  function scrubToPosition(e: PointerEvent): void {
    const rect = scrubContainer.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    if (isCompareMode()) {
      compareSeekToTrackPos(pct)
    } else {
      seekToTelemetryTime(viewFractionToTime(pct))
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
    const v = isCompareMode() ? (cmpVideoA ?? video) : video
    if (v.paused) {
      if (isCompareMode()) {
        // Wrap to start of lap if at end
        if (trackPosition >= 0.999) {
          compareSeekToTrackPos(0)
        }
      } else {
        if (getSyncedTime() >= viewRange.endTime - 0.05) {
          seekToTelemetryTime(viewRange.startTime)
        }
      }
      v.play()
      if (isCompareMode() && cmpVideoB) {
        cmpVideoB.muted = true
        cmpVideoB.play()
      }
      btnPlay.innerHTML = '&#9646;&#9646;'
    } else {
      v.pause()
      if (isCompareMode() && cmpVideoB) {
        cmpVideoB.pause()
      }
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
      if (isCompareMode()) {
        compareSeekToTrackPos(trackPosition + 0.05)
      } else {
        seekToTelemetryTime(Math.min(viewRange.endTime, getSyncedTime() + 5))
      }
    } else if (e.code === 'ArrowLeft') {
      if (isCompareMode()) {
        compareSeekToTrackPos(trackPosition - 0.05)
      } else {
        seekToTelemetryTime(Math.max(viewRange.startTime, getSyncedTime() - 5))
      }
    } else if (e.code === 'Period' && (isCompareMode() ? (cmpVideoA ?? video).paused : video.paused)) {
      if (isCompareMode()) {
        compareSeekToTrackPos(trackPosition + 0.001)
      } else {
        seekToTelemetryTime(Math.min(viewRange.endTime, getSyncedTime() + 1 / 30))
      }
    } else if (e.code === 'Comma' && (isCompareMode() ? (cmpVideoA ?? video).paused : video.paused)) {
      if (isCompareMode()) {
        compareSeekToTrackPos(trackPosition - 0.001)
      } else {
        seekToTelemetryTime(Math.max(viewRange.startTime, getSyncedTime() - 1 / 30))
      }
    } else if (e.code === 'F2') {
      e.preventDefault()
      toggleDebugPanel()
    } else if (e.code === 'KeyC') {
      // Toggle chart panel visibility via button click to keep state in sync
      document.querySelector<HTMLButtonElement>('.panel-toggle[data-panel="charts"]')?.click()
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

  // ── View range changes ──
  onViewRangeChange(() => {
    if (!isCompareMode()) {
      timeTotal.textContent = formatTime(getViewDuration())
    }
  })

  return { updateScrubBar, updateTimeDisplay, updateCompareScrubBar, updateCompareTimeDisplay }
}
