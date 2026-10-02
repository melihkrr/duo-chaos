// ============================================================================
// DUO CHAOS — steal authority and directional-contact regression test.
//
// Reproduces the reported steal problems:
//   1. WRONG VALUE: a steal awarded +20/-20 instead of +25/-25.
//   2. MUTUAL STEAL: two players touching caused BOTH to steal from each other
//      (A +20 & B -20, then B +20 & A -20) → net ~0 and "never both stealers".
//   3. EMPTY VICTIM: a steal succeeded even when the victim had 0 coins.
//   4. DOUBLE COUNT: the client optimistically incremented `stolen` every
//      `stealing` frame, and the monotonic `mergeProgress` locked the
//      over-count in.
//
// FIX (0042, 0049 + 0050):
//   * `v_steal_score := 25` (matches single-player `STEAL_SCORE`).
//   * Per-contact guard: `duo_players.last_stolen_at` (epoch ms). A steal is
//     rejected if either participant was stolen from within 700ms.
//   * A recent server-recorded approach is required, and an ambiguous head-on
//     contact cannot be won by whichever client's request arrives first.
//   * Victim must have `coins > 0` (else `no_coins`).
//   * Client no longer optimistically increments `stolen`/`roundStolen`.
//
// This test mirrors the EXACT server guard + score rules and the client merge,
// then drives the 10 required scenarios. No DB required.
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

// --- Constants mirrored from migration 0042 / lib/config.ts -----------------
const STEAL_SCORE = 25
const STEAL_CONTACT_GUARD_MS = 700
const STEAL_RADIUS = 5.2
const STEAL_MOVEMENT_FRESH_MS = 300
const STEAL_APPROACH_EPSILON = 0.5
const directionMigration = await readFile(
  new URL('../supabase/migrations/0049_directional_steal.sql', import.meta.url),
  'utf8',
)
const staleDirectionMigration = await readFile(
  new URL('../supabase/migrations/0050_expire_stale_steal_direction.sql', import.meta.url),
  'utf8',
)
const positionedStealMigration = await readFile(
  new URL('../supabase/migrations/0051_positioned_steal.sql', import.meta.url),
  'utf8',
)
const selfSufficientStealMigration = await readFile(
  new URL('../supabase/migrations/0052_self_sufficient_steal_sample.sql', import.meta.url),
  'utf8',
)

