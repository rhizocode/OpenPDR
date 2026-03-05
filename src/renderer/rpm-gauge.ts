/**
 * OpenPDR Viewer — RPM arc gauge (SVG)
 *
 * 270-degree arc gauge with two color zones (green / red).
 * Rendered as an inline SVG for crisp scaling at any resolution.
 * Redline is auto-detected from the engine code in PDR session metadata
 * via the engine database, with a manual override option.
 *
 * The video-export overlay renderer (overlay-renderer.ts) has its own
 * canvas-based reimplementation for offscreen rendering — it does not
 * use this module.
 */

import type { RpmConfig } from './types'
import { sessionInfo, onTelemetryLoad, dbg } from './state'
import { detectEngine, engineToRpmConfig, type EngineSpec } from '../shared/engine-database'

const STORAGE_KEY = 'pdr-rpm-config'
const OVERRIDE_KEY = 'pdr-rpm-manual-override'

import { DEFAULT_RPM_CONFIG } from './defaults'

let config: RpmConfig = DEFAULT_RPM_CONFIG

// Auto-detection state
let detectedEngine: EngineSpec | null = null
let manualOverride = localStorage.getItem(OVERRIDE_KEY) === 'true'

export function getDetectedEngine(): EngineSpec | null { return detectedEngine }
export function isManualOverride(): boolean { return manualOverride }
export function setManualOverride(on: boolean): void {
  manualOverride = on
  localStorage.setItem(OVERRIDE_KEY, on.toString())
  if (!on && detectedEngine) {
    saveRpmConfig(engineToRpmConfig(detectedEngine))
  }
}

// ── SVG geometry ──
// viewBox sized to fully contain the arc + tick marks + stroke width.
// Arc endpoints (135°/45°) sit at CY + R·sin(45°) ≈ CY + 55; tick outers even lower.
// H must accommodate those endpoints plus padding.
const W = 180, H = 165
const CX = W / 2        // 90
const CY = H - 60       // 105
const R = 78
const ARC_WIDTH = 14
const TICK_INNER = R - 7
const TICK_OUTER = R + 7

// Arc sweep: 270 degrees from 135deg (7 o'clock) to 45deg (5 o'clock)
const START_DEG = 135
const SWEEP_DEG = 270
const NS = 'http://www.w3.org/2000/svg'

// ── Primary SVG element + B-side tracking ──
let primarySvg: SVGSVGElement | null = null
// Track all managed SVG instances for config-change rebuilds
const managedSvgs = new Set<SVGSVGElement>()

// ── Helpers: polar → cartesian, SVG arc path ──

function polarToXY(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

/** Build an SVG arc path `d` attribute from startDeg to endDeg on circle (cx, cy, r). */
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const [sx, sy] = polarToXY(cx, cy, r, startDeg)
  const [ex, ey] = polarToXY(cx, cy, r, endDeg)
  const sweep = endDeg - startDeg
  const largeArc = sweep > 180 ? 1 : 0
  return `M${sx},${sy} A${r},${r} 0 ${largeArc} 1 ${ex},${ey}`
}

function createSvgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

function setAttrs(el: SVGElement, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v))
  }
}

// ── Build the static SVG structure ──

interface GaugeElements {
  svg: SVGSVGElement
  bgArc: SVGPathElement
  greenZone: SVGPathElement
  redZone: SVGPathElement
  tickGroup: SVGGElement
  activeGreen: SVGPathElement
  activeRed: SVGPathElement
  rpmText: SVGTextElement
  rpmLabel: SVGTextElement
  cfgKey: string // for cache invalidation
  lastDrawnRpm: number // skip redundant DOM updates when value unchanged
}

const gaugeMap = new WeakMap<SVGSVGElement, GaugeElements>()

function rpmToDeg(rpm: number, maxRpm: number): number {
  return START_DEG + (rpm / maxRpm) * SWEEP_DEG
}

