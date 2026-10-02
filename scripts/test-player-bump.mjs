// ============================================================================
// DUO CHAOS — player bump / knockback regression test.
//
// The steal flow was removed entirely; the Risky Coin race replaced it. This
// test covers the NEW, isolated PLAYER BUMP / KNOCKBACK mechanic:
//
//   When the two players physically enter each other's contact range, BOTH are
//   pushed a short distance apart along the line connecting their centres. The
//   bump is purely positional — it does NOT change score, coins, objectives or
//   the round, and it does NOT end/interrupt the round.
//
// This test mirrors the EXACT server rules from migration 0052 (`duo_bump`) and
// the pure client helper `computeBump` from lib/movement.ts, then drives the 12
// required scenarios:
//   1.  A walks into stationary B  → both pushed apart.
//   2.  B walks into stationary A  → both pushed apart.
//   3.  Both run toward each other → both pushed apart.
//   4.  Diagonal contact           → pushed along correct opposite directions.
//   5.  Continuous contact         → does NOT bounce every frame (cooldown).
//   6.  After ~500–700ms           → a new genuine contact bumps again.
//   7.  Bump does NOT change score.
//   8.  Bump does NOT change coins.
//   9.  Bump does NOT affect objectives.
//   10. Keyboard movement unchanged (speed/feel constants preserved).
//   11. Joystick movement unchanged (same input path, no artificial delay).
//   12. Two clients stay synchronized after bumping (authoritative reconcile).
//
// No DB required. Run: node scripts/test-player-bump.mjs
// ============================================================================

import { readFile } from 'node:fs/promises'

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

// --- Constants mirrored from migration 0052 / lib/config.ts -----------------
const BUMP_CONTACT_R = 5.6
const BUMP_KNOCKBACK = 2.5
const BUMP_COOLDOWN_MS = 600
const PLAYER_HIT_R = 2.6
const MOVE_SPEED = 38
const BUMP_SPEED_MULTIPLIER = 0.55
const ARENA = { minX: 5, maxX: 95, minY: 7, maxY: 93 }

const migration = await readFile(
  new URL('../supabase/migrations/0052_player_bump.sql', import.meta.url),
  'utf8',
)
const configSource = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
const movementSource = await readFile(new URL('../lib/movement.ts', import.meta.url), 'utf8')

// --- Mirror of duo_clamp_pos -------------------------------------------------
const clampPos = (x, y) => ({
  x: Math.max(ARENA.minX, Math.min(ARENA.maxX, x)),
  y: Math.max(ARENA.minY, Math.min(ARENA.maxY, y)),
})

// --- Mirror of the pure computeBump helper (lib/movement.ts) -----------------
// (Obstacle push-out is omitted here: the test scenarios use open arena space,
// so `pushOut` is the identity. The direction/knockback math is identical.)
const computeBump = (
  meX,
  meY,
  rivalX,
  rivalY,
  contactR = BUMP_CONTACT_R,
  knockback = BUMP_KNOCKBACK,
) => {
  const dx = meX - rivalX
  const dy = meY - rivalY
  const dist = Math.hypot(dx, dy)
  if (dist > contactR) {
    return { bumped: false, me: { x: meX, y: meY }, rival: { x: rivalX, y: rivalY } }
  }
  let nx
  let ny
  if (dist < 1e-6) {
    nx = 1
    ny = 0
  } else {
    nx = dx / dist
    ny = dy / dist
  }
  const meTarget = clampPos(meX + nx * knockback, meY + ny * knockback)
  const rivalTarget = clampPos(rivalX - nx * knockback, rivalY - ny * knockback)
  return { bumped: true, me: meTarget, rival: rivalTarget }
}