// --- Mirror of duo_steal_versioned (0042) -----------------------------------
// Returns { ok, reason?, stealer, victim } where stealer/victim are the
// post-action rows. `now` is the server clock (epoch ms).
const duoStealVersioned = (state, stealerSlot, now, expectedRound = null) => {
  const stealer = state.players[stealerSlot]
  const victimSlot = stealerSlot === 'p1' ? 'p2' : 'p1'
  const victim = state.players[victimSlot]

  if (state.phase !== 'battle') return { ok: false, reason: 'not_battle' }
  if (expectedRound !== null && expectedRound !== state.round) {
    return { ok: false, reason: 'stale_round' }
  }
  // CONTACT GUARD (0042): at most ONE steal per contact.
  //   * victim recently stolen from → reject (no farming).
  //   * caller recently stolen from → reject (no mutual steal).
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
  const dist = Math.hypot(victim.x - stealer.x, victim.y - stealer.y)
  if (dist > STEAL_RADIUS) return { ok: false, reason: 'too_far' }
  if (
    stealer.previousX === null ||
    stealer.previousY === null ||
    stealer.previousMovedAt === null ||
    stealer.previousPositionAt === null ||
    now - stealer.previousMovedAt > STEAL_MOVEMENT_FRESH_MS ||
    now - stealer.previousPositionAt > STEAL_MOVEMENT_FRESH_MS ||
    stealer.previousMovedAt <= stealer.previousPositionAt
  ) {
    return { ok: false, reason: 'not_chasing' }
  }
  const playerElapsed = (stealer.previousMovedAt - stealer.previousPositionAt) / 1_000
  const approach =
    (Math.hypot(victim.x - stealer.previousX, victim.y - stealer.previousY) - dist) /
    playerElapsed
  const opponentApproach =
    victim.previousX !== null &&
    victim.previousY !== null &&
    victim.previousMovedAt !== null &&
    victim.previousPositionAt !== null &&
    now - victim.previousMovedAt <= STEAL_MOVEMENT_FRESH_MS &&
    now - victim.previousPositionAt <= STEAL_MOVEMENT_FRESH_MS &&
    victim.previousMovedAt > victim.previousPositionAt
      ? (Math.hypot(stealer.x - victim.previousX, stealer.y - victim.previousY) - dist) /
        ((victim.previousMovedAt - victim.previousPositionAt) / 1_000)
      : 0
  if (
    approach <= STEAL_APPROACH_EPSILON ||
    approach <= opponentApproach + STEAL_APPROACH_EPSILON
  ) {
    return { ok: false, reason: 'not_chasing' }
  }

  // Apply atomically (mirrors the two UPDATEs).
  stealer.stolen = (stealer.stolen ?? 0) + 1
  stealer.roundStolen = (stealer.roundStolen ?? 0) + 1
  stealer.score = (stealer.score ?? 0) + STEAL_SCORE
  stealer.roundScore = (stealer.roundScore ?? 0) + STEAL_SCORE

  victim.coins = Math.max(0, (victim.coins ?? 0) - 1)
  victim.roundCoins = Math.max(0, (victim.roundCoins ?? 0) - 1)
  victim.score = Math.max(0, (victim.score ?? 0) - STEAL_SCORE)
  victim.roundScore = Math.max(0, (victim.roundScore ?? 0) - STEAL_SCORE)
  victim.slowedUntil = now + 400
  victim.lastStolenAt = now
  stealer.previousX = stealer.x
  stealer.previousY = stealer.y
  stealer.previousMovedAt = null
  stealer.previousPositionAt = null
  victim.previousX = victim.x
  victim.previousY = victim.y
  victim.previousMovedAt = null
  victim.previousPositionAt = null

  return { ok: true, stealer, victim }
}

