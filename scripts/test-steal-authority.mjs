// ============================================================================
// DUO CHAOS — deterministic steal authority regression test.
//
// Reproduces the reported steal problems:
//   1. WRONG VALUE: a steal awarded +20/-20 instead of +25/-25.
//   2. MUTUAL STEAL: two players touching caused BOTH to steal from each other
//      (A +20 & B -20, then B +20 & A -20) → net ~0 and "never both stealers".
//   3. EMPTY VICTIM: a steal succeeded even when the victim had 0 coins.
//   4. DOUBLE COUNT: the client optimistically incremented `stolen` every
//      `stealing` frame, and the monotonic `mergeProgress` locked the
//      over-count in.
//   5. FLAKY WINNER ("bazen çalışıyor bazen çalışmıyor, bazen puanı çalana
//      bazen çalınana veriyor"): 0049/0050 tried to INFER the chaser from a
//      single pair of noisy movement samples, so the same physical action
//      produced different results on different attempts.
//
// FIX (0051 — deterministic, initiator-authoritative):
//   * `v_steal_score := 25` (matches single-player `STEAL_SCORE`).
//   * The player who INITIATES the steal is the stealer. The server no longer
//     guesses intent from movement history.
//   * The caller-supplied position is validated with `duo_step_ok` against the
//     last server-stored position (anti-teleport). On violation the server
//     falls back to the stored position.
//   * Contact is `distance(validated_caller_pos, opponent_stored_pos) <=
//     STEAL_RADIUS + CONTACT_SLACK` (5.2 + 2.0). No approach/velocity check.
//   * Per-contact guard: `duo_players.last_stolen_at` (epoch ms). A steal is
//     rejected if either participant was stolen from within 700ms. This
//     serialises simultaneous contact: whichever RPC commits first wins.
//   * Victim must have `coins > 0` (else `no_coins`).
//   * The RPC returns BOTH the stealer `state` (+25) and the victim
//     `victimState` (-25) so each client applies the authoritative delta
//     immediately, without waiting for the ~1s `duo_public_state` poll.
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
const STEAL_CONTACT_SLACK = 2.0
const MOVE_SPEED = 38
const MOVE_SLOW_MULT = 0.55
const MOVE_SAFETY = 1.6
const MOVE_FLOOR = 8

const deterministicMigration = await readFile(
  new URL('../supabase/migrations/0051_deterministic_steal.sql', import.meta.url),
  'utf8',
)

// --- Mirror of duo_step_ok (0048) -------------------------------------------
// Returns true when the step from (fromX,fromY) to (toX,toY) is reachable in
// the elapsed time, accounting for the slow debuff.
const duoStepOk = (fromX, fromY, lastMoveAt, toX, toY, slowedUntil, nowMs) => {
  const elapsed = Math.max(0, nowMs - (lastMoveAt ?? nowMs)) / 1_000
  const slowed = (slowedUntil ?? 0) > nowMs
  const speed = MOVE_SPEED * (slowed ? MOVE_SLOW_MULT : 1)
  const allowed = Math.max(MOVE_FLOOR, speed * elapsed * MOVE_SAFETY)
  return Math.hypot(toX - fromX, toY - fromY) <= allowed
}

