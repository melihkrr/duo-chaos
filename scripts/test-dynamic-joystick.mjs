// ============================================================================
// DUO CHAOS — dynamic (floating) joystick test.
//
// Verifies the behaviour of components/game/VirtualJoystick.tsx after it was
// converted from a FIXED-position joystick to a DYNAMIC/FLOATING one:
//   * the joystick has NO permanent position — it is created at the initial
//     touch point and hidden on release,
//   * the base is centred EXACTLY on the initial touch (local layer coords),
//   * dragging the thumb produces a normalised -1..1 vector,
//   * moving beyond the radius CLAMPS the magnitude to 1 (direction kept),
//   * releasing immediately zeroes the input,
//   * a NEW touch starts a completely NEW joystick position,
//   * a SECOND finger does NOT create a second joystick / duplicate input,
//   * only the primary (left) mouse button activates it,
//   * the capture layer covers the whole arena (so buttons/HUD outside it are
//     never intercepted).
//
// The test mirrors the EXACT pointer math + guard logic of the component and
// drives it through a mobile-sized viewport (390x844, iPhone-ish) with several
// touch positions. It is a pure logic-level test (no DOM), matching the style
// of the other scripts/test-*.mjs files in this repo.
//
// Run: node scripts/test-dynamic-joystick.mjs
// ============================================================================

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2718 ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// Mirror of components/game/VirtualJoystick.tsx
// ---------------------------------------------------------------------------
const SIZE = 132
const RADIUS = SIZE / 2 // 66
const KNOB_TRAVEL = 40 // knob.style.transform uses x * 40

// A fake capture layer with a bounding rect (mobile viewport, arena inset).
const makeLayer = (rect) => ({
  rect,
  getBoundingClientRect: () => rect,
})

// The component instance: holds refs + the DOM writes it performs.
const createJoystick = (layer, onChange) => {
  const state = {
    pointerId: null,
    originX: 0,
    originY: 0,
    // DOM-observable outputs:
    base: { left: null, top: null, opacity: '0' },
    knob: { transform: 'translate(0px, 0px)' },
    input: { dx: 0, dy: 0 },
    onChangeCalls: 0,
    captured: [],
  }

  const paintKnob = (x, y) => {
    state.knob.transform = `translate(${x * KNOB_TRAVEL}px, ${y * KNOB_TRAVEL}px)`
  }

  const showBaseAt = (clientX, clientY) => {
    const rect = layer.getBoundingClientRect()
    state.base.left = `${clientX - rect.left}px`
    state.base.top = `${clientY - rect.top}px`
    state.base.opacity = '1'
  }

  const hideBase = () => {
    state.base.opacity = '0'
  }

  const update = (clientX, clientY) => {
    let dx = (clientX - state.originX) / RADIUS
    let dy = (clientY - state.originY) / RADIUS
    const length = Math.hypot(dx, dy)
    if (length > 1) {
      dx /= length
      dy /= length
    }
    paintKnob(dx, dy)
    state.input = { dx, dy }
    state.onChangeCalls += 1
    onChange(dx, dy)
  }

  const end = () => {
    state.pointerId = null
    paintKnob(0, 0)
    hideBase()
    state.input = { dx: 0, dy: 0 }
    state.onChangeCalls += 1
    onChange(0, 0)
  }

  return {
    state,
    onPointerDown(event) {
      if (state.pointerId !== null) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      state.pointerId = event.pointerId
      state.originX = event.clientX
      state.originY = event.clientY
      showBaseAt(event.clientX, event.clientY)
      paintKnob(0, 0)
      state.captured.push(event.pointerId)
    },
    onPointerMove(event) {
      if (state.pointerId !== event.pointerId) return
      update(event.clientX, event.clientY)
    },
    onPointerUp(event) {
      if (state.pointerId !== event.pointerId) return
      end()
    },
    onPointerCancel(event) {
      if (state.pointerId !== event.pointerId) return
      end()
    },
  }
}

// ---------------------------------------------------------------------------
// Mobile viewport: 390x844. The arena (capture layer) is inset below the HUD
// and above the footer, e.g. left:0 top:120 width:390 height:600.
// ---------------------------------------------------------------------------
const VIEWPORT = { width: 390, height: 844 }
const ARENA_RECT = { left: 0, top: 120, width: 390, height: 600 }
const layer = makeLayer(ARENA_RECT)

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

console.log('\n=== Dynamic joystick — mobile viewport 390x844 ===\n')

