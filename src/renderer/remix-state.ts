/**
 * OpenPDR Viewer — Remix Mode: Central state
 *
 * Holds the state for remix mode: one GoPro video with PDR telemetry overlaid.
 * The key insight is that remix reuses the existing single-video pipeline —
 * we just swap the telemetry store and set avSyncOffset to align them.
 */

import type { TelemetryStore } from '../shared/telemetry-store'
import type { SessionInfo } from './types'
import { createBus } from './event-bus'

// ── Remix mode flag ──
let remixMode = false
export function isRemixMode(): boolean { return remixMode }

// ── GoPro's GPS store (for secondary track map trace) ──
let goProStore: TelemetryStore | null = null
export function getGoProStore(): TelemetryStore | null { return goProStore }

// ── File paths ──
let goProFilePath = ''
let pdrFilePath = ''
let goProFileName = ''
let pdrFileName = ''

export function getGoProFilePath(): string { return goProFilePath }
export function getPdrFilePath(): string { return pdrFilePath }
export function getGoProFileName(): string { return goProFileName }
export function getPdrFileName(): string { return pdrFileName }

// ── Sync offset ──
// remixBaseOffset: auto-computed from cross-correlation
// remixUserOffset: user fine-tune adjustment
// Total offset applied to avSyncOffset = baseOffset + userOffset
let remixBaseOffset = 0
let remixUserOffset = 0
let remixConfidence = 0

export function getRemixOffset(): number { return remixBaseOffset + remixUserOffset }
export function getRemixBaseOffset(): number { return remixBaseOffset }
export function getRemixUserOffset(): number { return remixUserOffset }
export function getRemixConfidence(): number { return remixConfidence }

export function setRemixUserOffset(delta: number): void {
  remixUserOffset = delta
  remixSyncChangeBus.fire()
}

// ── GoPro session info (camera name, timestamp) ──
let goProSessionInfo: SessionInfo | null = null
export function getGoProSessionInfo(): SessionInfo | null { return goProSessionInfo }

// ── Event buses ──
const remixEnterBus = createBus()
const remixExitBus = createBus()
const remixSyncChangeBus = createBus()

export function onRemixEnter(fn: () => void) { return remixEnterBus.on(fn) }
export function onRemixExit(fn: () => void) { return remixExitBus.on(fn) }
export function onRemixSyncChange(fn: () => void) { return remixSyncChangeBus.on(fn) }

// ── Config for entering remix mode ──
export interface RemixConfig {
  goProStore: TelemetryStore
  pdrStore: TelemetryStore
  goProFilePath: string
  pdrFilePath: string
  goProFileName: string
  pdrFileName: string
  baseOffset: number
  confidence: number
  goProSessionInfo: SessionInfo | null
  pdrSessionInfo: SessionInfo | null
}

export function enterRemixMode(config: RemixConfig): void {
  remixMode = true
  goProStore = config.goProStore
  goProFilePath = config.goProFilePath
  pdrFilePath = config.pdrFilePath
  goProFileName = config.goProFileName
  pdrFileName = config.pdrFileName
  remixBaseOffset = config.baseOffset
  remixUserOffset = 0
  remixConfidence = config.confidence
  goProSessionInfo = config.goProSessionInfo

  remixEnterBus.fire()
}

export function exitRemixMode(): void {
  remixMode = false
  goProStore = null
  goProFilePath = ''
  pdrFilePath = ''
  goProFileName = ''
  pdrFileName = ''
  remixBaseOffset = 0
  remixUserOffset = 0
  remixConfidence = 0
  goProSessionInfo = null

  remixExitBus.fire()
}
