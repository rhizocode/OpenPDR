/**
 * OpenPDR Viewer — Lap Times Table
 *
 * Renders a list of detected laps with times.
 * Highlights the current lap as the video plays.
 * Click a lap to select it as the view range and seek to its start.
 */

import { lapData, currentRow, duration, seekToTelemetryTime, getSyncedTime, setViewRange, selectedLapIdx, onViewRangeChange } from './state'
import { onTelemetryLoad, onFrameTick } from './state'
import type { LapInfo } from './types'

let container: HTMLElement
let lapRows: HTMLElement[] = []
let fullRecordingRow: HTMLElement | null = null
let laps: LapInfo[] = []
let currentLapIdx = -1

/** Format seconds as M:SS.mmm */
function formatLapTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const sFmt = s < 10 ? '0' + s.toFixed(3) : s.toFixed(3)
  return `${m}:${sFmt}`
}

function buildTable(): void {
  container.innerHTML = ''
  lapRows = []
  fullRecordingRow = null
  currentLapIdx = -1

  const ld = lapData
  if (!ld?.hasLapData || ld.laps.length === 0) {
    const msg = document.createElement('div')
    msg.className = 'lap-empty'
    msg.textContent = 'No laps detected'
    container.appendChild(msg)
    return
  }

  laps = ld.laps

  const bestTime = Math.min(...laps.map(l => l.lapTime))

  const heading = document.createElement('div')
  heading.className = 'lap-heading'
  heading.textContent = `${laps.length} lap${laps.length !== 1 ? 's' : ''}`
  container.appendChild(heading)

  // "Full Recording" row
  fullRecordingRow = document.createElement('div')
  fullRecordingRow.className = 'lap-row selected'
  const fullLabel = document.createElement('span')
  fullLabel.className = 'lap-num'
  fullLabel.textContent = 'Full Recording'
  fullRecordingRow.appendChild(fullLabel)
  fullRecordingRow.addEventListener('click', () => {
    setViewRange({ startTime: 0, endTime: duration }, null)
  })
  container.appendChild(fullRecordingRow)

  for (const lap of laps) {
    const row = document.createElement('div')
    row.className = 'lap-row'
    row.dataset.lapIdx = String(lap.lapNumber - 1)

    const numEl = document.createElement('span')
    numEl.className = 'lap-num'
    numEl.textContent = `Lap ${lap.lapNumber}`

    const rightEl = document.createElement('span')
    rightEl.className = 'lap-right'

    const timeEl = document.createElement('span')
    timeEl.className = 'lap-time'
    timeEl.textContent = formatLapTime(lap.lapTime)

    const deltaEl = document.createElement('span')
    deltaEl.className = 'lap-delta'
    if (lap.lapTime === bestTime) {
      deltaEl.textContent = 'best'
      deltaEl.classList.add('lap-delta-best')
    } else {
      const delta = lap.lapTime - bestTime
      deltaEl.textContent = `+${delta.toFixed(3)}`
    }

    rightEl.appendChild(timeEl)
    rightEl.appendChild(deltaEl)
    row.appendChild(numEl)
    row.appendChild(rightEl)

    row.addEventListener('click', () => {
      const idx = lap.lapNumber - 1
      setViewRange({ startTime: lap.startTime, endTime: lap.endTime }, idx)
      seekToTelemetryTime(lap.startTime)
    })

    container.appendChild(row)
    lapRows.push(row)
  }
}

function updateHighlight(): void {
  if (laps.length === 0 || !currentRow) return

  // Use the actual synced telemetry time (not the snapped row time) so that
  // video frame-snap rounding doesn't push us across a lap boundary.
  const t = getSyncedTime()
  let idx = -1
  for (let i = 0; i < laps.length; i++) {
    if (t >= laps[i].startTime - 0.05 && t < laps[i].endTime) {
      idx = i
      break
    }
  }

  if (idx === currentLapIdx) return
  currentLapIdx = idx

  for (let i = 0; i < lapRows.length; i++) {
    lapRows[i].classList.toggle('current', i === idx)
  }
}

function updateSelection(): void {
  if (fullRecordingRow) {
    fullRecordingRow.classList.toggle('selected', selectedLapIdx === null)
  }
  for (let i = 0; i < lapRows.length; i++) {
    lapRows[i].classList.toggle('selected', i === selectedLapIdx)
  }
}

export function initLapTable(el: HTMLElement): void {
  container = el

  const msg = document.createElement('div')
  msg.className = 'lap-empty'
  msg.textContent = 'Open a file to view laps'
  container.appendChild(msg)

  onTelemetryLoad(() => buildTable())
  onFrameTick(() => updateHighlight())
  onViewRangeChange(() => updateSelection())
}
