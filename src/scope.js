// Draws one real CAN 2.0A data frame (CAN_H / CAN_L) as an oscilloscope capture,
// with a protocol-decode row underneath. Bit stuffing and CRC-15 are computed,
// so the trace is what a scope would actually show for this frame.

const FRAME = { id: 0x123, data: [...'HELLO'].map((c) => c.charCodeAt(0)) }

const SVG_NS = 'http://www.w3.org/2000/svg'
const hex = (n, width = 2) => n.toString(16).toUpperCase().padStart(width, '0')
const toBits = (value, count) => Array.from({ length: count }, (_, i) => (value >> (count - 1 - i)) & 1)

function crc15(bits) {
  let crc = 0
  for (const bit of bits) {
    const next = bit ^ ((crc >> 14) & 1)
    crc = (crc << 1) & 0x7fff
    if (next) crc ^= 0x4599
  }
  return crc
}

// Returns the bit stream on the wire plus the [start, end) range of each decoded field
function buildFrame({ id, data }) {
  const fields = [
    { name: 'sof', bits: [0] },
    { name: 'id', bits: toBits(id, 11), label: hex(id, 3) },
    { name: 'ctrl', bits: [0, 0, 0] }, // RTR, IDE, r0
    { name: 'dlc', bits: toBits(data.length, 4), label: String(data.length) },
    ...data.map((byte) => ({ name: 'data', bits: toBits(byte, 8), label: hex(byte) })),
  ]
  const crc = crc15(fields.flatMap((f) => f.bits))
  fields.push({ name: 'crc', bits: toBits(crc, 15), label: `CRC ${hex(crc, 4)}` })

  // Bit stuffing: after five identical bits, insert the opposite bit (SOF through CRC)
  const wire = []
  const spans = []
  let run = 0
  let last = -1
  for (const field of fields) {
    const start = wire.length
    for (const bit of field.bits) {
      wire.push(bit)
      run = bit === last ? run + 1 : 1
      last = bit
      if (run === 5) {
        wire.push(1 - bit)
        last = 1 - bit
        run = 1
      }
    }
    if (field.label) spans.push({ name: field.name, label: field.label, start, end: wire.length })
  }

  const ackStart = wire.length
  wire.push(1, 0, 1) // CRC delimiter, ACK slot (driven by a receiver), ACK delimiter
  spans.push({ name: 'ack', label: 'ACK', start: ackStart, end: ackStart + 3 })
  wire.push(...Array(7).fill(1)) // end of frame

  return { wire, spans, crc }
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  parent?.appendChild(node)
  return node
}

export function drawScope(root) {
  const svg = root.querySelector('.scope-svg')
  const readout = root.querySelector('.candump')
  if (!svg) return

  const { wire, spans } = buildFrame(FRAME)
  const idle = 6
  const bits = [...Array(idle).fill(1), ...wire, ...Array(idle).fill(1)]

  const bitW = 10
  const W = bits.length * bitW
  const H = 204
  const vTop = 4.5 // volts at the top of the screen
  const vScale = 30 // px per volt
  const y = (v) => 18 + (vTop - v) * vScale
  const edge = bitW * 0.12 // rise/fall time

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  // Graticule: 10 horizontal divisions, 5 vertical, with a center crosshair
  const grid = el('g', { class: 'graticule' }, svg)
  for (let i = 1; i < 10; i++) el('line', { x1: (W / 10) * i, x2: (W / 10) * i, y1: 0, y2: 150 }, grid)
  for (let i = 1; i < 5; i++) el('line', { x1: 0, x2: W, y1: 30 * i, y2: 30 * i }, grid)

  const trace = (dominantV) => {
    const recessiveV = 2.5
    let d = `M0 ${y(recessiveV)}`
    let prev = 1
    bits.forEach((bit, i) => {
      const x = i * bitW
      const v = bit ? recessiveV : dominantV
      if (bit !== prev) d += ` L${x} ${y(prev ? recessiveV : dominantV)} L${x + edge} ${y(v)}`
      prev = bit
    })
    return d + ` L${W} ${y(recessiveV)}`
  }

  el('path', { d: trace(1.5), class: 'trace trace-l', pathLength: 1 }, svg)
  el('path', { d: trace(3.5), class: 'trace trace-h', pathLength: 1 }, svg)

  // Protocol decode row
  const decode = el('g', { class: 'decode' }, svg)
  const rowY = 168
  for (const span of spans) {
    const x0 = (span.start + idle) * bitW + 1
    const x1 = (span.end + idle) * bitW - 1
    const g = el('g', { class: `field field-${span.name}` }, decode)
    const r = 7
    el(
      'path',
      { d: `M${x0} ${rowY + 12} L${x0 + r} ${rowY} H${x1 - r} L${x1} ${rowY + 12} L${x1 - r} ${rowY + 24} H${x0 + r} Z` },
      g,
    )
    const t = el('text', { x: (x0 + x1) / 2, y: rowY + 16.5 }, g)
    t.textContent = span.label
  }

  if (readout) {
    const bytes = FRAME.data.map((b) => hex(b)).join(' ')
    const ascii = String.fromCharCode(...FRAME.data)
    readout.textContent = `can0  ${hex(FRAME.id, 3)}   [${FRAME.data.length}]  ${bytes}   '${ascii}'`
  }
}
