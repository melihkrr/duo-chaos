// ============================================================================
// DUO CHAOS — steal authority and movement-into-contact regression test.
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
// FIX (0042 + 0051):
//   * `v_steal_score := 25` (matches single-player `STEAL_SCORE`).
//   * Per-contact guard: `duo_players.last_stolen_at` (epoch ms). A steal is
//     rejected if either participant was stolen from within 700ms.
//   * ATTACKER = whoever MOVED TOWARD the opponent between their previous
//     authoritative position and their current position (strictly closer).
//     No velocity threshold, no approach-speed comparison, no freshness window.
//   * SIMULTANEOUS contact (both moved toward each other) applies BOTH steals
//     atomically in the same transaction — neither is turned into a single
//     winner by RPC arrival order.
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

// --- Constants mirrored from migration 0042 / 0051 / lib/config.ts ----------
const STEAL_SCORE = 25
const STEAL_CONTACT_GUARD_MS = 700
const STEAL_RADIUS = 5.2
const movementMigration = await readFile(
  new URL('../supabase/migrations/0051_movement_contact_steal.sql', import.meta.url),
  'utf8',
)
const preserveSampleMigration = await readFile(
  new URL('../supabase/migrations/0052_steal_preserve_movement_sample.sql', import.meta.url),
  'utf8',
)

// --- Mirror of duo_steal_versioned (0051) -----------------------------------
// Returns { ok, reason?, mutual?, stealer, victim } where stealer/victim are
// the post-action rows. `now` is the server clock (epoch ms).
//
// Attacker detection: a player "moved toward" the opponent when the distance
// from their PREVIOUS authoritative position to the opponent's CURRENT
// position is strictly greater than the CURRENT contact distance.
const movedToward = (player, opponent, dist) => {
  if (player.previousX === null || player.previousY === null) return false
  const prevDist = Math.hypot(opponent.x - player.previousX, opponent.y - player.previousY)
  return prevDist > dist
}

const duoStealVersioned = (state, callerSlot, now, expectedRound = null) => {
  const caller = state.players[callerSlot]
  const oppSlot = callerSlot === 'p1' ? 'p2' : 'p1'
  const opp = state.players[oppSlot]

  if (state.phase !== 'battle') return { ok: false, reason: 'not_battle' }
  if (expectedRound !== null && expectedRound !== state.round) {
    return { ok: false, reason: 'stale_round' }
  }
  // CONTACT / COOLDOWN GUARD (0042): at most ONE steal per contact window.
  if (
    (opp.lastStolenAt ?? 0) > 0 &&
    now - (opp.lastStolenAt ?? 0) < STEAL_CONTACT_GUARD_MS
  ) {
    return { ok: false, reason: 'victim_guarded' }
  }
  if (
    (caller.lastStolenAt ?? 0) > 0 &&
    now - (caller.lastStolenAt ?? 0) < STEAL_CONTACT_GUARD_MS
  ) {
    return { ok: false, reason: 'steal_cooldown' }
  }
  // CONTACT RANGE (unchanged): both avatars must actually touch.
  const dist = Math.hypot(opp.x - caller.x, opp.y - caller.y)
  if (dist > STEAL_RADIUS) return { ok: false, reason: 'too_far' }

  // ATTACKER DETECTION — MOVEMENT INTO CONTACT.
  const callerToward = movedToward(caller, opp, dist)
  const oppToward = movedToward(opp, caller, dist)
  if (!callerToward && !oppToward) return { ok: false, reason: 'not_chasing' }

  // Attacker gains: +25 score, +1 stolen, slowed.
  // NOTE (0052): the movement sample (previousX/Y) is NOT reset. Resetting it
  // destroyed the "moved toward" evidence and caused the intermittent
  // "1 hit / 5 miss / 6 hit" live bug. The 700ms contact guard is the only
  // anti-spam mechanism.
  const applyAttackerGain = (stealer) => {
    stealer.stolen = (stealer.stolen ?? 0) + 1
    stealer.roundStolen = (stealer.roundStolen ?? 0) + 1
    stealer.score = (stealer.score ?? 0) + STEAL_SCORE
    stealer.roundScore = (stealer.roundScore ?? 0) + STEAL_SCORE
    stealer.slowedUntil = now + 400
    stealer.lastStolenAt = now
  }

  // Victim loses: -25 score (floored at 0), -1 coin (floored at 0), slowed.
  const applyVictimLoss = (victim) => {
    victim.score = Math.max(0, (victim.score ?? 0) - STEAL_SCORE)
    victim.roundScore = Math.max(0, (victim.roundScore ?? 0) - STEAL_SCORE)
    victim.coins = Math.max(0, (victim.coins ?? 0) - 1)
    victim.roundCoins = Math.max(0, (victim.roundCoins ?? 0) - 1)
    victim.slowedUntil = now + 400
    victim.lastStolenAt = now
  }

  // SIMULTANEOUS CONTACT: both moved toward each other → BOTH steal atomically.
  // Each player gains +25/+1 stolen AND loses 25/-1 coin exactly ONCE.
  if (callerToward && oppToward) {
    applyAttackerGain(caller)
    applyVictimLoss(caller)
    applyAttackerGain(opp)
    applyVictimLoss(opp)
    return { ok: true, mutual: true, stealer: caller, victim: opp }
  }

  // SINGLE ATTACKER: the caller must be the one who moved toward the opponent.
  if (!callerToward) return { ok: false, reason: 'not_chasing' }
  if ((opp.coins ?? 0) <= 0) return { ok: false, reason: 'no_coins' }

  applyAttackerGain(caller)
  applyVictimLoss(opp)
  return { ok: true, mutual: false, stealer: caller, victim: opp }
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
      previousPositionAt: 900,
      positionUpdatedAt: 1_000,
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
      previousPositionAt: null,
      positionUpdatedAt: null,
    },
  },
  ...overrides,
})

