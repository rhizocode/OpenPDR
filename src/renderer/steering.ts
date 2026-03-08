/**
 * OpenPDR Viewer — Steering wheel indicator (SVG)
 *
 * Rotates an SVG steering wheel icon with the steering angle.
 * Negated: PDR data uses positive = left turn, display rotates accordingly.
 * Text label drawn above the wheel (non-rotated).
 */

const NS = 'http://www.w3.org/2000/svg'

const STEERING_PATH = 'M370.513 874.855c-48.815-20.02-92.685-50.082-129.215-87.716-69.276-71.384-112.122-170.011-112.122-278.945 0-108.918 42.846-207.544 112.122-278.929 69.836-71.953 170.267-107.93 270.706-107.93 100.423 0 200.861 35.977 270.688 107.93 69.276 71.384 112.131 170.01 112.131 278.929 0 108.934-42.855 207.561-112.131 278.945-36.52 37.633-80.399 67.694-129.205 87.716-45.187 18.524-93.334 27.811-141.483 27.811-48.166 0-96.298-9.288-141.491-27.811l0 0zM512.005 199.998c-80.213 0-160.425 28.732-216.19 86.211-33.202 34.203-58.802 76.253-73.97 123.216-4.189 15.772 1.398 23.218 16.742 22.364 50.317-1.991 158.745-3.58 181.017-4.735-19.13 22.356-30.724 51.706-30.724 83.843 0 35.031 13.779 66.757 36.06 89.716 7.949 8.2 16.994 15.277 26.875 20.983 18.62 10.778 39.397 16.165 60.19 16.174 20.785-0.008 41.563-5.396 60.181-16.174 9.881-5.707 18.919-12.783 26.875-20.983 22.281-22.959 36.06-54.684 36.06-89.716 0-32.136-11.603-61.488-30.716-83.843 22.263 1.155 130.691 2.744 181.001 4.735 15.345 0.853 20.94-6.593 16.742-22.364-15.159-46.962-40.762-89.012-73.971-123.216-55.764-57.48-135.968-86.211-216.174-86.211l0 0zM581.084 439.837c-35.645-36.729-102.534-36.729-138.178 0-17.676 18.215-28.613 43.389-28.613 71.185 0 27.811 10.937 52.978 28.613 71.199 6.813 7.011 14.615 13.002 23.19 17.704 28.483 15.645 63.324 15.645 91.808 0 8.566-4.702 16.377-10.694 23.182-17.704 17.684-18.222 28.62-43.389 28.62-71.199 0.001-27.794-10.936-52.969-28.62-71.185l0 0zM529.738 548.203c13.365-6.761 22.564-20.933 22.564-37.307 0-17.353-10.337-32.221-25.008-38.428-9.71-4.108-20.875-4.108-30.586 0-14.672 6.208-25.008 21.076-25.008 38.428 0 16.373 9.191 30.546 22.555 37.307 11.074 5.588 24.423 5.588 35.483 0l0 0zM575.449 817.192c58.964-12.818 111.669-43.147 152.728-85.459 42.896-44.2 73.092-101.47 84.509-165.509 4.109-17.369-3.143-22.69-15.848-22.272-25.626-0.56-51.261-0.452-75.691 4.293-87.041 16.909-118.171 60.19-133.574 159.829-5.595 36.193-9.151 78.547-12.123 109.118l0 0zM448.541 817.192c-2.963-30.572-6.528-72.925-12.114-109.118-15.404-99.638-46.54-142.919-133.583-159.829-24.423-4.745-50.065-4.853-75.691-4.293-12.699-0.418-19.957 4.902-15.841 22.272 11.408 64.039 41.614 121.309 84.501 165.509 41.068 42.312 93.764 72.64 152.728 85.459z'

let svgEl: SVGSVGElement
let labelEl: HTMLSpanElement

export function initSteeringIndicator(): void {
  svgEl = document.getElementById('steering-svg') as unknown as SVGSVGElement
  labelEl = document.getElementById('steering-label') as HTMLSpanElement
}

export function drawSteering(deg: number, targetSvg?: SVGSVGElement, targetLabel?: HTMLSpanElement): void {
  const svg = targetSvg ?? svgEl
  const lbl = targetLabel ?? labelEl

  // Update numeric label (non-rotated).
  // Number is inline (drives centering), degree symbol has width:0 so it doesn't shift center.
  const num = `${Math.abs(Math.round(deg))}`
  lbl.innerHTML = `${num}<span class="deg-symbol">\u00B0</span>`

  // Negate: PDR positive = left turn
  svg.style.transform = `rotate(${-deg}deg)`
}

// ── Export-only: self-contained SVG factory + draw ──

// Approximate monospace character width as a fraction of font-size.
// Consolas/monospace at bold 230px ≈ 138px per digit.
const CHAR_W = 230 * 0.6

/** Create a detached SVG for offscreen steering rendering (video export).
 *  Uses SVG-native `<text>` for the degree label and `transform` attribute
 *  for rotation (live display uses CSS transform + HTML span). */
export function createSteeringSvg(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 1024 1024')
  svg.setAttribute('xmlns', NS)

  // Rotated group (wheel + notch)
  const g = document.createElementNS(NS, 'g')
  g.classList.add('steering-rotate')
  // Default: no rotation (transform set per-frame)

  // Wheel path
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', STEERING_PATH)
  path.setAttribute('fill', 'rgba(30,30,30,0.85)')
  g.appendChild(path)

  // Red notch
  const notch = document.createElementNS(NS, 'rect')
  notch.setAttribute('x', '500')
  notch.setAttribute('y', '118')
  notch.setAttribute('width', '24')
  notch.setAttribute('height', '80')
  notch.setAttribute('rx', '5')
  notch.setAttribute('fill', '#ab2010')
  g.appendChild(notch)

  svg.appendChild(g)

  // Degree label (non-rotated, centered on number only — ° hangs past center)
  // Mirrors the live CSS approach where .deg-symbol has width:0.
  // Uses text-anchor:start with manually computed x to center the number,
  // so the degree symbol naturally flows right without affecting centering.
  const text = document.createElementNS(NS, 'text')
  text.classList.add('steering-text')
  text.setAttribute('y', '512')
  text.setAttribute('text-anchor', 'start')
  text.setAttribute('dominant-baseline', 'central')
  text.setAttribute('fill', '#fff')
  text.setAttribute('font-family', 'Consolas, monospace')
  text.setAttribute('font-size', '230')
  text.setAttribute('font-weight', 'bold')
  // Initial position for "0°" — 1 digit centered
  text.setAttribute('x', (512 - CHAR_W / 2).toFixed(1))
  text.textContent = '0\u00B0'
  svg.appendChild(text)

  return svg
}

/** Update the detached steering SVG for a given angle (export-only). */
export function drawSteeringSvg(deg: number, svg: SVGSVGElement): void {
  const g = svg.querySelector('.steering-rotate') as SVGGElement
  if (g) {
    // Negate: PDR positive = left turn; rotate around center (512,512)
    g.setAttribute('transform', `rotate(${-deg} 512 512)`)
  }
  const text = svg.querySelector('.steering-text') as SVGTextElement
  if (text) {
    const numStr = `${Math.abs(Math.round(deg))}`
    // Position so the number is centered on 512; ° hangs off to the right
    text.setAttribute('x', (512 - (numStr.length * CHAR_W) / 2).toFixed(1))
    text.textContent = numStr + '\u00B0'
  }
}