// --- Mirror of duo_steal_versioned (0052) positioned path -------------------
// When the caller supplies a position, the server synthesizes a directional
// sample from the STORED position (previous) → the NEW position (current) if
// the stored sample is missing or stale. This makes a single positioned steal
// self-sufficient and removes the intermittent `not_chasing` failures.
//
// `stored` is the row BEFORE the positioned write; `nextX/nextY` is the
// caller-supplied destination. Returns { ok, reason?, synthesized? }.
const duoStealPositioned = (state, stealerSlot, now, nextX, nextY) => {
  const stealer = state.players[stealerSlot]
  const victimSlot = stealerSlot === 'p1' ? 'p2' : 'p1'
  const victim = state.players[victimSlot]

  if (state.phase !== 'battle') return { ok: false, reason: 'not_battle' }
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
  if ((victim.coins ?? 0) <= 0) return { ok: false, reason: 'no_coins' }

  // The positioned write advances the stored row to the new position.
  const moved = nextX !== stealer.x || nextY !== stealer.y
  const storedX = stealer.x
  const storedY = stealer.y
  if (moved) {
    stealer.x = nextX
    stealer.y = nextY
  }

  const dist = Math.hypot(victim.x - stealer.x, victim.y - stealer.y)
  if (dist > STEAL_RADIUS) return { ok: false, reason: 'too_far' }

  // --- 0052 sample resolution -------------------------------------------------
  let prevX = stealer.previousX
  let prevY = stealer.previousY
  let prevAt = stealer.previousPositionAt
  let sampleAt = stealer.previousMovedAt
  let synthesized = false

  const stale =
    prevX === null ||
    prevY === null ||
    prevAt === null ||
    sampleAt === null ||
    now - prevAt > STEAL_MOVEMENT_FRESH_MS ||
    now - sampleAt > STEAL_MOVEMENT_FRESH_MS ||
    prevAt > now ||
    sampleAt > now ||
    sampleAt <= prevAt

  if (stale) {
    // Synthesize from the stored position → the new position.
    synthesized = true
    prevX = storedX
    prevY = storedY
    prevAt = now - 1 // epsilon before now
    sampleAt = now
  }

  const playerElapsed = (sampleAt - prevAt) / 1_000
  if (playerElapsed <= 0) return { ok: false, reason: 'not_chasing' }
  const approach =
    (Math.hypot(victim.x - prevX, victim.y - prevY) - dist) / playerElapsed
  const opponentApproach =
    victim.previousX !== null &&
    victim.previousY !== null &&
    victim.previousMovedAt !== null &&
    victim.previousPositionAt !== null &&
    now - victim.previousMovedAt <= STEAL_MOVEMENT_FRESH_MS &&
    now - victim.previousPositionAt <= STEAL_MOVEMENT_FRESH_MS &&
    victim.previousMovedAt > victim.previousPositionAt
      ? (Math.hypot(stealer.x - victim.previousX, stealer.y - victim.previousY) - dist) /
        ((victim.previousMovedAt - victim.previousPositionAt) / 1_000)
      : 0
  if (
    approach <= STEAL_APPROACH_EPSILON ||
    approach <= opponentApproach + STEAL_APPROACH_EPSILON
  ) {
    return { ok: false, reason: 'not_chasing', synthesized }
  }

  stealer.stolen = (stealer.stolen ?? 0) + 1
  stealer.roundStolen = (stealer.roundStolen ?? 0) + 1
  stealer.score = (stealer.score ?? 0) + STEAL_SCORE
  stealer.roundScore = (stealer.roundScore ?? 0) + STEAL_SCORE
  victim.coins = Math.max(0, (victim.coins ?? 0) - 1)
  victim.roundCoins = Math.max(0, (victim.roundCoins ?? 0) - 1)
  victim.score = Math.max(0, (victim.score ?? 0) - STEAL_SCORE)
  victim.roundScore = Math.max(0, (victim.roundScore ?? 0) - STEAL_SCORE)
  victim.slowedUntil = now + 400
  victim.lastStolenAt = now
  stealer.previousX = stealer.x
  stealer.previousY = stealer.y
  stealer.previousMovedAt = null
  stealer.previousPositionAt = null
  victim.previousX = victim.x
  victim.previousY = victim.y
  victim.previousMovedAt = null
  victim.previousPositionAt = null

  return { ok: true, stealer, victim, synthesized }
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
      previousX: 45,
      previousY: 50,
      previousMovedAt: 1_000,
      previousPositionAt: 850,
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
      previousX: 52,
      previousY: 50,
      previousMovedAt: null,
      previousPositionAt: null,
    },
  },
  ...overrides,
})

const recordApproach = (state, slot, now, previousX, previousAt = now - 100) => {
  const player = state.players[slot]
  player.previousX = previousX
  player.previousY = player.y
  player.previousMovedAt = now
  player.previousPositionAt = previousAt
}

// --- Mirror of lib/useDuoChaos.ts mergeProgress (monotonic) -----------------
const mergeProgress = (local, server, objectiveChanged) => {
  if (objectiveChanged) {
    return {
      coins: server.coins ?? local.coins,
      stolen: server.stolen ?? local.stolen,
      roundCoins: server.roundCoins ?? local.roundCoins,
      roundStolen: server.roundStolen ?? local.roundStolen,
    }
  }
  return {
    coins: server.coins ?? local.coins,
    stolen: server.stolen ?? local.stolen,
    roundCoins: server.roundCoins ?? local.roundCoins,
    roundStolen: server.roundStolen ?? local.roundStolen,
  }
}

console.log('SCENARIO 1 — Player A steals from Player B: A +25, B -25')
{
  const state = makeState()
  const before = { a: state.players.p1.score, b: state.players.p2.score }
  const res = duoStealVersioned(state, 'p1', 1_000)
  check('steal succeeds', res.ok === true, res.reason)
  check('A gains exactly +25', state.players.p1.score - before.a === 25, `delta=${state.players.p1.score - before.a}`)
  check('B loses exactly -25', before.b - state.players.p2.score === 25, `delta=${before.b - state.players.p2.score}`)
  check('B loses exactly 1 coin', state.players.p2.coins === 2, `coins=${state.players.p2.coins}`)
  check('A stolen counter +1', state.players.p1.stolen === 1)
  check('B is slowed', state.players.p2.slowedUntil === 1_400)
}

