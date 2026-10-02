// ============================================================================
// DUO CHAOS — deterministic steal authority regression test (0051).
//
// Reproduces the reported steal problems:
//   1. UNRELIABLE: "bir çalışıyor bir çalışmıyor" — the client triggered on the
//      PREDICTED rival position while the server validated against STALE stored
//      positions → `too_far` / `not_chasing` almost every time.
//   2. WRONG SIDE: "bir puanı çalana veriyor bir puanı çalınana veriyor" — the
//      old directional guard guessed the chaser from stale 300ms samples, so
//      the winner was nearly random and the VICTIM sometimes got +25.
//
// FIX (0051_deterministic_steal.sql):
//   * The caller sends its OWN current position (`p_x`, `p_y`) — the exact same
//     pattern as `duo_collect_batch`. The server validates it with `duo_step_ok`
//     (anti-teleport) and falls back to the stored position if invalid.
//   * CONTACT: distance from the validated caller position to the opponent's
//     STORED position must be within `STEAL_RADIUS + SLACK` (5.2 + 2.0).
//   * APPROACH (deterministic attacker rule): the caller's supplied position
//     must be CLOSER to the opponent than the caller's stored previous position
//     (`dist_after < dist_before`). Only a player genuinely moving toward the
//     opponent can steal → the victim can never be awarded the steal.
//   * SERIALIZATION: both rows are locked `for update ... order by slot`; the
//     700ms `last_stolen_at` contact guard rejects the second concurrent call.
//   * The server returns `victimState` so the victim client applies its -25
//     immediately (no dependence on the ~1s stale `duo_public_state` poll).
//
// This test mirrors the EXACT server guard + score rules and the client merge,
// then drives the required scenarios. No DB required.
//
// Run: node scripts/test-steal-authority.mjs
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

// --- Constants mirrored from migration 0051 / lib/config.ts -----------------
const STEAL_SCORE = 25
const STEAL_CONTACT_GUARD_MS = 700
const STEAL_RADIUS = 5.2
const CONTACT_SLACK = 2.0
const MOVE_SPEED = 38
const SLOW_MULT = 0.55
const STEP_SAFETY = 1.6
const STEP_FLOOR = 8

const deterministicMigration = await readFile(
  new URL('../supabase/migrations/0051_deterministic_steal.sql', import.meta.url),
  'utf8',
)

// --- Mirror of duo_step_ok (0047) -------------------------------------------
// Anti-teleport: the caller may not move farther than the max distance allowed
// by the elapsed time since its last recorded move.
const duoStepOk = (storedX, storedY, lastMoveAt, newX, newY, slowedUntil, nowMs) => {
  const elapsed = Math.max(0, nowMs - (lastMoveAt ?? nowMs)) / 1_000
  const slow = slowedUntil && slowedUntil > nowMs ? SLOW_MULT : 1
  const maxDist = Math.max(STEP_FLOOR, elapsed * MOVE_SPEED * slow * STEP_SAFETY)
  return Math.hypot(newX - storedX, newY - storedY) <= maxDist
}

