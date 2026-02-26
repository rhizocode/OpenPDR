/**
 * OpenPDR Viewer — Steering wheel indicator (canvas)
 *
 * Racing-style flat-bottom steering wheel that rotates with the steering angle.
 * Negated: PDR data uses positive = left turn, display rotates accordingly.
 * Text label drawn above the wheel (non-rotated).
 */

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D

export function initSteeringIndicator(): void {
  canvas = document.getElementById('steering-canvas') as HTMLCanvasElement
  ctx = canvas.getContext('2d')!
}

export function drawSteering(deg: number): void {
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  // ── Numeric label above the wheel (non-rotated) ──
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 18px Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(`${Math.round(deg)}\u00B0`, w / 2, 0)

  // ── Wheel geometry ──
  const cx = w / 2
  const cy = 14 + (h - 14) / 2
  const outerR = Math.min(cx, (h - 14) / 2) - 4  // margin for grip sections extending beyond rim
  const rimThick = 8
  const midR = outerR - rimThick / 2   // center line of rim stroke
  const innerR = outerR - rimThick      // inside edge of rim
  const hubR = 10

  // Negate: PDR positive = left turn
  const angleRad = (-deg * Math.PI) / 180

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(angleRad)

  // ── Flat-bottom rim ──
  // Flat section spans ~36 degrees centered at 6 o'clock
  const flatHalf = 18 * Math.PI / 180
  const flatStart = Math.PI / 2 - flatHalf
  const flatEnd = Math.PI / 2 + flatHalf

  // Main rim arc (thick, goes from flat-end around the top to flat-start)
  ctx.beginPath()
  ctx.arc(0, 0, midR, flatEnd, flatStart + Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = rimThick
  ctx.lineCap = 'butt'
  ctx.stroke()

  // Flat bottom bar
  const fLx = Math.cos(flatEnd) * midR
  const fLy = Math.sin(flatEnd) * midR
  const fRx = Math.cos(flatStart + Math.PI * 2) * midR
  const fRy = Math.sin(flatStart + Math.PI * 2) * midR
  ctx.beginPath()
  ctx.moveTo(fLx, fLy)
  ctx.lineTo(fRx, fRy)
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = rimThick
  ctx.lineCap = 'butt'
  ctx.stroke()

  // ── Spoke shapes (filled trapezoids — wider at rim, narrower at hub) ──
  const spokeColor = 'rgba(255,255,255,0.55)'
  const tilt = 10 * Math.PI / 180  // 10 degrees above horizontal

  // Helper: draw a tapered spoke from hub to inner rim edge
  function drawSpoke(angle: number, hubHalfW: number, rimHalfW: number): void {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const perpCos = Math.cos(angle + Math.PI / 2)
    const perpSin = Math.sin(angle + Math.PI / 2)

    const hR = hubR + 1
    const rR = innerR - 1

    ctx.beginPath()
    ctx.moveTo(cos * hR + perpCos * hubHalfW, sin * hR + perpSin * hubHalfW)
    ctx.lineTo(cos * rR + perpCos * rimHalfW, sin * rR + perpSin * rimHalfW)
    ctx.lineTo(cos * rR - perpCos * rimHalfW, sin * rR - perpSin * rimHalfW)
    ctx.lineTo(cos * hR - perpCos * hubHalfW, sin * hR - perpSin * hubHalfW)
    ctx.closePath()
    ctx.fillStyle = spokeColor
    ctx.fill()
  }

  // Bottom spoke (6 o'clock — straight down)
  drawSpoke(Math.PI / 2, 3, 5)

  // Right spoke (~10° above 3 o'clock)
  drawSpoke(-tilt, 2.5, 4.5)

  // Left spoke (~10° above 9 o'clock)
  drawSpoke(Math.PI + tilt, 2.5, 4.5)

  // ── Center hub ──
  // Outer ring
  ctx.beginPath()
  ctx.arc(0, 0, hubR, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = 2
  ctx.stroke()

  // Inner ring
  ctx.beginPath()
  ctx.arc(0, 0, hubR * 0.5, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Bolt pattern (6 dots)
  const boltR = hubR * 0.72
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2
    ctx.beginPath()
    ctx.arc(Math.cos(a) * boltR, Math.sin(a) * boltR, 1.2, 0, Math.PI * 2)
    ctx.fill()
  }

  // ── 12 o'clock marker stripe (rotation reference) ──
  ctx.fillStyle = '#ff6b00'
  const markerW = 4
  const markerTop = -outerR - 1
  const markerBot = -outerR + rimThick + 1
  ctx.beginPath()
  ctx.moveTo(0, markerTop)
  ctx.lineTo(markerW / 2, markerBot)
  ctx.lineTo(-markerW / 2, markerBot)
  ctx.closePath()
  ctx.fill()

  ctx.restore()
}