// --- 1. No permanent position: base starts hidden --------------------------
{
  const j = createJoystick(layer, () => {})
  check('base is hidden before any touch (no permanent position)', j.state.base.opacity === '0')
  check('no pointer is active before any touch', j.state.pointerId === null)
  check('input is zero before any touch', j.state.input.dx === 0 && j.state.input.dy === 0)
}

// --- 2. Touch creates the joystick EXACTLY at the touch point --------------
{
  const calls = []
  const j = createJoystick(layer, (dx, dy) => calls.push([dx, dy]))
  // Touch at screen (200, 400) -> local (200, 280) inside the arena.
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 400 })
  check('base becomes visible on touch', j.state.base.opacity === '1')
  check(
    'base is centred exactly at the touch point (local coords)',
    j.state.base.left === '200px' && j.state.base.top === '280px',
    `got left=${j.state.base.left} top=${j.state.base.top}`,
  )
  check('pointer is captured on touch', j.state.captured.includes(1))
  check('knob starts centred (0,0)', j.state.knob.transform === 'translate(0px, 0px)')
  check('no movement emitted on touch-down alone', calls.length === 0)
}

// --- 3. Drag produces a normalised vector ----------------------------------
{
  const j = createJoystick(layer, () => {})
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 400 })
  // Drag right by 33px = half the radius -> dx = 0.5, dy = 0.
  j.onPointerMove({ pointerId: 1, clientX: 233, clientY: 400 })
  check('drag right half-radius -> dx=0.5, dy=0', near(j.state.input.dx, 0.5) && near(j.state.input.dy, 0))
  check('knob painted to half travel (20px)', j.state.knob.transform === 'translate(20px, 0px)')
  // Drag up by 66px = full radius -> dy = -1.
  j.onPointerMove({ pointerId: 1, clientX: 200, clientY: 334 })
  check('drag up full radius -> dy=-1', near(j.state.input.dx, 0) && near(j.state.input.dy, -1))
}

// --- 4. Outside the radius CLAMPS magnitude to 1, direction preserved ------
{
  const j = createJoystick(layer, () => {})
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 400 })
  // Drag far right-down: (300, 500) -> delta (100, 100), length ~141.4 > 66.
  j.onPointerMove({ pointerId: 1, clientX: 300, clientY: 500 })
  const { dx, dy } = j.state.input
  const mag = Math.hypot(dx, dy)
  check('magnitude is clamped to exactly 1 outside the radius', near(mag, 1, 1e-12), `mag=${mag}`)
  check('direction is preserved (dx === dy, both positive)', near(dx, dy) && dx > 0 && dy > 0)
  check('clamped components equal 1/sqrt(2)', near(dx, Math.SQRT1_2) && near(dy, Math.SQRT1_2))
  check('knob travel is clamped to 40px each axis', j.state.knob.transform === `translate(${Math.SQRT1_2 * 40}px, ${Math.SQRT1_2 * 40}px)`)
}

// --- 5. Release immediately stops input ------------------------------------
{
  const calls = []
  const j = createJoystick(layer, (dx, dy) => calls.push([dx, dy]))
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 400 })
  j.onPointerMove({ pointerId: 1, clientX: 260, clientY: 400 })
  check('input is non-zero while dragging', j.state.input.dx > 0)
  j.onPointerUp({ pointerId: 1 })
  check('release zeroes the input', j.state.input.dx === 0 && j.state.input.dy === 0)
  check('release hides the base', j.state.base.opacity === '0')
  check('release recentres the knob', j.state.knob.transform === 'translate(0px, 0px)')
  check('release clears the active pointer', j.state.pointerId === null)
  check('release emits a final (0,0)', calls.length === 2 && calls[1][0] === 0 && calls[1][1] === 0)
}

// --- 6. A NEW touch starts a completely NEW joystick position --------------
{
  const j = createJoystick(layer, () => {})
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 300 })
  j.onPointerUp({ pointerId: 1 })
  // New touch elsewhere: screen (320, 700) -> local (320, 580).
  j.onPointerDown({ pointerId: 2, pointerType: 'touch', button: 0, clientX: 320, clientY: 700 })
  check('new touch re-shows the base', j.state.base.opacity === '1')
  check(
    'new touch moves the base to the new location',
    j.state.base.left === '320px' && j.state.base.top === '580px',
    `got left=${j.state.base.left} top=${j.state.base.top}`,
  )
  check('new touch resets the knob to centre', j.state.knob.transform === 'translate(0px, 0px)')
  // Drag relative to the NEW origin only.
  j.onPointerMove({ pointerId: 2, clientX: 320 + 66, clientY: 700 })
  check('drag is measured from the NEW origin (dx=1)', near(j.state.input.dx, 1) && near(j.state.input.dy, 0))
}