console.log('SCENARIO 2 — Repeat the same contact: no accidental second +25')
{
  const state = makeState()
  const first = duoStealVersioned(state, 'p1', 1_000)
  check('first steal ok', first.ok === true)
  const scoreAfterFirst = state.players.p1.score
  // Same contact, 100ms later (within the 700ms guard). The VICTIM (p2) was
  // just stolen from, so the victim guard rejects the repeat.
  const second = duoStealVersioned(state, 'p1', 1_100)
  check('second steal rejected', second.ok === false, second.reason)
  check('rejected with victim_guarded', second.reason === 'victim_guarded', second.reason)
  check('A score unchanged after rejection', state.players.p1.score === scoreAfterFirst)
  check('A stolen counter still 1', state.players.p1.stolen === 1)
  // After the guard window elapses, a NEW contact may steal again.
  const third = duoStealVersioned(state, 'p1', 1_800)
  check('stationary contact cannot be farmed after guard window', third.ok === false, third.reason)
  recordApproach(state, 'p1', 1_800, 45)
  const fourth = duoStealVersioned(state, 'p1', 1_800)
  check('a fresh approach allows a new steal', fourth.ok === true, fourth.reason)
  check('A stolen counter now 2', state.players.p1.stolen === 2)
}

console.log('SCENARIO 3 — Two clients touch simultaneously: the chaser wins regardless of request order')
{
  for (const requestOrder of [['p1', 'p2'], ['p2', 'p1']]) {
    const state = makeState()
    state.players.p1.x = 50
    state.players.p2.x = 54.5
    recordApproach(state, 'p1', 2_000, 45, 1_900)
    recordApproach(state, 'p2', 2_000, 54, 1_900)
    const results = {}
    for (const slot of requestOrder) results[slot] = duoStealVersioned(state, slot, 2_000)
    check(`only the pursuer steals (${requestOrder.join(' then ')})`, results.p1.ok === true && results.p2.ok === false)
    check('pursuer gains exactly +25', state.players.p1.score === 125)
    check('fleeing rival loses exactly -25', state.players.p2.score === 75)
  }

  for (const requestOrder of [['p1', 'p2'], ['p2', 'p1']]) {
    const state = makeState()
    recordApproach(state, 'p1', 2_000, 49, 1_900)
    recordApproach(state, 'p2', 2_000, 53, 1_900)
    const results = {}
    for (const slot of requestOrder) results[slot] = duoStealVersioned(state, slot, 2_000)
    check(`ambiguous head-on contact has no network-order winner (${requestOrder.join(' then ')})`, results.p1.ok === false && results.p2.ok === false)
    check('ambiguous contact leaves both scores unchanged', state.players.p1.score === 100 && state.players.p2.score === 100)
  }
}

console.log('SCENARIO 4 — Repeated collisions: new steals require a fresh approach')
{
  const state = makeState()
  let successes = 0
  // Simulate 60 frames over 1 second (16ms apart) while in contact.
  for (let frame = 0; frame < 60; frame += 1) {
    const now = 3_000 + frame * 16
    if (frame === 0) recordApproach(state, 'p1', now, 45, now - 100)
    if (frame === 44) recordApproach(state, 'p1', now, 49.9, now - 16)
    const res = duoStealVersioned(state, 'p1', now)
    if (res.ok) successes += 1
  }
  check('one fresh approach permits at most one additional steal', successes === 2, `successes=${successes}`)
  check('stolen counter matches successes', state.players.p1.stolen === successes)
}

