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

export function drawSteering(deg: number, targetSvg?: SVGSVGElement, targetLabel?: HTMLSpanElement): void {
  const svg = targetSvg ?? svgEl
  const lbl = targetLabel ?? labelEl

  // Update numeric label (non-rotated)
  lbl.textContent = `${Math.abs(Math.round(deg))}\u00B0`

  // Negate: PDR positive = left turn
  svg.style.transform = `rotate(${-deg}deg)`
}