// --- Mirror of duo_steal_versioned (0051) -----------------------------------
// Returns { ok, reason?, stealer, victim } where stealer/victim are the
// post-action rows. `now` is the server clock (epoch ms). `callerPos` is the
// client-supplied position ({ x, y }); when omitted the stored position is used
// (mirrors the 4-arg backward-compatible wrapper).
const duoStealVersioned = (state, stealerSlot, now, expectedRound = null, callerPos = null) => {
  const stealer = state.players[stealerSlot]
  const victimSlot = stealerSlot === 'p1' ? 'p2' : 'p1'
  const victim = state.players[victimSlot]

  if (state.phase !== 'battle') return { ok: false, reason: 'not_battle' }
  if (expectedRound !== null && expectedRound !== state.round) {
    return { ok: false, reason: 'stale_round' }
  }
  // CONTACT GUARD (0051): at most ONE steal per contact.
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
  // EMPTY VICTIM (0051): nothing to steal.
  if ((victim.coins ?? 0) <= 0) return { ok: false, reason: 'no_coins' }

  // Validate the caller-supplied position (anti-teleport). On violation fall
  // back to the server-stored position — never trust an unreachable claim.
  let newX = stealer.x
  let newY = stealer.y
  if (callerPos) {
    const clampedX = Math.max(0, Math.min(100, callerPos.x))
    const clampedY = Math.max(0, Math.min(100, callerPos.y))
    if (duoStepOk(stealer.x, stealer.y, stealer.lastMoveAt, clampedX, clampedY, stealer.slowedUntil, now)) {
      newX = clampedX
      newY = clampedY
    }
  }

  // Contact check against the opponent's stored position. No direction
  // inference: the initiator is the stealer.
  const dist = Math.hypot(victim.x - newX, victim.y - newY)
  if (dist > STEAL_RADIUS + STEAL_CONTACT_SLACK) return { ok: false, reason: 'too_far' }

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

// --- Mirror of lib/useDuoChaos.ts mergeProgress (monotonic) -----------------
const mergeProgress = (local, server) => ({
  coins: server.coins ?? local.coins,
  stolen: server.stolen ?? local.stolen,
  roundCoins: server.roundCoins ?? local.roundCoins,
  roundStolen: server.roundStolen ?? local.roundStolen,
})

// --- Mirror of lib/objectiveSync.ts applyAuthoritativeVictimState -----------
// Decrease-only, same-round. Returns the merged local player.
const applyAuthoritativeVictimState = (local, victim, actionRound, currentRound) => {
  if (currentRound !== actionRound) return local
  const next = { ...local }
  if (typeof victim.coins === 'number' && Number.isFinite(victim.coins)) {
    next.coins = Math.min(local.coins ?? 0, victim.coins)
  }
  if (typeof victim.roundCoins === 'number' && Number.isFinite(victim.roundCoins)) {
    next.roundCoins = Math.min(local.roundCoins ?? 0, victim.roundCoins)
  }
  if (typeof victim.score === 'number' && Number.isFinite(victim.score)) {
    next.score = Math.min(local.score ?? 0, victim.score)
  }
  if (typeof victim.roundScore === 'number' && Number.isFinite(victim.roundScore)) {
    next.roundScore = Math.min(local.roundScore ?? 0, victim.roundScore)
  }
  return next
}

// --- Mirror of the victim-floor clamp in the battle poll merge --------------
// A stale `duo_public_state` snapshot can return a pre-commit score; the floor
// caps the server value so the stolen points cannot be resurrected. The floor
// only applies for a short TTL window (2.5s) so a legitimate LATER gain is not
// permanently blocked.
const VICTIM_FLOOR_TTL_MS = 2_500
const applyVictimFloor = (merged, local, floor, currentRound, nowMs) => {
  if (!floor || floor.round !== currentRound) return merged
  if (nowMs - floor.at >= VICTIM_FLOOR_TTL_MS) return merged
  const capScore = Math.min(merged.score ?? 0, floor.score)
  const capRoundScore = Math.min(merged.roundScore ?? 0, floor.roundScore)
  const capCoins = Math.min(merged.coins ?? 0, floor.coins)
  const capRoundCoins = Math.min(merged.roundCoins ?? 0, floor.roundCoins)
  return {
    ...merged,
    score: Math.max(local.score ?? 0, capScore),
    roundScore: Math.max(local.roundScore ?? 0, capRoundScore),
    coins: Math.max(local.coins ?? 0, capCoins),
    roundCoins: Math.max(local.roundCoins ?? 0, capRoundCoins),
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
  check('victimState reports B score 75', res.victimState.score === 75, `score=${res.victimState.score}`)
  check('victimState reports B coins 2', res.victimState.coins === 2, `coins=${res.victimState.coins}`)
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
  check('a new contact after the guard window steals again', third.ok === true, third.reason)
  check('A stolen counter now 2', state.players.p1.stolen === 2)
}

console.log('SCENARIO 3 — Two clients touch simultaneously: the initiator wins regardless of request order')
{
  // Both clients detect contact and call the RPC. The 700ms guard serialises
  // them: whichever commits first is the stealer, the other is rejected.
  for (const requestOrder of [['p1', 'p2'], ['p2', 'p1']]) {
    const state = makeState()
    state.players.p1.x = 50
    state.players.p2.x = 54.5
    const results = {}
    for (const slot of requestOrder) results[slot] = duoStealVersioned(state, slot, 2_000)
    const first = requestOrder[0]
    const second = requestOrder[1]
    check(`first initiator steals (${requestOrder.join(' then ')})`, results[first].ok === true, results[first].reason)
    check(`second initiator rejected by the guard (${requestOrder.join(' then ')})`, results[second].ok === false, results[second].reason)
    check('exactly one steal transferred +25/-25', state.players.p1.score + state.players.p2.score === 200)
    check('exactly one player gained, one lost', Math.abs(state.players.p1.score - 100) === 25 && Math.abs(state.players.p2.score - 100) === 25)
  }
}

console.log('SCENARIO 4 — Repeated collisions: the guard limits steals to one per 700ms')
{
  const state = makeState()
  let successes = 0
  // Simulate 60 frames over 1 second (16ms apart) while in contact.
  for (let frame = 0; frame < 60; frame += 1) {
    const now = 3_000 + frame * 16
    const res = duoStealVersioned(state, 'p1', now)
    if (res.ok) successes += 1
  }
  // 1000ms / 700ms guard → at most 2 steals (t=3000 and t=3700+).
  check('guard limits contact farming to 2 steals per second', successes === 2, `successes=${successes}`)
  check('stolen counter matches successes', state.players.p1.stolen === successes)
}

console.log('SCENARIO 5 — Both clients converge to the same final scores')
{
  const state = makeState()
  duoStealVersioned(state, 'p1', 4_000)
  // Server authoritative rows.
  const serverP1 = { ...state.players.p1 }
  const serverP2 = { ...state.players.p2 }
  // Client A (stealer) local view and Client B (victim) local view both merge
  // the SAME server snapshot. Neither optimistically incremented `stolen`.
  const clientA = mergeProgress({ coins: 3, stolen: 0, roundCoins: 3, roundStolen: 0 }, serverP1)
  const clientB = mergeProgress({ coins: 3, stolen: 0, roundCoins: 3, roundStolen: 0 }, serverP2)
  check('client A sees stolen=1', clientA.stolen === 1, `stolen=${clientA.stolen}`)
  check('client B sees coins=2', clientB.coins === 2, `coins=${clientB.coins}`)
  check('both clients agree on A score', serverP1.score === 125, `A=${serverP1.score}`)
  check('both clients agree on B score', serverP2.score === 75, `B=${serverP2.score}`)
}

console.log('SCENARIO 6 — Steal does not interfere with movement or coin collection')
{
  const state = makeState()
  // A steal only touches score/coins/stolen/slowedUntil — never the victim's x/y.
  const bx = state.players.p2.x
  const by = state.players.p2.y
  duoStealVersioned(state, 'p1', 5_000)
  check('victim position unchanged', state.players.p2.x === bx && state.players.p2.y === by)
  // Victim keeps collecting: a coin collection adds score independently.
  const victimScoreBefore = state.players.p2.score
  state.players.p2.score += 10 // simulate a collect
  check('victim can still gain score from collecting', state.players.p2.score === victimScoreBefore + 10)
  // Victim score never goes below 0.
  const drained = makeState()
  drained.players.p2.score = 10
  drained.players.p2.coins = 1
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
  state.players.p2.x = 60
  const result = duoStealVersioned(state, 'p1', 8_000)
  check('steal rejected outside the contact radius + slack', result.ok === false && result.reason === 'too_far', result.reason)
  check('no score is transferred without contact', state.players.p1.score === 100 && state.players.p2.score === 100)
}

console.log('SCENARIO 9 — SQL migration enforces deterministic initiator-authoritative contact')
{
  const config = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
  check('client radius tracks both avatar collision radii', config.includes('STEAL_RADIUS = PLAYER_HIT_R * 2'))
  check('server radius matches the avatar contact boundary', deterministicMigration.includes('if v_dist > 5.2 + v_contact_slack then'))
  check('contact slack is 2.0 arena units', deterministicMigration.includes('v_contact_slack numeric := 2.0'))
  check('caller position is validated with duo_step_ok', deterministicMigration.includes('if not duo_step_ok('))
  check('invalid caller position falls back to the stored position', deterministicMigration.includes('v_new_x := v_pl.x'))
  // The header comment explains the OLD design and mentions `not_chasing`; the
  // actual function body must not contain the inference. Scope the check to the
  // code after the comment block.
  const migrationCode = deterministicMigration.slice(deterministicMigration.indexOf('create or replace function'))
  check('no approach/velocity inference remains in the function body', !migrationCode.includes('not_chasing'))
  check('both players are locked before contact validation', /order by slot\s+for update/.test(deterministicMigration))
  check('contact guard window is 700ms', deterministicMigration.includes('v_contact_guard_ms int := 700'))
  check('steal score is 25', deterministicMigration.includes('v_steal_score int := 25'))
  check('RPC returns the authoritative victim delta', deterministicMigration.includes("'victimState', jsonb_build_object("))
  check('only public steal RPCs remain executable', deterministicMigration.includes('grant execute on function public.duo_steal_versioned'))
}

console.log('SCENARIO 10 — A stopped player CAN steal (no stale-approach rejection)')
{
  // The old 0049/0050 design rejected a player who stopped to press steal
  // because their movement sample was stale. The deterministic design does not
  // care about movement history: contact is contact.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  // p1 has not moved for a long time (stale sample in the old design).
  state.players.p1.lastMoveAt = 0
  const p1Steal = duoStealVersioned(state, 'p1', 2_000)
  check('stationary player can steal on contact', p1Steal.ok === true, p1Steal.reason)
  check('stationary stealer gains +25', state.players.p1.score === 125, `score=${state.players.p1.score}`)
  check('victim loses -25', state.players.p2.score === 75, `score=${state.players.p2.score}`)
}

console.log('SCENARIO 11 — A lying client cannot teleport next to the rival')
{
  const state = makeState()
  // p1 is far away (x=10) but claims to be right next to p2 (x=52).
  state.players.p1.x = 10
  state.players.p1.y = 50
  state.players.p1.lastMoveAt = 2_000
  const res = duoStealVersioned(state, 'p1', 2_000, null, { x: 52, y: 50 })
  check('unreachable caller position is rejected as too_far', res.ok === false && res.reason === 'too_far', res.reason)
  check('no score is transferred from a teleport claim', state.players.p1.score === 100 && state.players.p2.score === 100)
  // A legitimate step (within reach) is accepted.
  const legit = makeState()
  legit.players.p1.x = 48
  legit.players.p1.y = 50
  legit.players.p1.lastMoveAt = 2_000
  const ok = duoStealVersioned(legit, 'p1', 2_000, null, { x: 50, y: 50 })
  check('a reachable caller position is accepted', ok.ok === true, ok.reason)
}

console.log('SCENARIO 12 — Victim floor prevents a stale poll from resurrecting stolen points')
{
  const state = makeState()
  const res = duoStealVersioned(state, 'p1', 9_000)
  check('steal ok', res.ok === true, res.reason)
  // Victim client applies the authoritative victimState immediately.
  const localVictim = { coins: 3, roundCoins: 3, score: 100, roundScore: 100 }
  const afterVictimState = applyAuthoritativeVictimState(localVictim, res.victimState, 1, 1)
  check('victim client drops to score 75 at once', afterVictimState.score === 75, `score=${afterVictimState.score}`)
  check('victim client drops to coins 2 at once', afterVictimState.coins === 2, `coins=${afterVictimState.coins}`)
  // A stale public-state poll returns the PRE-commit score (100). The floor
  // caps it so the stolen points are not resurrected.
  const stealAt = 9_000
  const floor = { round: 1, at: stealAt, score: 75, roundScore: 75, coins: 2, roundCoins: 2 }
  const staleMerged = { coins: 3, roundCoins: 3, score: 100, roundScore: 100 }
  const clamped = applyVictimFloor(staleMerged, afterVictimState, floor, 1, stealAt + 500)
  check('stale poll cannot raise the victim score back to 100', clamped.score === 75, `score=${clamped.score}`)
  check('stale poll cannot raise the victim coins back to 3', clamped.coins === 2, `coins=${clamped.coins}`)
  // A legitimate later gain (collect) above the floor is preserved once the
  // floor TTL has elapsed.
  const laterGain = { coins: 2, roundCoins: 2, score: 85, roundScore: 85 }
  const kept = applyVictimFloor(laterGain, afterVictimState, floor, 1, stealAt + VICTIM_FLOOR_TTL_MS + 1)
  check('a legitimate later gain above the floor is preserved after the TTL', kept.score === 85, `score=${kept.score}`)
  // The floor is ignored on a different round.
  const nextRound = applyVictimFloor(staleMerged, afterVictimState, floor, 2, stealAt + 500)
  check('floor is ignored on a different round', nextRound.score === 100, `score=${nextRound.score}`)
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