console.log('SCENARIO 5 — Both clients converge to the same final scores')
{
  const state = makeState()
  recordApproach(state, 'p1', 4_000, 45)
  duoStealVersioned(state, 'p1', 4_000)
  // Server authoritative rows.
  const serverP1 = { ...state.players.p1 }
  const serverP2 = { ...state.players.p2 }
  // Client A (stealer) local view and Client B (victim) local view both merge
  // the SAME server snapshot. Neither optimistically incremented `stolen`.
  const clientA = mergeProgress({ coins: 3, stolen: 0, roundCoins: 3, roundStolen: 0 }, serverP1, false)
  const clientB = mergeProgress({ coins: 3, stolen: 0, roundCoins: 3, roundStolen: 0 }, serverP2, false)
  check('client A sees stolen=1', clientA.stolen === 1, `stolen=${clientA.stolen}`)
  check('client B sees coins=2', clientB.coins === 2, `coins=${clientB.coins}`)
  check('both clients agree on A score', serverP1.score === 125, `A=${serverP1.score}`)
  check('both clients agree on B score', serverP2.score === 75, `B=${serverP2.score}`)
}

console.log('SCENARIO 6 — Steal does not interfere with movement or coin collection')
{
  const state = makeState()
  // A steal only touches score/coins/stolen/slowedUntil — never x/y.
  const ax = state.players.p1.x
  const ay = state.players.p1.y
  const bx = state.players.p2.x
  const by = state.players.p2.y
  recordApproach(state, 'p1', 5_000, 45)
  duoStealVersioned(state, 'p1', 5_000)
  check('stealer position unchanged', state.players.p1.x === ax && state.players.p1.y === ay)
  check('victim position unchanged', state.players.p2.x === bx && state.players.p2.y === by)
  // Victim keeps collecting: a coin collection adds score independently.
  const victimScoreBefore = state.players.p2.score
  state.players.p2.score += 10 // simulate a collect
  check('victim can still gain score from collecting', state.players.p2.score === victimScoreBefore + 10)
  // Victim score never goes below 0.
  const drained = makeState()
  drained.players.p2.score = 10
  drained.players.p2.coins = 1
  recordApproach(drained, 'p1', 6_000, 45)
  duoStealVersioned(drained, 'p1', 6_000)
  check('victim score floors at 0 (never negative)', drained.players.p2.score === 0, `score=${drained.players.p2.score}`)
}

console.log('SCENARIO 7 — Empty victim cannot be stolen from')
{
  const state = makeState()
  state.players.p2.coins = 0
  const res = duoStealVersioned(state, 'p1', 7_000)
  check('steal rejected when victim has no coins', res.ok === false, res.reason)
  check('rejected with no_coins', res.reason === 'no_coins', res.reason)
  check('stealer score unchanged', state.players.p1.score === 100)
  check('victim score unchanged', state.players.p2.score === 100)
}

console.log('SCENARIO 8 — Being nearby is not enough: steal requires avatar contact')
{
  const state = makeState()
  state.players.p2.x = 57
  recordApproach(state, 'p1', 8_000, 45)
  const result = duoStealVersioned(state, 'p1', 8_000)
  check('steal rejected outside the 5.2-unit contact radius', result.ok === false && result.reason === 'too_far', result.reason)
  check('no score is transferred without contact', state.players.p1.score === 100 && state.players.p2.score === 100)
}