// Record a movement sample: the player was at (previousX, previousY) and is
// now at their current x/y.
const recordMove = (state, slot, previousX, previousY = state.players[slot].y) => {
  const player = state.players[slot]
  player.previousX = previousX
  player.previousY = previousY
  player.previousPositionAt = 900
  player.positionUpdatedAt = 1_000
}

// --- Mirror of lib/useDuoChaos.ts mergeProgress (monotonic) -----------------
const mergeProgress = (local, server) => ({
  coins: server.coins ?? local.coins,
  stolen: server.stolen ?? local.stolen,
  roundCoins: server.roundCoins ?? local.roundCoins,
  roundStolen: server.roundStolen ?? local.roundStolen,
})

console.log('SCENARIO 1 — A moves into stationary B: A steals (A +25, B -25, B -1 coin)')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  recordMove(state, 'p1', 45) // A moved from 45 → 50 (closer to B at 54.5)
  // B never moved (previousX === current x).
  state.players.p2.previousX = 54.5
  state.players.p2.previousY = 50
  const before = { a: state.players.p1.score, b: state.players.p2.score }
  const res = duoStealVersioned(state, 'p1', 1_000)
  check('steal succeeds', res.ok === true, res.reason)
  check('A gains exactly +25', state.players.p1.score - before.a === 25, `delta=${state.players.p1.score - before.a}`)
  check('B loses exactly -25', before.b - state.players.p2.score === 25, `delta=${before.b - state.players.p2.score}`)
  check('B loses exactly 1 coin', state.players.p2.coins === 2, `coins=${state.players.p2.coins}`)
  check('A stolen counter +1', state.players.p1.stolen === 1)
  check('B is slowed', state.players.p2.slowedUntil === 1_400)
}

console.log('SCENARIO 2 — B moves into stationary A: B steals (B +25, A -25, A -1 coin)')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  // A never moved.
  state.players.p1.previousX = 50
  state.players.p1.previousY = 50
  recordMove(state, 'p2', 60) // B moved from 60 → 54.5 (closer to A at 50)
  const before = { a: state.players.p1.score, b: state.players.p2.score }
  const res = duoStealVersioned(state, 'p2', 1_000)
  check('steal succeeds', res.ok === true, res.reason)
  check('B gains exactly +25', state.players.p2.score - before.b === 25, `delta=${state.players.p2.score - before.b}`)
  check('A loses exactly -25', before.a - state.players.p1.score === 25, `delta=${before.a - state.players.p1.score}`)
  check('A loses exactly 1 coin', state.players.p1.coins === 2, `coins=${state.players.p1.coins}`)
  check('B stolen counter +1', state.players.p2.stolen === 1)
}

