// ============================================================================
// DUO CHAOS — server-side position authority test (migration 0047).
//
// Reproduces the audit findings:
//   D. `duo_collect_batch` trusted the CLIENT-supplied (p_x, p_y) for the
//      collection distance check → a cheating client could collect any coin on
//      the map by passing its coordinates.
//   E. `duo_move` accepted ANY position with only arena clamping → teleport.
//
// FIX (0047):
//   * `duo_step_ok(...)` validates that a requested position is reachable from
//     the last SERVER-STORED position within the elapsed time, using the real
//     movement speed (38 %/s), the bump-slow multiplier (0.55) and a generous
//     safety factor (1.6) + floor (8).
//   * `duo_move` rejects unreachable steps with `reason = 'too_fast'` and
//     returns the authoritative stored position.
//   * `duo_collect_batch` validates the client position the same way; if the
//     step is invalid it uses the SERVER-STORED position for the distance
//     check, so a lying client cannot collect a remote coin.
//
// This test mirrors the EXACT server logic and drives the required scenarios.
// No DB required.
//
// Run: node scripts/test-position-authority.mjs
// ============================================================================

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

// --- Constants mirrored from migration 0047 / lib/config.ts -----------------
const MOVE_SPEED = 38 // arena-% per second
const BUMP_SPEED_MULTIPLIER = 0.55
const STEP_SAFETY = 1.6
const STEP_FLOOR = 8
const COLLECT_RADIUS = 9

// --- Mirror of duo_step_ok (0048) -------------------------------------------
// NOTE: 0048 keys the movement clock on `lastMoveAt` (a DEDICATED column),
// NOT on `lastSeenAt` (the liveness heartbeat that `duo_public_state` refreshes
// on every poll). Using `lastSeenAt` caused legitimate moves to be rejected
// whenever a poll landed between two moves.
const duoStepOk = (storedX, storedY, lastMoveAtMs, newX, newY, slowedUntil, nowMs) => {
  if (lastMoveAtMs === null || lastMoveAtMs === undefined) return true
  const elapsedMs = Math.max(0, nowMs - lastMoveAtMs)
  let speed = MOVE_SPEED
  if (slowedUntil !== null && slowedUntil !== undefined && slowedUntil > nowMs) {
    speed *= BUMP_SPEED_MULTIPLIER
  }
  const maxStep = speed * (elapsedMs / 1000) * STEP_SAFETY + STEP_FLOOR
  const dist = Math.hypot(newX - storedX, newY - storedY)
  return dist <= maxStep
}

// --- Mirror of duo_move (0048) ----------------------------------------------
const duoMove = (player, newX, newY, nowMs) => {
  const ok = duoStepOk(player.x, player.y, player.lastMoveAt, newX, newY, player.slowedUntil, nowMs)
  if (!ok) {
    return { ok: false, reason: 'too_fast', x: player.x, y: player.y }
  }
  player.x = newX
  player.y = newY
  player.lastMoveAt = nowMs
  player.lastSeenAt = nowMs
  return { ok: true, x: newX, y: newY }
}

// --- Mirror of duo_collect_batch position handling (0048) -------------------
// Returns the position used for the distance check.
const collectPosition = (player, clientX, clientY, nowMs) => {
  const stepOk = duoStepOk(player.x, player.y, player.lastMoveAt, clientX, clientY, player.slowedUntil, nowMs)
  if (stepOk) {
    player.x = clientX
    player.y = clientY
    player.lastMoveAt = nowMs
    player.lastSeenAt = nowMs
    return { x: clientX, y: clientY, trusted: true }
  }
  // Fall back to the SERVER-STORED position — never trust the client payload.
  return { x: player.x, y: player.y, trusted: false }
}

const collectCoin = (player, coin, clientX, clientY, nowMs) => {
  const pos = collectPosition(player, clientX, clientY, nowMs)
  const dist = Math.hypot(coin.x - pos.x, coin.y - pos.y)
  return { accepted: dist <= COLLECT_RADIUS, dist, pos }
}

console.log('\n=== 1. Legitimate movement is accepted ===')
{
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  // One 16ms frame at 38 %/s ≈ 0.61 units.
  const r = duoMove(p, 18.6, 50, 1_000_016)
  check('single 16ms frame accepted', r.ok === true, JSON.stringify(r))
  check('position updated', p.x === 18.6 && p.y === 50)
  check('last_move_at advanced', p.lastMoveAt === 1_000_016)
}

console.log('\n=== 2. Legitimate batched movement (queue coalescing) is accepted ===')
{
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  // 500ms of movement at full speed ≈ 19 units; safety 1.6 + floor 8 → ~38.4.
  const r = duoMove(p, 37, 50, 1_000_500)
  check('500ms batch accepted', r.ok === true, JSON.stringify(r))
}

console.log('\n=== 3. Diagonal movement is accepted ===')
{
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  // 200ms diagonal: 38*0.2*sqrt(2) ≈ 10.75 units; max = 38*0.2*1.6+8 = 20.16.
  const r = duoMove(p, 18 + 7.6, 50 + 7.6, 1_000_200)
  check('200ms diagonal accepted', r.ok === true, JSON.stringify(r))
}

