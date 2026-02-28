/**
 * OpenPDR Viewer — Lap Times Table
 *
 * Renders a list of detected laps with times.
 * Highlights the current lap as the video plays.
 * Click a lap to seek the video to its start.
 */

import { lapData, currentRow, video } from './state'
import { onTelemetryLoad, onFrameTick } from './state'
import type { LapInfo } from './types'

let container: HTMLElement
let lapRows: HTMLElement[] = []
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

  const heading = document.createElement('div')
  heading.className = 'lap-heading'
  heading.textContent = `${laps.length} lap${laps.length !== 1 ? 's' : ''}`
  container.appendChild(heading)

  for (const lap of laps) {
    const row = document.createElement('div')
    row.className = 'lap-row'
    row.dataset.lapIdx = String(lap.lapNumber - 1)

    const numEl = document.createElement('span')
    numEl.className = 'lap-num'
    numEl.textContent = `Lap ${lap.lapNumber}`

    const timeEl = document.createElement('span')
    timeEl.className = 'lap-time'
    timeEl.textContent = formatLapTime(lap.lapTime)

    row.appendChild(numEl)
    row.appendChild(timeEl)

    row.addEventListener('click', () => {
      video.currentTime = lap.startTime
    })

    container.appendChild(row)
    lapRows.push(row)
  }
}

function updateHighlight(): void {
  if (laps.length === 0 || !currentRow) return

  const t = currentRow.time
  let idx = -1
  for (let i = 0; i < laps.length; i++) {
    if (t >= laps[i].startTime && t < laps[i].endTime) {
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

export function initLapTable(el: HTMLElement): void {
  container = el

  const msg = document.createElement('div')
  msg.className = 'lap-empty'
  msg.textContent = 'Open a file to view laps'
  container.appendChild(msg)

  onTelemetryLoad(() => buildTable())
  onFrameTick(() => updateHighlight())
}
