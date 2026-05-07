/**
 * OpenPDR Viewer — RPM horizontal bar overlay (SVG)
 *
 * Horizontal bar from 0 to maxRpm with green/red zones matching the RPM gauge.
 * Labels at 1000 RPM intervals with drop shadows, minor ticks at 500 RPM.
 * Uses the same RpmConfig (redline, maxRpm) as the arc gauge.
 *
 * Supports detached (non-DOM) instances for the video export renderer:
 *   const svg = createSvgEl('svg')
 *   buildBar(svg, cfg)
 *   drawRpmBar(rpm, svg, cfg)
 */

import type { RpmConfig } from './types'
import { getRpmConfig } from './rpm-gauge'

// ── SVG geometry ──
const W = 400, H = 36
const BAR_X = 0, BAR_Y = 4, BAR_W = W, BAR_H = 20
const NS = 'http://www.w3.org/2000/svg'

let primarySvg: SVGSVGElement | null = null
// Unique filter ID per build so multiple bars (compare A/B) don't share IDs
// — sharing causes the B-side text to disappear when A's container is hidden,
// because both text elements reference the same filter and one of them is
// inside a `display:none` ancestor.
let filterIdCounter = 0

interface BarElements {
  svg: SVGSVGElement
  activeGreen: SVGRectElement
  activeRed: SVGRectElement
  cfgKey: string
  lastDrawnRpm: number
}

const barMap = new WeakMap<SVGSVGElement, BarElements>()

function createSvgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
}

function setAttrs(el: SVGElement, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v))
  }
}

function cfgKeyStr(cfg: RpmConfig): string {
  return `${cfg.redline}:${cfg.maxRpm}`
}

export function buildBar(svg: SVGSVGElement, cfg: RpmConfig): BarElements {
  svg.innerHTML = ''
  setAttrs(svg, { viewBox: `0 0 ${W} ${H}`, width: W, height: H })
  svg.style.overflow = 'visible'

  const { redline, maxRpm } = cfg
  const redlinePct = redline / maxRpm
  const greenW = BAR_W * redlinePct
  const redW = BAR_W - greenW

  // Drop shadow filter for labels — unique ID per bar (see filterIdCounter above)
  const filterId = `rpm-bar-shadow-${++filterIdCounter}`
  const defs = createSvgEl('defs')
  const filter = createSvgEl('filter')
  setAttrs(filter, { id: filterId, x: '-20%', y: '-20%', width: '140%', height: '140%' })
  const feShadow = createSvgEl('feDropShadow')
  setAttrs(feShadow, { dx: 0, dy: 1, stdDeviation: 1.5, 'flood-color': 'rgba(0,0,0,0.8)' })
  filter.appendChild(feShadow)
  defs.appendChild(filter)
  svg.appendChild(defs)

  // Background green zone (lighter)
  const bgGreen = createSvgEl('rect')
  setAttrs(bgGreen, {
    x: BAR_X, y: BAR_Y, width: greenW, height: BAR_H,
    fill: '#00cc66', opacity: '0.2', rx: 2,
  })
  svg.appendChild(bgGreen)

  // Background red zone (lighter)
  const bgRed = createSvgEl('rect')
  setAttrs(bgRed, {
    x: BAR_X + greenW, y: BAR_Y, width: redW, height: BAR_H,
    fill: '#ff3333', opacity: '0.25', rx: 2,
  })
  svg.appendChild(bgRed)

  // Active green fill (updated per frame)
  const activeGreen = createSvgEl('rect')
  setAttrs(activeGreen, {
    x: BAR_X, y: BAR_Y, width: 0, height: BAR_H,
    fill: '#00cc66', rx: 2,
  })
  svg.appendChild(activeGreen)

  // Active red fill (updated per frame, only when past redline)
  const activeRed = createSvgEl('rect')
  setAttrs(activeRed, {
    x: BAR_X + greenW, y: BAR_Y, width: 0, height: BAR_H,
    fill: '#ff3333', rx: 2,
  })
  svg.appendChild(activeRed)

  // Tick marks + labels — drawn on top of fills
  const tickGroup = createSvgEl('g')

  for (let r = 0; r <= maxRpm; r += 500) {
    const xPos = BAR_X + (r / maxRpm) * BAR_W
    const isMajor = r % 1000 === 0

    if (r > 0) {
      // Tick line
      const tick = createSvgEl('line')
      const tickH = isMajor ? BAR_H : BAR_H * 0.5
      const tickY = BAR_Y + (BAR_H - tickH) / 2
      setAttrs(tick, {
        x1: xPos, y1: tickY, x2: xPos, y2: tickY + tickH,
        stroke: 'rgba(0,0,0,0.4)', 'stroke-width': isMajor ? 1.5 : 1,
      })
      tickGroup.appendChild(tick)
    }

    // Numeric label at 1000 RPM intervals (skip 0)
    if (isMajor && r > 0) {
      const label = createSvgEl('text')
      setAttrs(label, {
        x: xPos, y: BAR_Y + BAR_H / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: 'rgba(255,255,255,0.85)', 'font-family': 'Consolas, monospace',
        'font-size': '12', 'font-weight': 'bold',
        filter: `url(#${filterId})`,
      })
      label.textContent = (r / 1000).toString()
      tickGroup.appendChild(label)
    }
  }
  svg.appendChild(tickGroup)

  const entry: BarElements = {
    svg, activeGreen, activeRed,
    cfgKey: cfgKeyStr(cfg),
    lastDrawnRpm: -1,
  }
  barMap.set(svg, entry)
  return entry
}

function ensureBar(svg: SVGSVGElement, cfg: RpmConfig): BarElements {
  const existing = barMap.get(svg)
  const key = cfgKeyStr(cfg)
  if (existing && existing.cfgKey === key) return existing
  return buildBar(svg, cfg)
}

// ── Init ──

export function initRpmBar(): void {
  const container = document.getElementById('hud-rpm-bar')
  if (!container) return

  let svg = container.querySelector('svg') as SVGSVGElement | null
  if (!svg) {
    svg = createSvgEl('svg')
    container.appendChild(svg)
  }
  primarySvg = svg

  const cfg = getRpmConfig()
  buildBar(svg, cfg)
}

// ── Draw (called every frame) ──

export function drawRpmBar(rpm: number, targetSvg?: SVGSVGElement, overrideCfg?: RpmConfig): void {
  const svg = targetSvg ?? primarySvg
  if (!svg) return
  const cfg = overrideCfg ?? getRpmConfig()
  const b = ensureBar(svg, cfg)

  const rounded = Math.round(rpm)
  if (rounded === b.lastDrawnRpm) return
  b.lastDrawnRpm = rounded

  const { redline, maxRpm } = cfg
  const pct = Math.min(1, Math.max(0, rpm / maxRpm))
  const redlinePct = redline / maxRpm

  // Active green: 0 → min(rpm, redline)
  const greenFillPct = Math.min(pct, redlinePct)
  b.activeGreen.setAttribute('width', String(greenFillPct * BAR_W))

  // Active red: redline → rpm (only past redline)
  if (rpm > redline) {
    const redFillPct = pct - redlinePct
    b.activeRed.setAttribute('width', String(redFillPct * BAR_W))
  } else {
    b.activeRed.setAttribute('width', '0')
  }
}