console.log('\n=== 4. Teleport is REJECTED (finding E) ===')
{
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  // Jump across the arena in a single 16ms frame.
  const r = duoMove(p, 82, 50, 1_000_016)
  check('teleport rejected', r.ok === false && r.reason === 'too_fast', JSON.stringify(r))
  check('authoritative position returned', r.x === 18 && r.y === 50)
  check('stored position NOT mutated', p.x === 18 && p.y === 50)
}

console.log('\n=== 5. Remote collection is REJECTED (finding D) ===')
{
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  const coin = { id: 1, x: 82, y: 50 } // far away
  // Cheating client claims it is standing on the coin.
  const r = collectCoin(p, coin, 82, 50, 1_000_016)
  check('remote collect rejected', r.accepted === false, JSON.stringify(r))
  check('distance measured from server position', r.pos.trusted === false)
  check('server position unchanged', p.x === 18 && p.y === 50)
}

console.log('\n=== 6. Legitimate collection still works ===')
{
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  const coin = { id: 2, x: 20, y: 50 } // 2 units away
  const r = collectCoin(p, coin, 19.5, 50, 1_000_016)
  check('nearby collect accepted', r.accepted === true, JSON.stringify(r))
  check('client position trusted', r.pos.trusted === true)
}

console.log('\n=== 7. Bump-slow reduces the allowed step ===')
{
  // 400ms elapsed: full-speed allowance = 38*0.4*1.6+8 = 32.32;
  // slowed allowance = 38*0.55*0.4*1.6+8 = 21.376.
  // A 25-unit step therefore fits at full speed but NOT while slowed.
  const now = 1_000_400
  const fast = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  const slow = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: now + 400 }
  const target = 18 + 25 // 25 units in 400ms
  const rFast = duoMove(fast, target, 50, now)
  const rSlow = duoMove(slow, target, 50, now)
  check('full-speed 25u/400ms accepted', rFast.ok === true, JSON.stringify(rFast))
  check('slowed 25u/400ms rejected', rSlow.ok === false, JSON.stringify(rSlow))
}

console.log('\n=== 8. Round-reset / reconnect (stale last_move_at) is accepted ===')
{
  // After a round reset the stored position is the spawn and last_move_at is
  // old (seconds ago). The elapsed-time allowance must permit the move.
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  const r = duoMove(p, 82, 50, 1_005_000) // 5s later
  check('post-reset move accepted', r.ok === true, JSON.stringify(r))
}

console.log('\n=== 9. First move (null last_move_at) is accepted ===')
{
  const p = { x: 18, y: 50, lastMoveAt: null, lastSeenAt: 1_000_000, slowedUntil: 0 }
  const r = duoMove(p, 82, 50, 1_000_016)
  check('first move accepted', r.ok === true, JSON.stringify(r))
}

console.log('\n=== 10. REGRESSION: a poll between moves must NOT block movement (0048) ===')
{
  // Reproduces the 0047 regression: `duo_public_state` refreshes `last_seen_at`
  // on every poll (~1s). With the OLD clock (last_seen_at) a poll landing
  // between two moves shrank the elapsed window and rejected the next move.
  // With the dedicated `last_move_at` clock the poll is irrelevant.
  const p = { x: 18, y: 50, lastMoveAt: 1_000_000, lastSeenAt: 1_000_000, slowedUntil: 0 }
  // Legitimate 16ms frame.
  const r1 = duoMove(p, 18.6, 50, 1_000_016)
  check('first frame accepted', r1.ok === true, JSON.stringify(r1))
  // A poll lands 5ms later and refreshes ONLY last_seen_at (not last_move_at).
  p.lastSeenAt = 1_000_021
  // The next legitimate frame moves 12 units (a fast-but-legal 16ms step is
  // ~0.6u, so 12u represents a coalesced/batched frame). With the dedicated
  // clock the elapsed window is 32ms → allowance 38*0.032*1.6+8 = 9.95 … still
  // under 12, so use a 400ms window instead to make the contrast unambiguous.
  const r2 = duoMove(p, 18.6 + 12, 50, 1_000_400)
  check('move after poll accepted (dedicated clock)', r2.ok === true, JSON.stringify(r2))
  // Sanity: with the OLD clock (last_seen_at refreshed by the poll at 1_000_021)
  // the SAME move over the SAME 400ms window is measured from 1_000_021 → 379ms
  // … which still passes. The regression is only visible when the poll lands
  // IMMEDIATELY before the move, so model that precisely:
  const oldClockOk = duoStepOk(18.6, 50, 1_000_399, 18.6 + 12, 50, 0, 1_000_400)
  check('old last_seen_at clock would have rejected it', oldClockOk === false)
}

console.log(`\n${failed === 0 ? '\u2714 ALL PASSED' : '\u2718 FAILURES'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