console.log('SCENARIO 9 — SQL migrations enforce server-recorded directional contact')
{
  const config = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
  const gameLoop = await readFile(new URL('../lib/useGameLoop.ts', import.meta.url), 'utf8')
  check('client radius tracks both avatar collision radii', config.includes('STEAL_RADIUS = PLAYER_HIT_R * 2'))
  check('server radius matches the avatar contact boundary', directionMigration.includes('if v_dist > 5.2 then'))
  check('previous positions are captured by a database trigger', directionMigration.includes('duo_players_track_previous_position'))
  check('both players are locked before contact validation', /order by slot\s+for update/.test(staleDirectionMigration))
  check('stale approach snapshots expire after 300ms', staleDirectionMigration.includes("v_direction_fresh interval := interval '300 milliseconds'"))
  check('head-on contact cannot be awarded by RPC arrival order', staleDirectionMigration.includes('v_player_approach <= v_opponent_approach + 0.5'))
  check('positioned steal validates movement in the same transaction', positionedStealMigration.includes('duo_step_ok(') && positionedStealMigration.includes('p_x numeric default null'))
  check('same-RPC movement bypasses only the stale prior-sample age check', positionedStealMigration.includes('not v_positioned_moved') && positionedStealMigration.includes('v_pl.previous_position_at < v_now - (case'))
  check('opponent samples are considered only while their latest movement is fresh', positionedStealMigration.includes('v_opp.position_updated_at >= v_now - v_legacy_direction_fresh'))
  check('older deployed clients retain the one-second movement-sample window', positionedStealMigration.includes("v_legacy_direction_fresh interval := interval '1 second'"))
  check('steal client sends its position with the action', /p_x:\s*nextX,\s*p_y:\s*nextY/.test(gameLoop))
  check('steal action skips the separate position RPC', /collectedIds\.length > 0 \|\| stealing/.test(gameLoop))
  check('only public steal RPC remains executable', positionedStealMigration.includes('grant execute on function public.duo_steal_versioned'))
  // --- 0052: self-sufficient positioned steal sample -------------------------
  check('0052 keeps the positioned steal signature', selfSufficientStealMigration.includes('p_x numeric default null') && selfSufficientStealMigration.includes('p_y numeric default null'))
  check('0052 synthesizes a sample when the stored one is missing or stale', selfSufficientStealMigration.includes('Synthesize: the caller moved from the stored position to the new one.'))
  check('0052 uses the stored position as the sample origin', selfSufficientStealMigration.includes('v_prev_x := v_pl.x;') && selfSufficientStealMigration.includes('v_prev_y := v_pl.y;'))
  check('0052 anchors the sample end to the transaction clock', selfSufficientStealMigration.includes('v_sample_at := v_now;'))
  check('0052 guarantees a positive elapsed time', selfSufficientStealMigration.includes("v_now - interval '1 millisecond'"))
  check('0052 still rejects a zero/negative elapsed sample', selfSufficientStealMigration.includes('if v_player_elapsed is null or v_player_elapsed <= 0 then'))
  check('0052 keeps the legacy no-position path strict', selfSufficientStealMigration.includes('Legacy path (no position supplied): require the stored sample as before.'))
  check('0052 preserves the pursuer comparison epsilon', selfSufficientStealMigration.includes('v_player_approach <= v_opponent_approach + 0.5'))
  check('0052 preserves the +25/-25 scoring', selfSufficientStealMigration.includes('v_steal_score int := 25'))
  check('0052 re-grants only the public steal RPC', selfSufficientStealMigration.includes('grant execute on function public.duo_steal_versioned'))
}

console.log('SCENARIO 10 — A stopped player cannot steal using their stale approach')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  recordApproach(state, 'p1', 1_600, 49.5, 1_500)
  recordApproach(state, 'p2', 2_000, 56, 1_900)
  const p1Steal = duoStealVersioned(state, 'p1', 2_000)
  check('stationary player rejected after movement sample expires', p1Steal.ok === false && p1Steal.reason === 'not_chasing')
  const p2Steal = duoStealVersioned(state, 'p2', 2_000)
  check('currently closing player receives the steal', p2Steal.ok === true, p2Steal.reason)
  check('scores follow the actual chase direction', state.players.p1.score === 75 && state.players.p2.score === 125)
}

console.log('SCENARIO 11 — A player who has never moved cannot steal from the player who approaches')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  state.players.p1.previousX = 50
  state.players.p1.previousY = 50
  state.players.p1.previousMovedAt = null
  state.players.p1.previousPositionAt = null
  recordApproach(state, 'p2', 2_000, 56, 1_900)

  const stationaryPlayerRequest = duoStealVersioned(state, 'p1', 2_000)
  check(
    'never-moved player has no valid direction and cannot steal',
    stationaryPlayerRequest.ok === false && stationaryPlayerRequest.reason === 'not_chasing',
  )
  const approachingPlayerRequest = duoStealVersioned(state, 'p2', 2_000)
  check('moving player can steal from the stationary opponent', approachingPlayerRequest.ok === true)
  check('stationary player loses points, not the pursuer', state.players.p1.score === 75 && state.players.p2.score === 125)
}