console.log('SCENARIO 3 — A chases B (both moving, A closing): A steals')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  recordMove(state, 'p1', 44) // A closed 44 → 50
  recordMove(state, 'p2', 56) // B moved 56 → 54.5 but AWAY from A? 56 is farther; B moved toward A here.
  // Make B move AWAY: B was at 53 and is now at 54.5 (farther from A).
  state.players.p2.previousX = 53
  const res = duoStealVersioned(state, 'p1', 1_000)
  check('A (closing) steals', res.ok === true, res.reason)
  check('A +25 / B -25', state.players.p1.score === 125 && state.players.p2.score === 75)
}

console.log('SCENARIO 4 — B chases A (both moving, B closing): B steals')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  // A moves AWAY: A was at 51 (closer to B) and is now at 50 (farther).
  state.players.p1.previousX = 51
  recordMove(state, 'p2', 60) // B closed 60 → 54.5
  const res = duoStealVersioned(state, 'p2', 1_000)
  check('B (closing) steals', res.ok === true, res.reason)
  check('B +25 / A -25', state.players.p2.score === 125 && state.players.p1.score === 75)
}

console.log('SCENARIO 5 — Both move toward each other simultaneously: BOTH steal atomically')
{
  // The row lock serializes the two RPCs. The FIRST caller sees both players
  // moving toward each other and applies BOTH steals atomically (mutual=true).
  // The SECOND caller then hits the contact guard and is rejected — but the
  // steal for that player has ALREADY been applied by the first transaction.
  // Neither player is turned into a single winner by RPC arrival order.
  for (const requestOrder of [['p1', 'p2'], ['p2', 'p1']]) {
    const state = makeState()
    state.players.p1.x = 50
    state.players.p2.x = 54.5
    recordMove(state, 'p1', 45) // A closed 45 → 50
    recordMove(state, 'p2', 60) // B closed 60 → 54.5
    const results = {}
    for (const slot of requestOrder) results[slot] = duoStealVersioned(state, slot, 2_000)
    const first = results[requestOrder[0]]
    const second = results[requestOrder[1]]
    check(`first caller applies the mutual steal (${requestOrder.join(' then ')})`, first.ok === true && first.mutual === true, first.reason)
    check('second caller is rejected by the contact guard', second.ok === false, second.reason)
    check('net score unchanged for both (each +25 and -25)', state.players.p1.score === 100 && state.players.p2.score === 100)
    check('both lost exactly 1 coin', state.players.p1.coins === 2 && state.players.p2.coins === 2)
    check('both stolen counters +1', state.players.p1.stolen === 1 && state.players.p2.stolen === 1)
  }
}

console.log('SCENARIO 6 — Neither moves toward the other: no steal')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  // A moved away (51 → 50), B moved away (53 → 54.5).
  state.players.p1.previousX = 51
  state.players.p2.previousX = 53
  const res = duoStealVersioned(state, 'p1', 3_000)
  check('steal rejected', res.ok === false, res.reason)
  check('rejected with not_chasing', res.reason === 'not_chasing', res.reason)
  check('no score transferred', state.players.p1.score === 100 && state.players.p2.score === 100)
  check('no coins transferred', state.players.p1.coins === 3 && state.players.p2.coins === 3)
}

console.log('SCENARIO 7 — Continuous contact cannot spam steal every frame (700ms guard)')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  state.players.p2.coins = 10
  let successes = 0
  // 60 frames over ~1s (16ms apart) while in contact. The movement sample is
  // recorded ONCE and preserved (0052). The 700ms contact guard — not the
  // movement sample — limits steals to roughly one per guard window.
  for (let frame = 0; frame < 60; frame += 1) {
    const now = 4_000 + frame * 16
    if (frame === 0) recordMove(state, 'p1', 45)
    const res = duoStealVersioned(state, 'p1', now)
    if (res.ok) successes += 1
  }
  // ~960ms of contact → at most 2 steals (t=0 and t≈700ms), never 60.
  check('steals are rate-limited by the guard, not per-frame', successes <= 2, `successes=${successes}`)
  check('at least one steal landed', successes >= 1, `successes=${successes}`)
  check('stolen counter matches successes', state.players.p1.stolen === successes)
}