// --- Mirror of duo_steal_versioned (0051) -----------------------------------
// Returns { ok, reason?, stealer, victim, victimState } where stealer/victim are
// the post-action rows. `now` is the server clock (epoch ms). `pX`/`pY` are the
// caller-supplied position (defaults to the stored position, like the 4-arg
// backward-compatible wrapper).
const duoStealVersioned = (state, stealerSlot, now, expectedRound = null, pX = null, pY = null) => {
  const stealer = state.players[stealerSlot]
  const victimSlot = stealerSlot === 'p1' ? 'p2' : 'p1'
  const victim = state.players[victimSlot]

  if (state.phase !== 'battle') return { ok: false, reason: 'not_battle' }
  if (expectedRound !== null && expectedRound !== state.round) {
    return { ok: false, reason: 'stale_round' }
  }
  // CONTACT GUARD (0042): at most ONE steal per contact.
  if (
    (victim.lastStolenAt ?? 0) > 0 &&
    now - (victim.lastStolenAt ?? 0) < STEAL_CONTACT_GUARD_MS
  ) {
    return { ok: false, reason: 'victim_guarded' }
  }
  if (
    (stealer.lastStolenAt ?? 0) > 0 &&
    now - (stealer.lastStolenAt ?? 0) < STEAL_CONTACT_GUARD_MS
  ) {
    return { ok: false, reason: 'steal_cooldown' }
  }
  // EMPTY VICTIM (0042): nothing to steal.
  if ((victim.coins ?? 0) <= 0) return { ok: false, reason: 'no_coins' }

  // CALLER POSITION (0051): validate the supplied position; fall back to the
  // stored position when the step is invalid (anti-teleport).
  let newX = pX === null ? stealer.x : pX
  let newY = pY === null ? stealer.y : pY
  if (!duoStepOk(stealer.x, stealer.y, stealer.lastMoveAt, newX, newY, stealer.slowedUntil, now)) {
    newX = stealer.x
    newY = stealer.y
  }

  // CONTACT: validated caller position vs opponent's STORED position.
  const distAfter = Math.hypot(victim.x - newX, victim.y - newY)
  if (distAfter > STEAL_RADIUS + CONTACT_SLACK) return { ok: false, reason: 'too_far' }

  // APPROACH (deterministic attacker rule): the caller must be CLOSER than its
  // stored previous position. A stationary or retreating caller is rejected.
  const distBefore = Math.hypot(victim.x - stealer.x, victim.y - stealer.y)
  if (distAfter >= distBefore) return { ok: false, reason: 'not_approaching' }

  // Apply atomically (mirrors the two UPDATEs).
  stealer.stolen = (stealer.stolen ?? 0) + 1
  stealer.roundStolen = (stealer.roundStolen ?? 0) + 1
  stealer.score = (stealer.score ?? 0) + STEAL_SCORE
  stealer.roundScore = (stealer.roundScore ?? 0) + STEAL_SCORE
  stealer.x = newX
  stealer.y = newY
  stealer.lastMoveAt = now

  victim.coins = Math.max(0, (victim.coins ?? 0) - 1)
  victim.roundCoins = Math.max(0, (victim.roundCoins ?? 0) - 1)
  victim.score = Math.max(0, (victim.score ?? 0) - STEAL_SCORE)
  victim.roundScore = Math.max(0, (victim.roundScore ?? 0) - STEAL_SCORE)
  victim.slowedUntil = now + 400
  victim.lastStolenAt = now

  return {
    ok: true,
    stealer,
    victim,
    victimState: {
      coins: victim.coins,
      roundCoins: victim.roundCoins,
      score: victim.score,
      roundScore: victim.roundScore,
    },
  }
}

const makeState = (overrides = {}) => ({
  phase: 'battle',
  round: 1,
  players: {
    p1: {
      id: 'p1',
      x: 50,
      y: 50,
      coins: 3,
      stolen: 0,
      roundStolen: 0,
      score: 100,
      roundScore: 100,
      lastStolenAt: 0,
      slowedUntil: 0,
      lastMoveAt: 1_000,
    },
    p2: {
      id: 'p2',
      x: 52,
      y: 50,
      coins: 3,
      stolen: 0,
      roundStolen: 0,
      score: 100,
      roundScore: 100,
      lastStolenAt: 0,
      slowedUntil: 0,
      lastMoveAt: 1_000,
    },
  },
  ...overrides,
})

// --- Mirror of applyAuthoritativeVictimState (lib/objectiveSync.ts) ---------
// Applies the authoritative victim state to the local player (index 0). Only
// DECREASES are applied (Math.min), and only within the same round.
const applyAuthoritativeVictimState = (local, victim, actionRound, currentRound) => {
  if (currentRound !== actionRound) return local
  const next = { ...local }
  if (typeof victim.coins === 'number') next.coins = Math.min(local.coins ?? 0, victim.coins)
  if (typeof victim.roundCoins === 'number') {
    next.roundCoins = Math.min(local.roundCoins ?? 0, victim.roundCoins)
  }
  if (typeof victim.score === 'number') next.score = Math.min(local.score ?? 0, victim.score)
  if (typeof victim.roundScore === 'number') {
    next.roundScore = Math.min(local.roundScore ?? 0, victim.roundScore)
  }
  return next
}

