/**
 * OpenPDR Viewer — G-force ball (SVG)
 *
 * Renders a circular g-force plot with lateral (X) and longitudinal (Y)
 * acceleration. Grid circles at 0.5G and 1.0G increments.
 * SVG-based: resolution-independent, scales perfectly with CSS transforms.
 */

const NS = 'http://www.w3.org/2000/svg'
const MAX_G = 1.5
const CX = 60        // viewBox center
const CY = 60
const RADIUS = 52    // CX - 8px padding

let dot: SVGCircleElement | null = null

export function initGForceBall(): void {
  const svg = document.getElementById('gforce-svg')
  if (!svg) return
  dot = svg.querySelector('.gforce-dot') as SVGCircleElement
}

/** Create a detached (non-DOM) g-force SVG for offscreen rendering. */
export function createGForceSvg(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 120 120')
  svg.setAttribute('xmlns', NS)

  // Background circle
  const bg = document.createElementNS(NS, 'circle')
  bg.setAttribute('cx', '60')
  bg.setAttribute('cy', '60')
  bg.setAttribute('r', '52')
  bg.setAttribute('fill', 'rgba(0,0,0,0.4)')
  svg.appendChild(bg)

  // Grid circles at 0.5G and 1.0G
  for (const g of [0.5, 1.0]) {
    const r = (g / MAX_G) * RADIUS
    const circle = document.createElementNS(NS, 'circle')
    circle.setAttribute('cx', '60')
    circle.setAttribute('cy', '60')
    circle.setAttribute('r', r.toFixed(2))
    circle.setAttribute('fill', 'none')
    circle.setAttribute('stroke', 'rgba(255,255,255,0.15)')
    circle.setAttribute('stroke-width', '1')
    svg.appendChild(circle)
  }

  // Crosshair lines
  const lines: [number, number, number, number][] = [
    [8, 60, 112, 60],   // horizontal
    [60, 8, 60, 112],   // vertical
  ]
  for (const [x1, y1, x2, y2] of lines) {
    const line = document.createElementNS(NS, 'line')
    line.setAttribute('x1', String(x1))
    line.setAttribute('y1', String(y1))
    line.setAttribute('x2', String(x2))
    line.setAttribute('y2', String(y2))
    line.setAttribute('stroke', 'rgba(255,255,255,0.15)')
    line.setAttribute('stroke-width', '1')
    svg.appendChild(line)
  }

  // Dot
  const dotEl = document.createElementNS(NS, 'circle')
  dotEl.classList.add('gforce-dot')
  dotEl.setAttribute('cx', '60')
  dotEl.setAttribute('cy', '60')
  dotEl.setAttribute('r', '5')
  dotEl.setAttribute('fill', '#ff6b00')
  dotEl.setAttribute('stroke', '#fff')
  dotEl.setAttribute('stroke-width', '1.5')
  svg.appendChild(dotEl)

  return svg
}

export function drawGForce(lat: number, lon: number, targetSvg?: SVGSVGElement): void {
  const target = targetSvg
    ? targetSvg.querySelector('.gforce-dot') as SVGCircleElement
    : dot
  if (!target) return

  const clamp = (v: number) => Math.max(-MAX_G, Math.min(MAX_G, v))
  const dotX = CX + (clamp(lat) / MAX_G) * RADIUS
  const dotY = CY - (clamp(lon) / MAX_G) * RADIUS

  target.setAttribute('cx', dotX.toString())
  target.setAttribute('cy', dotY.toString())
}
