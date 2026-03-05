/**
 * OpenPDR Viewer — Lap Times Table
 *
 * Renders a list of detected laps with times.
 * Highlights the current lap as the video plays.
 * Click a lap to select it as the view range and seek to its start.
 *
 * Compare mode:
 *   Two sections (A / B) each listing laps from their respective file.
 *   Click a lap in section A → setCompareLapA(idx), seek videoA to that lap start.
 *   Click a lap in section B → setCompareLapB(idx), seek videoB to that lap start.
 *   Comparison summary at the bottom: lap time A vs B + delta.
 */

import { lapData, currentRow, duration, seekToTelemetryTime, getSyncedTime, setViewRange, selectedLapIdx, onViewRangeChange } from './state'
import { onTelemetryLoad, onFrameTick } from './state'
import type { LapInfo } from './types'
import {
  isCompareMode,
  lapA, lapB,
  lapDataA, lapDataB,
  fileNameA, fileNameB,
  setCompareLapA, setCompareLapB,
  videoA, videoB,
  onCompareEnter,
  onCompareExit,
  onCompareLapChange,
} from './compare-state'
import { avSyncOffset } from './state'

let container: HTMLElement
let lapRows: HTMLElement[] = []
let fullRecordingRow: HTMLElement | null = null
let laps: LapInfo[] = []
let currentLapIdx = -1

import { formatLapTime } from './defaults'

// ── Single-file mode ──

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

// ── Compare mode ──

/** Rows for the A and B sections, keyed by lap index in their respective lapData. */
let compareRowsA: HTMLElement[] = []
let compareRowsB: HTMLElement[] = []
let compareSummaryEl: HTMLElement | null = null

function buildCompareTable(): void {
  container.innerHTML = ''
  compareRowsA = []
  compareRowsB = []
  compareSummaryEl = null

  const ldA = lapDataA
  const ldB = lapDataB
  if (!ldA || !ldB) return

  // ── Section A ──
  const headingA = document.createElement('div')
  headingA.className = 'lap-heading lap-heading-a'
  headingA.textContent = `A: ${fileNameA}`
  container.appendChild(headingA)

  const bestTimeA = Math.min(...ldA.laps.map(l => l.lapTime))
  for (let i = 0; i < ldA.laps.length; i++) {
    const lap = ldA.laps[i]
    const row = buildCompareLapRow(lap, bestTimeA, 'a')
    row.addEventListener('click', () => {
      setCompareLapA(i)
      // Seek video A to this lap's start
      const va = videoA
      if (va) va.currentTime = lap.startTime - avSyncOffset
    })
    container.appendChild(row)
    compareRowsA.push(row)
  }

  // ── Section B ──
  const headingB = document.createElement('div')
  headingB.className = 'lap-heading lap-heading-b'
  headingB.textContent = `B: ${fileNameB}`
  container.appendChild(headingB)

  const bestTimeB = Math.min(...ldB.laps.map(l => l.lapTime))
  for (let i = 0; i < ldB.laps.length; i++) {
    const lap = ldB.laps[i]
    const row = buildCompareLapRow(lap, bestTimeB, 'b')
    row.addEventListener('click', () => {
      setCompareLapB(i)
      const vb = videoB
      if (vb) vb.currentTime = lap.startTime - avSyncOffset
    })
    container.appendChild(row)
    compareRowsB.push(row)
  }

  // ── Summary ──
  compareSummaryEl = document.createElement('div')
  compareSummaryEl.className = 'lap-compare-summary'
  container.appendChild(compareSummaryEl)

  updateCompareHighlights()
  updateCompareSummary()
}

function buildCompareLapRow(lap: LapInfo, bestTime: number, side: 'a' | 'b'): HTMLElement {
  const row = document.createElement('div')
  row.className = 'lap-row'

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

  // Side indicator dot
  const dot = document.createElement('span')
  dot.className = `lap-side-dot lap-side-dot-${side}`
  row.prepend(dot)

  return row
}

function updateCompareHighlights(): void {
  const currentLapA = lapA
  const currentLapB = lapB
  const ldA = lapDataA
  const ldB = lapDataB

  for (let i = 0; i < compareRowsA.length; i++) {
    const isSelected = ldA ? ldA.laps[i] === currentLapA : false
    compareRowsA[i].classList.toggle('selected', isSelected)
    compareRowsA[i].classList.toggle('compare-selected-a', isSelected)
  }
  for (let i = 0; i < compareRowsB.length; i++) {
    const isSelected = ldB ? ldB.laps[i] === currentLapB : false
    compareRowsB[i].classList.toggle('selected', isSelected)
    compareRowsB[i].classList.toggle('compare-selected-b', isSelected)
  }
}

function updateCompareSummary(): void {
  const el = compareSummaryEl
  if (!el) return

  const la = lapA
  const lb = lapB
  if (!la || !lb) {
    el.innerHTML = ''
    return
  }

  const tA = la.lapTime
  const tB = lb.lapTime
  const delta = tA - tB

  el.innerHTML = ''

  const rowA = document.createElement('div')
  rowA.className = 'lap-summary-row'
  rowA.innerHTML = `<span class="lap-summary-label summary-label-a">A</span><span class="lap-summary-time">${formatLapTime(tA)}</span>`

  const rowB = document.createElement('div')
  rowB.className = 'lap-summary-row'
  rowB.innerHTML = `<span class="lap-summary-label summary-label-b">B</span><span class="lap-summary-time">${formatLapTime(tB)}</span>`

  const rowDelta = document.createElement('div')
  rowDelta.className = 'lap-summary-row lap-summary-delta'
  const sign = delta < 0 ? '' : '+'
  const deltaColor = delta < 0 ? '#3cdc3c' : delta > 0 ? '#ff6060' : '#fff'
  const winner = delta < 0 ? 'A faster' : delta > 0 ? 'B faster' : 'Equal'
  rowDelta.innerHTML = `<span class="lap-summary-label" style="color:${deltaColor}">\u0394</span><span class="lap-summary-time" style="color:${deltaColor}">${sign}${delta.toFixed(3)}s (${winner})</span>`

  el.appendChild(rowA)
  el.appendChild(rowB)
  el.appendChild(rowDelta)
}

// ── Public API ──

export function initLapTable(el: HTMLElement): void {
  container = el

  const msg = document.createElement('div')
  msg.className = 'lap-empty'
  msg.textContent = 'Open a file to view laps'
  container.appendChild(msg)

  onTelemetryLoad(() => {
    if (!isCompareMode()) buildTable()
  })
  onFrameTick(() => {
    if (!isCompareMode()) updateHighlight()
  })
  onViewRangeChange(() => {
    if (!isCompareMode()) updateSelection()
  })

  onCompareEnter(() => buildCompareTable())
  onCompareExit(() => {
    // Restore single-file table
    buildTable()
  })
  onCompareLapChange(() => {
    updateCompareHighlights()
    updateCompareSummary()
  })
}
