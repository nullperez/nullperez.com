// Draws one real CAN 2.0A data frame (CAN_H / CAN_L) as an oscilloscope capture,
// with a protocol-decode row underneath. Bit stuffing and CRC-15 are computed,
// so the trace is what a scope would actually show for this frame.
// Visitors can send their own payload, which is re-encoded the same way.

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
    ...data.map((byte) => ({
      name: 'data',
      bits: toBits(byte, 8),
      label: hex(byte),
      ascii: byte === 0x20 ? '␣' : String.fromCharCode(byte), // show spaces so the slot isn't blank
    })),
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
    if (field.label) spans.push({ name: field.name, label: field.label, ascii: field.ascii, start, end: wire.length })
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

const candump = ({ id, data }) => {
  const bytes = data.map((b) => hex(b)).join(' ')
  const ascii = data.length ? `   '${String.fromCharCode(...data)}'` : ''
  return `can0  ${hex(id, 3)}   [${data.length}]  ${bytes}${ascii}`
}

export function drawScope(root) {
  const svg = root.querySelector('.scope-svg')
  const readout = root.querySelector('.candump')
  const form = root.querySelector('.scope-send')
  if (!svg) return

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const idle = 6
  // Screen width is fixed to fit the default frame; other frames autoscale the timebase to fill it
  const W = (buildFrame(FRAME).wire.length + idle * 2) * 10
  const H = 204
  const vTop = 4.5 // volts at the top of the screen
  const vScale = 30 // px per volt
  const y = (v) => 18 + (vTop - v) * vScale

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  // Graticule: 10 horizontal divisions, 5 vertical, with a center crosshair
  const grid = el('g', { class: 'graticule' }, svg)
  for (let i = 1; i < 10; i++) el('line', { x1: (W / 10) * i, x2: (W / 10) * i, y1: 0, y2: 150 }, grid)
  for (let i = 1; i < 5; i++) el('line', { x1: 0, x2: W, y1: 30 * i, y2: 30 * i }, grid)

  // The traces are revealed left to right by a clip that follows the sweep position
  const clip = el('clipPath', { id: 'scope-sweep' }, el('defs', {}, svg))
  const sweep = el('rect', { x: 0, y: 0, width: 0, height: H }, clip)
  // Idle bus ahead of the sweep: CAN_H and CAN_L both rest at 2.5 V, so they overlap as one flat line
  const idleLine = el('line', { class: 'trace trace-h idle', x1: 0, x2: W, y1: y(2.5), y2: y(2.5) }, svg)
  const traces = el('g', { 'clip-path': 'url(#scope-sweep)' }, svg)
  const cursor = el('line', { class: 'sweep-cursor', x1: 0, x2: 0, y1: 0, y2: 150 }, svg)
  const decode = el('g', { class: 'decode' }, svg)
  let fields = []

  const setFrame = (frame) => {
    const { wire, spans } = buildFrame(frame)
    const bits = [...Array(idle).fill(1), ...wire, ...Array(idle).fill(1)]
    const bitW = W / bits.length
    const edge = bitW * 0.12 // rise/fall time

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

    traces.replaceChildren()
    el('path', { d: trace(1.5), class: 'trace trace-l' }, traces)
    el('path', { d: trace(3.5), class: 'trace trace-h' }, traces)

    // Protocol decode row
    decode.replaceChildren()
    fields = []
    const rowY = 168
    for (const span of spans) {
      const x0 = (span.start + idle) * bitW + 1
      const x1 = (span.end + idle) * bitW - 1
      const g = el('g', { class: `field field-${span.name}` }, decode)
      fields.push({ g, end: x1 })
      const r = Math.min(7, (x1 - x0) / 3)
      el(
        'path',
        { d: `M${x0} ${rowY + 12} L${x0 + r} ${rowY} H${x1 - r} L${x1} ${rowY + 12} L${x1 - r} ${rowY + 24} H${x0 + r} Z` },
        g,
      )
      const t = el('text', { x: (x0 + x1) / 2, y: rowY + 16.5 }, g)
      t.textContent = span.label
      // ASCII character for each data byte, just above its hex value
      if (span.ascii) {
        const a = el('text', { class: 'ascii', x: (x0 + x1) / 2, y: rowY - 5 }, g)
        a.textContent = span.ascii
      }
    }

    if (readout) readout.textContent = candump(frame)
  }

  const render = (p) => {
    const x = p * W
    sweep.setAttribute('width', x)
    idleLine.setAttribute('x1', x)
    cursor.setAttribute('x1', x)
    cursor.setAttribute('x2', x)
    cursor.style.display = p > 0 && p < 1 ? '' : 'none'
    for (const f of fields) f.g.classList.toggle('on', x >= f.end)
  }

  setFrame(FRAME)

  // Send a frame: re-encode the visitor's text and sweep it onto the screen.
  // After the first send, scrolling no longer drives the sweep.
  let sent = false
  if (form) {
    const input = form.elements.data
    let anim = 0
    input.addEventListener('input', () => {
      const clean = input.value.replace(/[^\x20-\x7E]/g, '') // printable ASCII only, one byte per character
      if (clean !== input.value) input.value = clean
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      sent = true
      setFrame({ id: FRAME.id, data: [...input.value].map((c) => c.charCodeAt(0)) })
      cancelAnimationFrame(anim)
      if (reduceMotion) {
        render(1)
        return
      }
      const start = performance.now()
      const step = (now) => {
        const t = Math.min((now - start) / 900, 1)
        render(t)
        if (t < 1) anim = requestAnimationFrame(step)
      }
      anim = requestAnimationFrame(step)
    })
  }

  if (reduceMotion) {
    render(1)
    return
  }

  // t = 0 at the top of the page; the frame completes as the scope reaches the top of the screen
  const header = document.querySelector('.site-header')
  let range = 1
  const measure = () => {
    const top = root.getBoundingClientRect().top + window.scrollY
    range = Math.max(top - (header?.offsetHeight ?? 0) - 24, 1)
  }

  let queued = false
  const update = () => {
    queued = false
    if (!sent) render(Math.min(Math.max(window.scrollY / range, 0), 1))
  }
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(update)
  }
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', () => {
    measure()
    schedule()
  })
  measure()
  update()
}
