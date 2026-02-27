/**
 * OpenPDR Viewer — Steering wheel indicator (SVG)
 *
 * Rotates an SVG steering wheel icon with the steering angle.
 * Negated: PDR data uses positive = left turn, display rotates accordingly.
 * Text label drawn above the wheel (non-rotated).
 */

let svgEl: SVGSVGElement
let labelEl: HTMLSpanElement

export function initSteeringIndicator(): void {
  svgEl = document.getElementById('steering-svg') as unknown as SVGSVGElement
  labelEl = document.getElementById('steering-label') as HTMLSpanElement
}

export function drawSteering(deg: number): void {
  // Update numeric label (non-rotated)
  labelEl.textContent = `${Math.round(deg)}\u00B0`

  // Negate: PDR positive = left turn
  svgEl.style.transform = `rotate(${-deg}deg)`
}
