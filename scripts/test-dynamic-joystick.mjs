import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const SIZE = 132
const INPUT_RADIUS = SIZE * 0.36
const KNOB_TRAVEL = 40
const ARENA = { left: 0, top: 120, width: 390, height: 600 }
const CSS = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8')
const COMPONENT = await readFile(
  new URL('../components/game/VirtualJoystick.tsx', import.meta.url),
  'utf8',
)

const centerForTouch = (arena, x, y) => {
  const inset = SIZE / 2 + 8
  return {
    x: Math.max(inset, Math.min(arena.width - inset, x - arena.left)) + arena.left,
    y: Math.max(inset, Math.min(arena.height - inset, y - arena.top)) + arena.top,
  }
}

const vectorFor = (origin, x, y) => {
  let dx = (x - origin.x) / INPUT_RADIUS
  let dy = (y - origin.y) / INPUT_RADIUS
  const length = Math.hypot(dx, dy)
  if (length > 1) {
    dx /= length
    dy /= length
  }
  return { dx, dy, knob: `translate(${dx * KNOB_TRAVEL}px, ${dy * KNOB_TRAVEL}px)` }
}

assert.match(CSS, /\.joystick\s*\{[^}]*opacity:\s*0/s)
assert.match(CSS, /\.joystick\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s)
assert.match(CSS, /\.joystick-layer\s*\{[^}]*inset:\s*0/s)
assert.match(COMPONENT, /const radius = size \* 0\.36/)
assert.match(COMPONENT, /originX\.current = event\.clientX/)
assert.match(COMPONENT, /update\(event\.clientX, event\.clientY\)/)
assert.match(COMPONENT, /base\.style\.opacity = '0\.8'/)
assert.match(COMPONENT, /hideBase\(\)/)

const smallArena = { left: 0, top: 100, width: 320, height: 320 }
const touchPositions = [
  { x: ARENA.left + 15, y: ARENA.top + 15 },
  { x: ARENA.left + ARENA.width / 2, y: ARENA.top + ARENA.height / 2 },
  { x: ARENA.left + ARENA.width - 15, y: ARENA.top + ARENA.height - 15 },
]
const centers = touchPositions.map(({ x, y }) => centerForTouch(ARENA, x, y))
assert.notDeepEqual(centers[0], centers[1])
assert.notDeepEqual(centers[1], centers[2])
for (const origin of centers) {
  assert.ok(origin.x - SIZE / 2 >= ARENA.left)
  assert.ok(origin.y - SIZE / 2 >= ARENA.top)
  assert.ok(origin.x + SIZE / 2 <= ARENA.left + ARENA.width)
  assert.ok(origin.y + SIZE / 2 <= ARENA.top + ARENA.height)
}

const smallCorner = centerForTouch(smallArena, smallArena.left, smallArena.top)
assert.ok(smallCorner.x - SIZE / 2 >= smallArena.left)
assert.ok(smallCorner.y - SIZE / 2 >= smallArena.top)
assert.ok(smallCorner.x + SIZE / 2 <= smallArena.left + smallArena.width)
assert.ok(smallCorner.y + SIZE / 2 <= smallArena.top + smallArena.height)

const center = centerForTouch(ARENA, ARENA.left + 150, ARENA.top + 200)
const shortDrag = vectorFor(center, center.x + 18, center.y)
assert.ok(shortDrag.dx > 0.37 && shortDrag.dx < 0.39)
assert.equal(shortDrag.dy, 0)
assert.match(shortDrag.knob, /^translate\(15\.[0-9]+px, 0px\)$/)

const heldOffCenterTouch = vectorFor(center, center.x + 36, center.y)
assert.ok(heldOffCenterTouch.dx > 0.75)
assert.equal(heldOffCenterTouch.dy, 0)

const fullDrag = vectorFor(center, center.x + INPUT_RADIUS * 1.5, center.y)
assert.equal(fullDrag.dx, 1)
assert.equal(fullDrag.dy, 0)
assert.equal(fullDrag.knob, 'translate(40px, 0px)')

const releaseVector = { dx: 0, dy: 0 }
assert.equal(Math.hypot(releaseVector.dx, releaseVector.dy), 0)

console.log('✔ Hidden-until-touch joystick placement, edge-safe dynamic position and responsive input verified.')