function buildGauge(svg: SVGSVGElement, cfg: RpmConfig): GaugeElements {
  // Clear any existing content
  svg.innerHTML = ''
  setAttrs(svg, { viewBox: `0 0 ${W} ${H}`, width: W, height: H })
  svg.style.overflow = 'visible'

  const { maxRpm } = cfg

  // Background arc (dim white)
  const bgArc = createSvgEl('path')
  setAttrs(bgArc, {
    d: arcPath(CX, CY, R, START_DEG, START_DEG + SWEEP_DEG),
    fill: 'none', stroke: 'rgba(255,255,255,0.08)',
    'stroke-width': ARC_WIDTH, 'stroke-linecap': 'butt',
  })
  svg.appendChild(bgArc)

  // Green background zone (first 90% of arc, faded)
  const greenZone = createSvgEl('path')
  const redZoneStart = 0.9 // last 10% of arc is red zone
  const greenEndDeg = START_DEG + redZoneStart * SWEEP_DEG
  setAttrs(greenZone, {
    d: arcPath(CX, CY, R, START_DEG, greenEndDeg),
    fill: 'none', stroke: '#00cc66', opacity: '0.2',
    'stroke-width': ARC_WIDTH, 'stroke-linecap': 'butt',
  })
  svg.appendChild(greenZone)

  // Red background zone (last 10% of arc, more prominent)
  const redZone = createSvgEl('path')
  setAttrs(redZone, {
    d: arcPath(CX, CY, R, greenEndDeg, START_DEG + SWEEP_DEG),
    fill: 'none', stroke: '#ff3333', opacity: '0.45',
    'stroke-width': ARC_WIDTH, 'stroke-linecap': 'butt',
  })
  svg.appendChild(redZone)

  // Active green arc (updated per frame)
  const activeGreen = createSvgEl('path')
  setAttrs(activeGreen, {
    d: '', fill: 'none', stroke: '#00cc66',
    'stroke-width': ARC_WIDTH, 'stroke-linecap': 'butt',
  })
  svg.appendChild(activeGreen)

  // Active red arc (updated per frame, hidden when below redline)
  const activeRed = createSvgEl('path')
  setAttrs(activeRed, {
    d: '', fill: 'none', stroke: '#ff3333',
    'stroke-width': ARC_WIDTH, 'stroke-linecap': 'butt',
  })
  svg.appendChild(activeRed)

  // Tick marks at 1000 RPM intervals — drawn AFTER active arcs so they stay visible
  const tickGroup = createSvgEl('g')
  setAttrs(tickGroup, { stroke: 'rgba(0,0,0,0.6)', 'stroke-width': '2', 'stroke-linecap': 'round' })
  for (let r = 0; r <= maxRpm; r += 1000) {
    const deg = rpmToDeg(r, maxRpm)
    const [ix, iy] = polarToXY(CX, CY, TICK_INNER, deg)
    const [ox, oy] = polarToXY(CX, CY, TICK_OUTER, deg)
    const tick = createSvgEl('line')
    setAttrs(tick, { x1: ix, y1: iy, x2: ox, y2: oy })
    tickGroup.appendChild(tick)
  }
  svg.appendChild(tickGroup)

  // Drop shadow filter for text
  const defs = createSvgEl('defs')
  const filter = createSvgEl('filter')
  setAttrs(filter, { id: 'rpm-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' })
  const feDropShadow = createSvgEl('feDropShadow')
  setAttrs(feDropShadow, { dx: 0, dy: 1, stdDeviation: 2, 'flood-color': 'rgba(0,0,0,0.7)' })
  filter.appendChild(feDropShadow)
  defs.appendChild(filter)
  svg.appendChild(defs)

  // RPM numeric readout — centered in the arc interior
  // Arc top ≈ CY-R = 27, arc endpoints ≈ CY + R·sin(45°) = 160
  // Visual center of the interior ≈ midpoint = ~93
  const rpmText = createSvgEl('text')
  setAttrs(rpmText, {
    x: CX, y: CY - 10,
    'text-anchor': 'middle', 'dominant-baseline': 'central',
    fill: '#fff', 'font-family': 'Consolas, monospace',
    'font-size': '42', 'font-weight': 'bold',
    filter: 'url(#rpm-shadow)',
  })
  rpmText.textContent = '0'
  svg.appendChild(rpmText)

  // "RPM" label
  const rpmLabel = createSvgEl('text')
  setAttrs(rpmLabel, {
    x: CX, y: CY + 14,
    'text-anchor': 'middle', 'dominant-baseline': 'central',
    fill: '#aaa', 'font-family': 'Consolas, monospace',
    'font-size': '16',
    filter: 'url(#rpm-shadow)',
  })
  rpmLabel.textContent = 'RPM'
  svg.appendChild(rpmLabel)

  const entry: GaugeElements = {
    svg, bgArc, greenZone, redZone, tickGroup,
    activeGreen, activeRed, rpmText, rpmLabel,
    cfgKey: cfgKeyStr(cfg),
    lastDrawnRpm: -1,
  }
  gaugeMap.set(svg, entry)
  return entry
}