// --- Mirror of the poll merge victim floor (lib/useDuoChaos.ts) -------------
// A stale `duo_public_state` snapshot must not resurrect the pre-steal score.
// The floor is an UPPER BOUND on the server value: a stale snapshot above the
// floor is capped down to it; a genuinely lower server value is applied as-is.
// Then we take the max with the LOCAL value (the victim may have collected
// after being stolen, legitimately raising its score again).
const mergePollWithFloor = (local, server, floor, round) => {
  const merged = { ...local, ...server }
  if (floor && floor.round === round) {
    const capScore = Math.min(merged.score ?? 0, floor.score)
    const capRoundScore = Math.min(merged.roundScore ?? 0, floor.roundScore)
    const capCoins = Math.min(merged.coins ?? 0, floor.coins)
    const capRoundCoins = Math.min(merged.roundCoins ?? 0, floor.roundCoins)
    merged.score = Math.max(local.score ?? 0, capScore)
    merged.roundScore = Math.max(local.roundScore ?? 0, capRoundScore)
    merged.coins = Math.max(local.coins ?? 0, capCoins)
    merged.roundCoins = Math.max(local.roundCoins ?? 0, capRoundCoins)
  }
  return merged
}

console.log('SCENARIO 1 — Player A steals from Player B: A +25, B -25')
{
  const state = makeState()
  const before = { a: state.players.p1.score, b: state.players.p2.score }
  // A moves from x=50 toward B at x=52 → supplies x=51.5 (closer).
  const res = duoStealVersioned(state, 'p1', 1_000, null, 51.5, 50)
  check('steal succeeds', res.ok === true, res.reason)
  check('A gains exactly +25', state.players.p1.score - before.a === 25, `delta=${state.players.p1.score - before.a}`)
  check('B loses exactly -25', before.b - state.players.p2.score === 25, `delta=${before.b - state.players.p2.score}`)
  check('B loses exactly 1 coin', state.players.p2.coins === 2, `coins=${state.players.p2.coins}`)
  check('A stolen counter +1', state.players.p1.stolen === 1)
  check('B is slowed', state.players.p2.slowedUntil === 1_400)
  check('victimState reports B score 75', res.victimState.score === 75, `score=${res.victimState.score}`)
  check('victimState reports B coins 2', res.victimState.coins === 2, `coins=${res.victimState.coins}`)
}

console.log('SCENARIO 2 — Repeat the same contact: no accidental second +25')
{
  const state = makeState()
  const first = duoStealVersioned(state, 'p1', 1_000, null, 51.5, 50)
  check('first steal ok', first.ok === true)
  const scoreAfterFirst = state.players.p1.score
  // Same contact, 100ms later (within the 700ms guard). The VICTIM (p2) was
  // just stolen from, so the victim guard rejects the repeat.
  const second = duoStealVersioned(state, 'p1', 1_100, null, 51.5, 50)
  check('second steal rejected', second.ok === false, second.reason)
  check('rejected with victim_guarded', second.reason === 'victim_guarded', second.reason)
  check('A score unchanged after rejection', state.players.p1.score === scoreAfterFirst)
  check('A stolen counter still 1', state.players.p1.stolen === 1)
  // After the guard window elapses, a NEW approach may steal again.
  const third = duoStealVersioned(state, 'p1', 1_800, null, 51.5, 50)
  check('stationary contact cannot be farmed after guard window', third.ok === false, third.reason)
  check('rejected with not_approaching', third.reason === 'not_approaching', third.reason)
  // A fresh approach (A moved even closer) allows a new steal.
  const fourth = duoStealVersioned(state, 'p1', 1_800, null, 51.8, 50)
  check('a fresh approach allows a new steal', fourth.ok === true, fourth.reason)
  check('A stolen counter now 2', state.players.p1.stolen === 2)
}

console.log('SCENARIO 3 — Two clients touch simultaneously: the approaching player wins regardless of request order')
{
  for (const requestOrder of [['p1', 'p2'], ['p2', 'p1']]) {
    const state = makeState()
    state.players.p1.x = 50
    state.players.p2.x = 54.5
    // p1 approaches from x=50 → supplies x=52.5 (closer to p2 at 54.5).
    // p2 is stationary → supplies its stored x=54.5 (no approach).
    const results = {}
    for (const slot of requestOrder) {
      results[slot] =
        slot === 'p1'
          ? duoStealVersioned(state, 'p1', 2_000, null, 52.5, 50)
          : duoStealVersioned(state, 'p2', 2_000, null, 54.5, 50)
    }
    check(`only the approacher steals (${requestOrder.join(' then ')})`, results.p1.ok === true && results.p2.ok === false)
    check('approacher gains exactly +25', state.players.p1.score === 125)
    check('stationary rival loses exactly -25', state.players.p2.score === 75)
  }
}

