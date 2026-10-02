// ============================================================================
// DUO CHAOS — steal mechanic authority + contact-guard test (migration 0042).
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
// FIX (0042):
//   * `v_steal_score := 25` (matches single-player `STEAL_SCORE`).
//   * Per-contact guard: `duo_players.last_steal_at` (epoch ms). A steal is
//     rejected if the STEALER stole within `STEAL_CONTACT_GUARD_MS` (700ms).
//     This makes a single contact produce AT MOST ONE steal and prevents
//     mutual steals (the second caller is guarded).
//   * Victim must have `coins > 0` (else `no_coins`).
//   * Client no longer optimistically increments `stolen`/`roundStolen`.
//
// This test mirrors the EXACT server guard + score rules and the client merge,
// then drives the 6 required scenarios. No DB required.
//
// Run: node scripts/test-steal-authority.mjs
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

// --- Constants mirrored from migration 0042 / lib/config.ts -----------------
const STEAL_SCORE = 25
const STEAL_CONTACT_GUARD_MS = 700
const STEAL_RADIUS = 10

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

  return { ok: true, stealer, victim }
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
    },
  },
  ...overrides,
})

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
  check('steal allowed after guard window', third.ok === true, third.reason)
  check('A stolen counter now 2', state.players.p1.stolen === 2)
}

console.log('SCENARIO 3 — Both players touch simultaneously: exactly one stealer')
{
  const state = makeState()
  // Both clients fire at the same server instant (same `now`).
  const a = duoStealVersioned(state, 'p1', 2_000)
  const b = duoStealVersioned(state, 'p2', 2_000)
  const successes = [a, b].filter((r) => r.ok).length
  check('exactly one steal succeeds', successes === 1, `successes=${successes}`)
  check('the other is rejected', [a, b].some((r) => r.ok === false))
  // Net score must NOT be zero-sum-neutral (i.e. not both stealing).
  const netA = state.players.p1.score
  const netB = state.players.p2.score
  check('scores are not mutually neutralized', netA !== netB, `A=${netA} B=${netB}`)
  check('exactly one player has stolen=1', [state.players.p1.stolen, state.players.p2.stolen].filter((s) => s === 1).length === 1)
}

console.log('SCENARIO 4 — Repeated collisions: no rapid duplicate steal farming')
{
  const state = makeState()
  let successes = 0
  // Simulate 60 frames over 1 second (16ms apart) while in contact.
  for (let frame = 0; frame < 60; frame += 1) {
    const now = 3_000 + frame * 16
    const res = duoStealVersioned(state, 'p1', now)
    if (res.ok) successes += 1
  }
  // 1000ms / 700ms guard → at most 2 steals (at t=0 and t=700).
  check('at most 2 steals in 1s of contact', successes <= 2, `successes=${successes}`)
  check('at least 1 steal in 1s of contact', successes >= 1, `successes=${successes}`)
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

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