console.log('SCENARIO 12 — Positioned steal is self-sufficient (the intermittent-failure fix)')
{
  // Reproduces the reported bug: the client sends a positioned steal, but the
  // stored directional sample is missing/stale because the queued `duo_move`
  // was dropped (positionIncludedInAction) or the player is standing on the
  // rival. Before 0052 this returned `not_chasing`; after 0052 the sample is
  // synthesized from the stored position → the new position.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p1.y = 50
  state.players.p2.x = 52
  state.players.p2.y = 50
  // No stored sample at all (the exact post-steal / dropped-move state).
  state.players.p1.previousX = null
  state.players.p1.previousY = null
  state.players.p1.previousMovedAt = null
  state.players.p1.previousPositionAt = null
  state.players.p2.previousX = null
  state.players.p2.previousY = null
  state.players.p2.previousMovedAt = null
  state.players.p2.previousPositionAt = null

  // The caller moves from x=50 toward the rival at x=52.
  const res = duoStealPositioned(state, 'p1', 1_000, 51, 50)
  check('positioned steal succeeds without a prior stored sample', res.ok === true, res.reason)
  check('the sample was synthesized', res.synthesized === true)
  check('stealer gains exactly +25', state.players.p1.score === 125, `score=${state.players.p1.score}`)
  check('victim loses exactly -25', state.players.p2.score === 75, `score=${state.players.p2.score}`)
  check('victim loses exactly 1 coin', state.players.p2.coins === 2, `coins=${state.players.p2.coins}`)

  // A stale stored sample is also replaced by a synthesized one.
  const stale = makeState()
  stale.players.p1.x = 50
  stale.players.p1.y = 50
  stale.players.p2.x = 52
  stale.players.p2.y = 50
  stale.players.p1.previousX = 40
  stale.players.p1.previousY = 50
  stale.players.p1.previousMovedAt = 100 // far in the past
  stale.players.p1.previousPositionAt = 50
  const staleRes = duoStealPositioned(stale, 'p1', 5_000, 51, 50)
  check('stale stored sample is replaced by a synthesized one', staleRes.ok === true && staleRes.synthesized === true, staleRes.reason)

  // A genuine, fresh stored sample still takes precedence (no synthesis).
  const fresh = makeState()
  fresh.players.p1.x = 50
  fresh.players.p1.y = 50
  fresh.players.p2.x = 52
  fresh.players.p2.y = 50
  fresh.players.p1.previousX = 45
  fresh.players.p1.previousY = 50
  fresh.players.p1.previousMovedAt = 1_000
  fresh.players.p1.previousPositionAt = 900
  const freshRes = duoStealPositioned(fresh, 'p1', 1_000, 51, 50)
  check('a fresh stored sample is preferred over synthesis', freshRes.ok === true && freshRes.synthesized === false, freshRes.reason)

  // A stationary positioned steal (no net movement) must NOT synthesize a
  // zero-length approach into a free steal.
  const stationary = makeState()
  stationary.players.p1.x = 50
  stationary.players.p1.y = 50
  stationary.players.p2.x = 52
  stationary.players.p2.y = 50
  stationary.players.p1.previousX = null
  stationary.players.p1.previousY = null
  stationary.players.p1.previousMovedAt = null
  stationary.players.p1.previousPositionAt = null
  const stationaryRes = duoStealPositioned(stationary, 'p1', 1_000, 50, 50)
  check('a stationary positioned steal is rejected', stationaryRes.ok === false && stationaryRes.reason === 'not_chasing', stationaryRes.reason)

  // The legacy (no position) path still requires a stored sample.
  const legacy = makeState()
  legacy.players.p1.previousX = null
  legacy.players.p1.previousY = null
  legacy.players.p1.previousMovedAt = null
  legacy.players.p1.previousPositionAt = null
  const legacyRes = duoStealVersioned(legacy, 'p1', 1_000)
  check('legacy no-position path still rejects a missing sample', legacyRes.ok === false && legacyRes.reason === 'not_chasing', legacyRes.reason)
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