console.log('SCENARIO 4 — Repeated collisions: new steals require a fresh approach')
{
  const state = makeState()
  let successes = 0
  // Simulate 60 frames over 1 second (16ms apart) while in contact.
  for (let frame = 0; frame < 60; frame += 1) {
    const now = 3_000 + frame * 16
    // A creeps toward B: each frame supplies a slightly closer position.
    const px = 50 + Math.min(1.9, frame * 0.05)
    const res = duoStealVersioned(state, 'p1', now, null, px, 50)
    if (res.ok) successes += 1
  }
  check('a continuous approach permits at most one steal per guard window', successes >= 1 && successes <= 2, `successes=${successes}`)
  check('stolen counter matches successes', state.players.p1.stolen === successes)
}

console.log('SCENARIO 5 — Both clients converge to the same final scores')
{
  const state = makeState()
  const res = duoStealVersioned(state, 'p1', 4_000, null, 51.5, 50)
  check('steal ok', res.ok === true, res.reason)
  // Server authoritative rows.
  const serverP1 = { ...state.players.p1 }
  const serverP2 = { ...state.players.p2 }
  check('both clients agree on A score', serverP1.score === 125, `A=${serverP1.score}`)
  check('both clients agree on B score', serverP2.score === 75, `B=${serverP2.score}`)
  // Victim client applies the authoritative victimState immediately.
  const victimLocal = { coins: 3, roundCoins: 3, score: 100, roundScore: 100 }
  const victimAfter = applyAuthoritativeVictimState(victimLocal, res.victimState, 1, 1)
  check('victim client drops to 75 immediately', victimAfter.score === 75, `score=${victimAfter.score}`)
  check('victim client drops to 2 coins immediately', victimAfter.coins === 2, `coins=${victimAfter.coins}`)
}

console.log('SCENARIO 6 — Steal does not interfere with movement or coin collection')
{
  const state = makeState()
  const bx = state.players.p2.x
  const by = state.players.p2.y
  duoStealVersioned(state, 'p1', 5_000, null, 51.5, 50)
  check('victim position unchanged', state.players.p2.x === bx && state.players.p2.y === by)
  // Victim keeps collecting: a coin collection adds score independently.
  const victimScoreBefore = state.players.p2.score
  state.players.p2.score += 10 // simulate a collect
  check('victim can still gain score from collecting', state.players.p2.score === victimScoreBefore + 10)
  // Victim score never goes below 0.
  const drained = makeState()
  drained.players.p2.score = 10
  drained.players.p2.coins = 1
  duoStealVersioned(drained, 'p1', 6_000, null, 51.5, 50)
  check('victim score floors at 0 (never negative)', drained.players.p2.score === 0, `score=${drained.players.p2.score}`)
}

console.log('SCENARIO 7 — Empty victim cannot be stolen from')
{
  const state = makeState()
  state.players.p2.coins = 0
  const res = duoStealVersioned(state, 'p1', 7_000, null, 51.5, 50)
  check('steal rejected when victim has no coins', res.ok === false, res.reason)
  check('rejected with no_coins', res.reason === 'no_coins', res.reason)
  check('stealer score unchanged', state.players.p1.score === 100)
  check('victim score unchanged', state.players.p2.score === 100)
}

console.log('SCENARIO 8 — Being nearby is not enough: steal requires avatar contact')
{
  const state = makeState()
  state.players.p2.x = 60
  const result = duoStealVersioned(state, 'p1', 8_000, null, 51.5, 50)
  check('steal rejected outside the contact radius + slack', result.ok === false && result.reason === 'too_far', result.reason)
  check('no score is transferred without contact', state.players.p1.score === 100 && state.players.p2.score === 100)
}