// --- 7. Multi-touch: a second finger does NOT create a second joystick -----
{
  const calls = []
  const j = createJoystick(layer, (dx, dy) => calls.push([dx, dy]))
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 150, clientY: 400 })
  const baseAfterFirst = { ...j.state.base }
  // Second finger touches elsewhere while the first is still down.
  j.onPointerDown({ pointerId: 2, pointerType: 'touch', button: 0, clientX: 300, clientY: 600 })
  check('second finger does NOT move the base', j.state.base.left === baseAfterFirst.left && j.state.base.top === baseAfterFirst.top)
  check('second finger does NOT become the active pointer', j.state.pointerId === 1)
  check('second finger is NOT captured', !j.state.captured.includes(2))
  // Moves from the second finger must be ignored.
  const before = calls.length
  j.onPointerMove({ pointerId: 2, clientX: 390, clientY: 800 })
  check('moves from the second finger are ignored', calls.length === before)
  // The first finger still controls the joystick.
  j.onPointerMove({ pointerId: 1, clientX: 150 + 33, clientY: 400 })
  check('first finger still controls the joystick', near(j.state.input.dx, 0.5))
  // Lifting the second finger must NOT end the joystick.
  j.onPointerUp({ pointerId: 2 })
  check('lifting the second finger does NOT end the joystick', j.state.pointerId === 1 && j.state.base.opacity === '1')
  // Lifting the first finger ends it.
  j.onPointerUp({ pointerId: 1 })
  check('lifting the first finger ends the joystick', j.state.pointerId === null && j.state.base.opacity === '0')
}

// --- 8. Only the primary (left) mouse button activates ---------------------
{
  const j = createJoystick(layer, () => {})
  j.onPointerDown({ pointerId: 1, pointerType: 'mouse', button: 2, clientX: 200, clientY: 400 })
  check('right mouse button does NOT activate the joystick', j.state.pointerId === null && j.state.base.opacity === '0')
  j.onPointerDown({ pointerId: 2, pointerType: 'mouse', button: 0, clientX: 200, clientY: 400 })
  check('left mouse button activates the joystick', j.state.pointerId === 2 && j.state.base.opacity === '1')
}

// --- 9. pointercancel ends the joystick (e.g. system gesture) --------------
{
  const j = createJoystick(layer, () => {})
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 400 })
  j.onPointerMove({ pointerId: 1, clientX: 260, clientY: 400 })
  j.onPointerCancel({ pointerId: 1 })
  check('pointercancel zeroes input and hides the base', j.state.input.dx === 0 && j.state.base.opacity === '0' && j.state.pointerId === null)
}

// --- 10. Capture layer covers the whole arena (buttons/HUD outside) --------
{
  // The layer is absolutely positioned inset:0 inside .arena, so its rect
  // equals the arena rect. Any touch inside the arena maps to local coords
  // within [0,width]x[0,height]; touches on the HUD/footer never reach it.
  const j = createJoystick(layer, () => {})
  const inside = (cx, cy) =>
    cx >= ARENA_RECT.left &&
    cx <= ARENA_RECT.left + ARENA_RECT.width &&
    cy >= ARENA_RECT.top &&
    cy <= ARENA_RECT.top + ARENA_RECT.height
  check('arena top-left maps to local (0,0)', inside(0, 120))
  check('arena bottom-right maps to local (390,600)', inside(390, 720))
  check('HUD area (above arena) is outside the capture layer', !inside(200, 60))
  check('footer area (below arena) is outside the capture layer', !inside(200, 800))
  // A touch at the arena's very top-left corner centres the base at (0,0).
  j.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 120 })
  check('touch at arena corner centres base at local (0,0)', j.state.base.left === '0px' && j.state.base.top === '0px')
}

// --- 11. Multiple sequential touch positions on the mobile viewport --------
{
  const positions = [
    { x: 60, y: 200 },
    { x: 195, y: 420 },
    { x: 330, y: 640 },
    { x: 20, y: 700 },
  ]
  const j = createJoystick(layer, () => {})
  let allCentred = true
  positions.forEach((p, i) => {
    j.onPointerDown({ pointerId: 100 + i, pointerType: 'touch', button: 0, clientX: p.x, clientY: p.y })
    const expectedLeft = `${p.x - ARENA_RECT.left}px`
    const expectedTop = `${p.y - ARENA_RECT.top}px`
    if (j.state.base.left !== expectedLeft || j.state.base.top !== expectedTop) allCentred = false
    j.onPointerUp({ pointerId: 100 + i })
  })
  check('every touch position centres the joystick exactly there', allCentred)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
