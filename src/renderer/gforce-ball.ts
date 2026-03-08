/**
 * OpenPDR Viewer — G-force ball (SVG)
 *
 * Renders a circular g-force plot with lateral (X) and longitudinal (Y)
 * acceleration. Grid circles at 0.5G and 1.0G increments.
 * SVG-based: resolution-independent, scales perfectly with CSS transforms.
 */

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