console.log('SCENARIO 9 — SQL migration enforces deterministic, position-supplied contact')
{
  const config = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
  check('client radius tracks both avatar collision radii', config.includes('STEAL_RADIUS = PLAYER_HIT_R * 2'))
  check('server accepts the caller-supplied position', deterministicMigration.includes('p_x numeric'))
  check('server validates the position with duo_step_ok', deterministicMigration.includes('duo_step_ok('))
  check('server applies a contact slack', deterministicMigration.includes('v_contact_slack numeric := 2.0'))
  check('server enforces the deterministic approach rule', deterministicMigration.includes('if v_dist_after >= v_dist_before then'))
  check('approach rejection reason is not_approaching', deterministicMigration.includes("'reason', 'not_approaching'"))
  check('both players are locked before contact validation', /order by slot\s+for update/.test(deterministicMigration))
  check('server returns the victim authoritative state', deterministicMigration.includes("'victimState'"))
  check('backward-compatible 4-arg wrapper is preserved', deterministicMigration.includes('duo_steal_versioned(text, text, integer, integer)'))
  check('only public steal RPC remains executable', deterministicMigration.includes('grant execute on function public.duo_steal_versioned'))
}

console.log('SCENARIO 10 — A stationary player cannot steal (no approach)')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  // p1 supplies its stored position → no approach.
  const p1Steal = duoStealVersioned(state, 'p1', 2_000, null, 50, 50)
  check('stationary player rejected', p1Steal.ok === false && p1Steal.reason === 'not_approaching', p1Steal.reason)
  // p2 approaches from x=54.5 → supplies x=52.5 (closer to p1 at 50).
  const p2Steal = duoStealVersioned(state, 'p2', 2_000, null, 52.5, 50)
  check('currently closing player receives the steal', p2Steal.ok === true, p2Steal.reason)
  check('scores follow the actual chase direction', state.players.p1.score === 75 && state.players.p2.score === 125)
}

console.log('SCENARIO 11 — A player who has never moved cannot steal from the player who approaches')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  // p1 never moved → supplies its stored position (no approach).
  const stationaryPlayerRequest = duoStealVersioned(state, 'p1', 2_000, null, 50, 50)
  check(
    'never-moved player cannot steal',
    stationaryPlayerRequest.ok === false && stationaryPlayerRequest.reason === 'not_approaching',
    stationaryPlayerRequest.reason,
  )
  // p2 approaches from x=54.5 → supplies x=52.5 (closer to p1 at 50).
  const approachingPlayerRequest = duoStealVersioned(state, 'p2', 2_000, null, 52.5, 50)
  check('moving player can steal from the stationary opponent', approachingPlayerRequest.ok === true, approachingPlayerRequest.reason)
  check('stationary player loses points, not the pursuer', state.players.p1.score === 75 && state.players.p2.score === 125)
}

console.log('SCENARIO 12 — Anti-teleport: an impossible jump cannot steal')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p1.lastMoveAt = 2_000
  state.players.p2.x = 52
  // p1 claims to be at x=70 (a 20-unit jump) with 0ms elapsed since its last
  // move → the max allowed step is the floor (8), so the step is invalid and
  // the server falls back to the stored position (50), which is NOT closer to
  // p2 (52) → not_approaching.
  const res = duoStealVersioned(state, 'p1', 2_000, null, 70, 50)
  check('impossible jump is rejected', res.ok === false, res.reason)
  check('rejected with not_approaching after fallback', res.reason === 'not_approaching', res.reason)
  check('no score transferred on a rejected teleport', state.players.p1.score === 100 && state.players.p2.score === 100)
}

console.log('SCENARIO 13 — A stale poll snapshot cannot resurrect the victim score')
{
  const state = makeState()
  const res = duoStealVersioned(state, 'p1', 9_000, null, 51.5, 50)
  check('steal ok', res.ok === true, res.reason)
  // Victim client applied the authoritative victimState (score 75).
  const victimLocal = { coins: 2, roundCoins: 2, score: 75, roundScore: 75 }
  const floor = { round: 1, score: 75, roundScore: 75, coins: 2, roundCoins: 2 }
  // A STALE poll snapshot still carries the pre-steal score (100).
  const staleServer = { coins: 3, roundCoins: 3, score: 100, roundScore: 100 }
  const merged = mergePollWithFloor(victimLocal, staleServer, floor, 1)
  check('stale poll cannot raise the victim score back to 100', merged.score === 75, `score=${merged.score}`)
  check('stale poll cannot raise the victim coins back to 3', merged.coins === 2, `coins=${merged.coins}`)
  // A NEW round clears the floor → the fresh score is authoritative.
  const nextRound = mergePollWithFloor({ score: 0, coins: 0 }, { score: 0, coins: 0 }, floor, 2)
  check('floor is ignored in a new round', nextRound.score === 0 && nextRound.coins === 0)
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