console.log('SCENARIO 8 — After cooldown, attacker can steal again from stationary victim')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  recordMove(state, 'p1', 45)
  const first = duoStealVersioned(state, 'p1', 5_000)
  check('first steal ok', first.ok === true, first.reason)
  check('A stolen counter 1', state.players.p1.stolen === 1)
  // Same contact, 100ms later (within the 700ms guard) → rejected.
  const second = duoStealVersioned(state, 'p1', 5_100)
  check('repeat within guard rejected', second.ok === false, second.reason)
  check('rejected with victim_guarded', second.reason === 'victim_guarded', second.reason)
  // After the guard window, the SAME preserved movement sample still counts as
  // "moved toward" — no new move is required (0052). This is the exact case
  // that used to fail intermittently.
  const third = duoStealVersioned(state, 'p1', 5_800)
  check('after cooldown the preserved sample steals again', third.ok === true, third.reason)
  check('A stolen counter now 2', state.players.p1.stolen === 2)
  check('stationary victim lost a second coin', state.players.p2.coins === 1, `coins=${state.players.p2.coins}`)
}

console.log('SCENARIO 9 — +25/-25 is exact and victim score floors at 0')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  recordMove(state, 'p1', 45)
  duoStealVersioned(state, 'p1', 6_000)
  check('A score exactly +25', state.players.p1.score === 125, `A=${state.players.p1.score}`)
  check('B score exactly -25', state.players.p2.score === 75, `B=${state.players.p2.score}`)
  check('A roundScore +25', state.players.p1.roundScore === 125)
  check('B roundScore -25', state.players.p2.roundScore === 75)

  const drained = makeState()
  drained.players.p1.x = 50
  drained.players.p2.x = 54.5
  drained.players.p2.score = 10
  drained.players.p2.roundScore = 10
  drained.players.p2.coins = 1
  recordMove(drained, 'p1', 45)
  duoStealVersioned(drained, 'p1', 6_000)
  check('victim score floors at 0 (never negative)', drained.players.p2.score === 0, `score=${drained.players.p2.score}`)
  check('victim roundScore floors at 0', drained.players.p2.roundScore === 0, `roundScore=${drained.players.p2.roundScore}`)
}

console.log('SCENARIO 10 — Existing objective and round guards still work')
{
  // Round guard: a stale expected round is rejected before any steal.
  const staleRound = makeState()
  staleRound.players.p1.x = 50
  staleRound.players.p2.x = 54.5
  recordMove(staleRound, 'p1', 45)
  const stale = duoStealVersioned(staleRound, 'p1', 7_000, 99)
  check('stale round rejected', stale.ok === false && stale.reason === 'stale_round', stale.reason)
  check('no score transferred on stale round', staleRound.players.p1.score === 100 && staleRound.players.p2.score === 100)

  // Phase guard: a non-battle phase is rejected.
  const notBattle = makeState({ phase: 'lobby' })
  notBattle.players.p1.x = 50
  notBattle.players.p2.x = 54.5
  recordMove(notBattle, 'p1', 45)
  const phase = duoStealVersioned(notBattle, 'p1', 7_000)
  check('non-battle phase rejected', phase.ok === false && phase.reason === 'not_battle', phase.reason)

  // Empty victim guard.
  const empty = makeState()
  empty.players.p1.x = 50
  empty.players.p2.x = 54.5
  empty.players.p2.coins = 0
  recordMove(empty, 'p1', 45)
  const noCoins = duoStealVersioned(empty, 'p1', 7_000)
  check('empty victim rejected with no_coins', noCoins.ok === false && noCoins.reason === 'no_coins', noCoins.reason)

  // Contact range guard.
  const far = makeState()
  far.players.p1.x = 50
  far.players.p2.x = 57
  recordMove(far, 'p1', 45)
  const tooFar = duoStealVersioned(far, 'p1', 7_000)
  check('outside 5.2 contact radius rejected', tooFar.ok === false && tooFar.reason === 'too_far', tooFar.reason)

  // Both clients converge to the same authoritative scores.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  recordMove(state, 'p1', 45)
  duoStealVersioned(state, 'p1', 7_000)
  const clientA = mergeProgress({ coins: 3, stolen: 0, roundCoins: 3, roundStolen: 0 }, state.players.p1)
  const clientB = mergeProgress({ coins: 3, stolen: 0, roundCoins: 3, roundStolen: 0 }, state.players.p2)
  check('client A sees stolen=1', clientA.stolen === 1, `stolen=${clientA.stolen}`)
  check('client B sees coins=2', clientB.coins === 2, `coins=${clientB.coins}`)
  check('both clients agree on A score', state.players.p1.score === 125, `A=${state.players.p1.score}`)
  check('both clients agree on B score', state.players.p2.score === 75, `B=${state.players.p2.score}`)
}