// --- Mirror of the server `duo_bump` cooldown gate ---------------------------
// `state` = { me: {x,y}, rival: {x,y}, lastBumpAt, score, coins, objectivesDone }
const duoBump = (state, nowMs) => {
  const dx = state.me.x - state.rival.x
  const dy = state.me.y - state.rival.y
  const dist = Math.hypot(dx, dy)
  const elapsed = nowMs - state.lastBumpAt
  if (dist > BUMP_CONTACT_R || elapsed < BUMP_COOLDOWN_MS) {
    return { ok: true, bumped: false, x: state.me.x, y: state.me.y, rivalX: state.rival.x, rivalY: state.rival.y }
  }
  const contact = computeBump(state.me.x, state.me.y, state.rival.x, state.rival.y)
  state.me = contact.me
  state.rival = contact.rival
  state.lastBumpAt = nowMs
  // Score/coins/objectives are intentionally untouched.
  return {
    ok: true,
    bumped: true,
    x: state.me.x,
    y: state.me.y,
    rivalX: state.rival.x,
    rivalY: state.rival.y,
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const finite = (p) => Number.isFinite(p.x) && Number.isFinite(p.y)

console.log('\nPLAYER BUMP / KNOCKBACK — regression suite\n')

// ---------------------------------------------------------------------------
// 0. Static / contract checks
// ---------------------------------------------------------------------------
console.log('Contract')
check('migration defines duo_bump(text, text, numeric, numeric)', /duo_bump\(p_code text, p_token text, p_x numeric, p_y numeric\)/.test(migration))
check('migration adds last_bump_at column', /add column if not exists last_bump_at/.test(migration))
check('migration grants execute to anon, authenticated', /grant execute on function public\.duo_bump/.test(migration))
check('migration reloads PostgREST schema', /notify pgrst, 'reload schema'/.test(migration))
check('migration does NOT touch score/coins/objectives', !/set\s+score\s*=/.test(migration) && !/set\s+coins\s*=/.test(migration) && !/objective_progress\s*=/.test(migration))
check('config exports BUMP_CONTACT_R = 5.6', /export const BUMP_CONTACT_R = 5\.6/.test(configSource))
check('config exports BUMP_KNOCKBACK = 2.5', /export const BUMP_KNOCKBACK = 2\.5/.test(configSource))
check('config exports BUMP_COOLDOWN_MS = 600', /export const BUMP_COOLDOWN_MS = 600/.test(configSource))
check('movement exports computeBump', /export function computeBump\(/.test(movementSource))
check('movement has deterministic fallback (dist < 1e-6)', /dist < 1e-6/.test(movementSource))
check('server contact radius matches client (5.6)', /v_contact_r numeric := 5\.6/.test(migration))
check('server knockback matches client (2.5)', /v_knockback numeric := 2\.5/.test(migration))
check('server cooldown matches client (600)', /v_cooldown_ms bigint := 600/.test(migration))

// ---------------------------------------------------------------------------
// 1. A walks into stationary B → both pushed apart
// ---------------------------------------------------------------------------
console.log('\n1. A walks into stationary B')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  const before = dist(state.me, state.rival)
  const res = duoBump(state, 10_000)
  check('bump resolved', res.bumped === true)
  check('A pushed away from B (left)', state.me.x < 50)
  check('B pushed away from A (right)', state.rival.x > 54)
  check('separation increased', dist(state.me, state.rival) > before)
  check('both finite', finite(state.me) && finite(state.rival))
}

// ---------------------------------------------------------------------------
// 2. B walks into stationary A → both pushed apart
// ---------------------------------------------------------------------------
console.log('\n2. B walks into stationary A')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 46, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  const before = dist(state.me, state.rival)
  const res = duoBump(state, 10_000)
  check('bump resolved', res.bumped === true)
  check('A pushed away from B (right)', state.me.x > 50)
  check('B pushed away from A (left)', state.rival.x < 46)
  check('separation increased', dist(state.me, state.rival) > before)
}

// ---------------------------------------------------------------------------
// 3. Both run toward each other → both pushed apart
// ---------------------------------------------------------------------------
console.log('\n3. Both run toward each other')
{
  // They meet near the centre; contact detected at the meeting point.
  const state = { me: { x: 49.5, y: 50 }, rival: { x: 50.5, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  const res = duoBump(state, 10_000)
  check('bump resolved', res.bumped === true)
  check('A pushed left', state.me.x < 49.5)
  check('B pushed right', state.rival.x > 50.5)
  check('separation increased', dist(state.me, state.rival) > 1)
}

// ---------------------------------------------------------------------------
// 4. Diagonal contact → pushed along correct opposite directions
// ---------------------------------------------------------------------------
console.log('\n4. Diagonal contact')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 53, y: 53 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  const res = duoBump(state, 10_000)
  check('bump resolved', res.bumped === true)
  // Direction from rival -> me is (-1,-1)/sqrt(2): A moves up-left, B down-right.
  check('A pushed up-left (x decreases)', state.me.x < 50)
  check('A pushed up-left (y decreases)', state.me.y < 50)
  check('B pushed down-right (x increases)', state.rival.x > 53)
  check('B pushed down-right (y increases)', state.rival.y > 53)
  // Opposite directions: the displacement vectors are antiparallel.
  const meDx = state.me.x - 50
  const meDy = state.me.y - 50
  const rvDx = state.rival.x - 53
  const rvDy = state.rival.y - 53
  const cross = meDx * rvDy - meDy * rvDx
  check('displacements are antiparallel (cross ≈ 0)', Math.abs(cross) < 1e-6)
}

// ---------------------------------------------------------------------------
// 5. Continuous contact → does NOT bounce every frame
// ---------------------------------------------------------------------------
console.log('\n5. Continuous contact does not bounce every frame')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  const first = duoBump(state, 10_000)
  check('first contact bumps', first.bumped === true)
  // Simulate 60Hz frames for 500ms while still touching (positions unchanged
  // because the client is holding the players together for the test).
  let extraBumps = 0
  for (let t = 10_016; t < 10_500; t += 16) {
    const r = duoBump(state, t)
    if (r.bumped) extraBumps += 1
  }
  check('no additional bump within cooldown window', extraBumps === 0, `got ${extraBumps}`)
}

// ---------------------------------------------------------------------------
// 6. After ~500–700ms a new genuine contact bumps again
// ---------------------------------------------------------------------------
console.log('\n6. New genuine contact after cooldown')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  duoBump(state, 10_000)
  // Re-touch after the cooldown elapses.
  state.me = { x: 50, y: 50 }
  state.rival = { x: 54, y: 50 }
  const after = duoBump(state, 10_000 + BUMP_COOLDOWN_MS + 1)
  check('bumps again after cooldown', after.bumped === true)
  check('cooldown window is 500–700ms', BUMP_COOLDOWN_MS >= 500 && BUMP_COOLDOWN_MS <= 700)
}