function cfgKeyStr(cfg: RpmConfig): string {
  return `${cfg.redline}:${cfg.maxRpm}`
}

/** Ensure the SVG has been built (or rebuilt if config changed). */
function ensureGauge(svg: SVGSVGElement, cfg: RpmConfig): GaugeElements {
  const existing = gaugeMap.get(svg)
  const key = cfgKeyStr(cfg)
  if (existing && existing.cfgKey === key) return existing
  return buildGauge(svg, cfg)
}

// ── Config persistence ──

export function loadRpmConfig(): RpmConfig {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      config = { ...DEFAULT_RPM_CONFIG, ...JSON.parse(saved) }
    } catch {
      config = { ...DEFAULT_RPM_CONFIG }
    }
  } else {
    config = { ...DEFAULT_RPM_CONFIG }
  }
  return config
}

export function saveRpmConfig(newConfig: RpmConfig): void {
  config = { ...newConfig }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  // Invalidate all managed SVG gauges so they rebuild on next draw
  for (const svg of managedSvgs) {
    const entry = gaugeMap.get(svg)
    if (entry) entry.cfgKey = ''
  }
}

export function getRpmConfig(): RpmConfig {
  return config
}

function autoDetectRpm(): void {
  detectedEngine = detectEngine(sessionInfo?.engine)
  if (detectedEngine) {
    if (!manualOverride) {
      saveRpmConfig(engineToRpmConfig(detectedEngine))
    } else {
      dbg('Redline: manual override active, using saved config')
    }
  } else {
    dbg(`Redline: unknown engine "${sessionInfo?.engine ?? ''}", using manual config`)
  }
  dbg(`Redline: ${detectedEngine?.label ?? 'manual'} — ${config.redline}/${config.maxRpm} RPM`)
}

// ── Init ──

export function initRpmGauge(): void {
  const container = document.getElementById('hud-rpm-gauge')
  if (!container) return

  // Create the primary SVG element, replacing the old canvas
  let svg = container.querySelector('svg') as SVGSVGElement | null
  if (!svg) {
    svg = createSvgEl('svg')
    // Remove old canvas if present
    const oldCanvas = container.querySelector('canvas')
    if (oldCanvas) oldCanvas.remove()
    container.appendChild(svg)
  }
  primarySvg = svg
  managedSvgs.add(svg)

  loadRpmConfig()
  buildGauge(svg, config)
  onTelemetryLoad(() => autoDetectRpm())
}

// ── Draw (called every frame) ──

export function drawRpmGauge(rpm: number, targetSvg?: SVGSVGElement, overrideConfig?: RpmConfig): void {
  const svg = targetSvg ?? primarySvg
  if (!svg) return
  const cfg = overrideConfig ?? config
  const g = ensureGauge(svg, cfg)

  // Skip redundant DOM updates when the displayed integer RPM hasn't changed
  const rounded = Math.round(rpm)
  if (rounded === g.lastDrawnRpm) return
  g.lastDrawnRpm = rounded

  const { redline, maxRpm } = cfg
  const pct = Math.min(1, Math.max(0, rpm / maxRpm))
  const redlinePct = redline / maxRpm

  // Active green arc: 0 → min(rpm, redline)
  if (pct > 0) {
    const greenEnd = Math.min(pct, redlinePct)
    const endDeg = START_DEG + greenEnd * SWEEP_DEG
    g.activeGreen.setAttribute('d', arcPath(CX, CY, R, START_DEG, endDeg))
  } else {
    g.activeGreen.setAttribute('d', '')
  }

  // Active red arc: redline → rpm (only when past redline)
  if (rpm > redline) {
    const redStartDeg = START_DEG + redlinePct * SWEEP_DEG
    const redEndDeg = START_DEG + pct * SWEEP_DEG
    g.activeRed.setAttribute('d', arcPath(CX, CY, R, redStartDeg, redEndDeg))
  } else {
    g.activeRed.setAttribute('d', '')
  }

  // Numeric readout
  g.rpmText.textContent = Math.round(rpm).toString()
}