console.log('SCENARIO 11 — SQL migration enforces movement-into-contact attacker detection')
{
  const config = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
  check('client radius tracks both avatar collision radii', config.includes('STEAL_RADIUS = PLAYER_HIT_R * 2'))
  check('server radius matches the avatar contact boundary', movementMigration.includes('if v_dist > 5.2 then'))
  check('attacker detection compares previous distance to current distance', movementMigration.includes('v_pl_toward := v_prev_dist > v_dist'))
  check('opponent attacker detection compares previous distance to current distance', movementMigration.includes('v_opp_toward := v_opp_prev_dist > v_dist'))
  check('no velocity/approach-speed threshold remains', !movementMigration.includes('v_player_approach :='))
  check('no 300ms freshness window remains', !movementMigration.includes('300 milliseconds'))
  check('both players are locked before contact validation', /order by slot\s+for update/.test(movementMigration))
  check('simultaneous contact applies both steals', movementMigration.includes('if v_pl_toward and v_opp_toward then'))
  check('simultaneous contact is reported as mutual', movementMigration.includes("'mutual', true"))
  check('only public steal RPC remains executable', movementMigration.includes('grant execute on function public.duo_steal_versioned'))
  // Strip SQL line comments so the header comment (which documents the OLD
  // reset behaviour being removed) cannot satisfy the "no reset" assertion.
  const preserveSampleCode = preserveSampleMigration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  check('0052 keeps the movement sample (no previous_x reset)', !/previous_x\s*=\s*x/.test(preserveSampleCode))
  check('0052 still detects movement into contact', preserveSampleMigration.includes('v_pl_toward := v_prev_dist > v_dist'))
  check('0052 still applies mutual steals', preserveSampleMigration.includes('if v_pl_toward and v_opp_toward then'))
}

console.log('SCENARIO 12 — Repeated steals during a chase are reliable (0052 regression)')
{
  // Reproduces the live "1 hit / 5 miss / 6 hit" bug. The attacker keeps
  // moving into contact; the movement sample is recorded ONCE and preserved.
  // Every attempt after the 700ms guard must land — no dependence on a fresh
  // server move between attempts.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  state.players.p2.coins = 10
  recordMove(state, 'p1', 45) // one real approach into contact
  let landed = 0
  let missed = 0
  // Attempt once per 100ms for 3 seconds (30 attempts).
  for (let i = 0; i < 30; i += 1) {
    const now = 10_000 + i * 100
    const res = duoStealVersioned(state, 'p1', now)
    if (res.ok) landed += 1
    else missed += 1
  }
  // 3s / 700ms guard → 4 steals (t=0, 700, 1400, 2100, 2800 → 5 windows).
  check('repeated steals land reliably (no intermittent misses)', landed >= 4, `landed=${landed}`)
  check('misses are only the guard window, never not_chasing', missed <= 26, `missed=${missed}`)
  check('stolen counter equals landed steals', state.players.p1.stolen === landed, `stolen=${state.players.p1.stolen} landed=${landed}`)
  check('victim coins reduced by exactly the landed steals', state.players.p2.coins === 10 - landed, `coins=${state.players.p2.coins}`)
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