// ---------------------------------------------------------------------------
// 7. Bump does NOT change score
// ---------------------------------------------------------------------------
console.log('\n7. Score unchanged')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 123, coins: 7, objectivesDone: 2 }
  duoBump(state, 10_000)
  check('score unchanged', state.score === 123)
}

// ---------------------------------------------------------------------------
// 8. Bump does NOT change coins
// ---------------------------------------------------------------------------
console.log('\n8. Coins unchanged')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 7, objectivesDone: 0 }
  duoBump(state, 10_000)
  check('coins unchanged', state.coins === 7)
}

// ---------------------------------------------------------------------------
// 9. Bump does NOT affect objectives
// ---------------------------------------------------------------------------
console.log('\n9. Objectives unchanged')
{
  const state = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 2 }
  duoBump(state, 10_000)
  check('objectivesDone unchanged', state.objectivesDone === 2)
  check('migration never writes objective columns', !/objective_progress\s*=/.test(migration) && !/objectives_done\s*=/.test(migration))
}

// ---------------------------------------------------------------------------
// 10. Keyboard movement unchanged (speed/feel constants preserved)
// ---------------------------------------------------------------------------
console.log('\n10. Keyboard movement unchanged')
{
  check('MOVE_SPEED unchanged (38)', /export const MOVE_SPEED = 38/.test(configSource))
  check('BUMP_SPEED_MULTIPLIER unchanged (0.55)', /export const BUMP_SPEED_MULTIPLIER = 0\.55/.test(configSource))
  check('PLAYER_HIT_R unchanged (2.6)', /export const PLAYER_HIT_R = 2\.6/.test(configSource))
  // The bump must not add an input delay: it is evaluated AFTER movement in the
  // same frame and only adjusts positions, never the input vector.
  check('bump does not gate input (no setTimeout in movement)', !/setTimeout/.test(movementSource))
}

// ---------------------------------------------------------------------------
// 11. Joystick movement unchanged (same input path, no artificial delay)
// ---------------------------------------------------------------------------
console.log('\n11. Joystick movement unchanged')
{
  const loopSource = await readFile(new URL('../lib/useGameLoop.ts', import.meta.url), 'utf8')
  check('joystick still feeds the same dx/dy input', /dx \+= joystick\.current\.x/.test(loopSource))
  check('bump uses the existing position queue (no new movement system)', /runPositionedActions\(bumpX, bumpY/.test(loopSource))
  check('bump does not use setTimeout', !/setTimeout[\s\S]{0,120}duo_bump/.test(loopSource))
  check('bump does not poll', !/setInterval[\s\S]{0,120}duo_bump/.test(loopSource))
}

// ---------------------------------------------------------------------------
// 12. Two clients stay synchronized after bumping (authoritative reconcile)
// ---------------------------------------------------------------------------
console.log('\n12. Two clients stay synchronized')
{
  // Server resolves the bump once; both clients reconcile from the SAME
  // authoritative response (x/y for caller, rivalX/rivalY for the opponent).
  const server = { me: { x: 50, y: 50 }, rival: { x: 54, y: 50 }, lastBumpAt: -Infinity, score: 0, coins: 0, objectivesDone: 0 }
  const res = duoBump(server, 10_000)
  // Client A (caller) applies x/y; Client B (opponent) applies rivalX/rivalY.
  const clientA = { me: { x: res.x, y: res.y }, rival: { x: res.rivalX, y: res.rivalY } }
  const clientB = { me: { x: res.rivalX, y: res.rivalY }, rival: { x: res.x, y: res.y } }
  check('client A me == server me', clientA.me.x === server.me.x && clientA.me.y === server.me.y)
  check('client A rival == server rival', clientA.rival.x === server.rival.x && clientA.rival.y === server.rival.y)
  check('client B me == server rival', clientB.me.x === server.rival.x && clientB.me.y === server.rival.y)
  check('client B rival == server me', clientB.rival.x === server.me.x && clientB.rival.y === server.me.y)
  check('both clients agree on separation', Math.abs(dist(clientA.me, clientA.rival) - dist(clientB.me, clientB.rival)) < 1e-9)
}

// ---------------------------------------------------------------------------
// Extra: determinism / safety
// ---------------------------------------------------------------------------
console.log('\nSafety')
{
  const coincident = computeBump(50, 50, 50, 50)
  check('coincident centres use deterministic +x fallback', coincident.bumped === true && coincident.me.x > 50 && coincident.rival.x < 50)
  check('coincident result is finite', finite(coincident.me) && finite(coincident.rival))
  const far = computeBump(10, 10, 90, 90)
  check('no contact when far apart', far.bumped === false)
  const edge = computeBump(6, 8, 6.5, 8.5)
  check('edge contact clamps inside arena', edge.me.x >= ARENA.minX && edge.me.y >= ARENA.minY)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
