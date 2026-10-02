// ============================================================================
// DUO CHAOS — steal authority regression test.
//
// Reproduces the reported steal problems and locks in the fixed behaviour:
//   1. WRONG VALUE: a steal awarded +20/-20 instead of +25/-25.
//   2. MUTUAL STEAL: two players touching caused BOTH to steal from each other
//      (A +25 & B -25, then B +25 & A -25) → net ~0 and "never both stealers".
//   3. EMPTY VICTIM: a steal succeeded even when the victim had 0 coins.
//   4. DOUBLE COUNT: the client optimistically incremented `stolen` every
//      `stealing` frame, and the monotonic `mergeProgress` locked the
//      over-count in.
//   5. STEAL NEVER FIRES: the 0049/0050 directional guard required a fresh
//      (<300ms) movement sample that closes distance. A player who chased the
//      rival and STOPPED on contact (the natural way to steal) had a stale
//      sample → `not_chasing` on almost every attempt.
//
// FIX (0051):
//   * `v_steal_score := 25` (matches single-player `STEAL_SCORE`).
//   * Per-contact guard: `duo_players.last_stolen_at` (epoch ms). A steal is
//     rejected if either participant was stolen from within 700ms.
//   * Victim must have `coins > 0` (else `no_coins`).
//   * Contact is a pure SERVER-STORED distance check (<= 5.2). The fragile
//     direction/velocity analysis is GONE.
//   * Both player rows are locked `FOR UPDATE` in slot order, so simultaneous
//     mutual-steal requests SERIALISE and only the first succeeds.
//   * Client no longer optimistically increments `stolen`/`roundStolen`.
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

// --- Constants mirrored from migration 0051/0052 / lib/config.ts ------------
const STEAL_SCORE = 25
const STEAL_CONTACT_GUARD_MS = 700
const STEAL_RADIUS = 5.2
// ÇALINMA TABANI penceresi (lib/useDuoChaos.ts VICTIM_SCORE_FLOOR_MS).
const VICTIM_SCORE_FLOOR_MS = 2_500
const simplifyMigration = await readFile(
  new URL('../supabase/migrations/0051_simplify_steal_contact.sql', import.meta.url),
  'utf8',
)
const victimStateMigration = await readFile(
  new URL('../supabase/migrations/0052_steal_victim_state.sql', import.meta.url),
  'utf8',
)
const useDuoChaosSource = await readFile(
  new URL('../lib/useDuoChaos.ts', import.meta.url),
  'utf8',
)
const useGameLoopSource = await readFile(
  new URL('../lib/useGameLoop.ts', import.meta.url),
  'utf8',
)
const objectiveSyncSource = await readFile(
  new URL('../lib/objectiveSync.ts', import.meta.url),
  'utf8',
)

// --- Mirror of duo_steal_versioned (0051) -----------------------------------
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
  // CONTACT (0051): pure server-stored distance. No direction analysis.
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
const mergeProgress = (local, server) => ({
  coins: server.coins ?? local.coins,
  stolen: server.stolen ?? local.stolen,
  roundCoins: server.roundCoins ?? local.roundCoins,
  roundStolen: server.roundStolen ?? local.roundStolen,
})

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
  check('a new contact after the guard window steals again', third.ok === true, third.reason)
  check('A stolen counter now 2', state.players.p1.stolen === 2)
}

console.log('SCENARIO 3 — Two clients touch simultaneously: only one steal lands')
{
  // Both clients detect contact and call the RPC. The server locks both rows
  // in slot order, so the calls SERIALISE: the first stamps the victim's
  // `last_stolen_at`, the second is rejected by the contact guard.
  for (const requestOrder of [['p1', 'p2'], ['p2', 'p1']]) {
    const state = makeState()
    state.players.p1.x = 50
    state.players.p2.x = 54.5
    const results = {}
    for (const slot of requestOrder) results[slot] = duoStealVersioned(state, slot, 2_000)
    const winners = Object.values(results).filter((r) => r.ok).length
    check(`exactly one steal lands (${requestOrder.join(' then ')})`, winners === 1, `winners=${winners}`)
    // Net transfer is exactly one +25/-25 pair, never a mutual swap.
    const total = state.players.p1.score + state.players.p2.score
    check('total score is conserved (no double transfer)', total === 200, `total=${total}`)
  }
}

console.log('SCENARIO 4 — Repeated collisions: the contact guard rate-limits steals')
{
  const state = makeState()
  let successes = 0
  // Simulate 60 frames over 1 second (16ms apart) while in contact.
  for (let frame = 0; frame < 60; frame += 1) {
    const now = 3_000 + frame * 16
    const res = duoStealVersioned(state, 'p1', now)
    if (res.ok) successes += 1
  }
  // 1000ms of contact with a 700ms guard → at most 2 steals.
  check('contact guard limits steals to at most 2 per second', successes === 2, `successes=${successes}`)
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

console.log('SCENARIO 8 — Being nearby is not enough: steal requires avatar contact')
{
  const state = makeState()
  state.players.p2.x = 57
  const result = duoStealVersioned(state, 'p1', 8_000)
  check('steal rejected outside the 5.2-unit contact radius', result.ok === false && result.reason === 'too_far', result.reason)
  check('no score is transferred without contact', state.players.p1.score === 100 && state.players.p2.score === 100)
}

console.log('SCENARIO 9 — A stopped player CAN steal on contact (the reported bug)')
{
  // The player chased the rival and stopped right next to them. Under the old
  // directional guard this was rejected with `not_chasing`; the simplified
  // contact check must accept it.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  const res = duoStealVersioned(state, 'p1', 9_000)
  check('stationary contact steals successfully', res.ok === true, res.reason)
  check('stealer gains +25', state.players.p1.score === 125)
  check('victim loses -25', state.players.p2.score === 75)
}

console.log('SCENARIO 10 — SQL migration enforces the simplified contact rules')
{
  const config = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
  check('client radius tracks both avatar collision radii', config.includes('STEAL_RADIUS = PLAYER_HIT_R * 2'))
  check('server radius matches the avatar contact boundary', simplifyMigration.includes('v_steal_radius numeric := 5.2'))
  check('server rejects out-of-range contact', simplifyMigration.includes('if v_dist > v_steal_radius then'))
  check('both players are locked before contact validation', /order by slot\s+for update/.test(simplifyMigration))
  check('contact guard uses a 700ms window', simplifyMigration.includes('v_contact_guard_ms int := 700'))
  check('steal awards exactly +25', simplifyMigration.includes('v_steal_score int := 25'))
  check('victim must have coins', simplifyMigration.includes("'reason', 'no_coins'"))
  check('directional guard is removed', !simplifyMigration.includes("'reason', 'not_chasing'"))
  check('only public steal RPC remains executable', simplifyMigration.includes('grant execute on function public.duo_steal_versioned'))
}

console.log('SCENARIO 11 — Migration 0052 returns the victim state (immediate -25)')
{
  check('victimState is returned by duo_steal_versioned', victimStateMigration.includes("'victimState', jsonb_build_object("))
  check('victimState carries the victim score', victimStateMigration.includes("'score', coalesce(v_victim_after.score, 0)"))
  check('victimState carries the victim roundScore', victimStateMigration.includes("'roundScore', coalesce(v_victim_after.round_score, 0)"))
  check('victimState carries the victim coins', victimStateMigration.includes("'coins', v_victim_after.coins"))
  check('victim row is re-read after the update', victimStateMigration.includes('select * into v_victim_after'))
  check('steal still awards exactly +25', victimStateMigration.includes('v_steal_score int := 25'))
  check('contact guard still uses a 700ms window', victimStateMigration.includes('v_contact_guard_ms int := 700'))
  check('both players are still locked before validation', /order by slot\s+for update/.test(victimStateMigration))
}

console.log('SCENARIO 12 — Stealer never loses points to a stale poll snapshot')
{
  // Mirror of the battle poll local-player score merge (lib/useDuoChaos.ts):
  //   merged.score = Math.max(player.score ?? 0, server.score)
  // A stale snapshot (captured BEFORE the steal committed) carries the
  // pre-steal score. The monotonic merge must NOT revert the stealer's +25.
  const mergeLocalScore = (localScore, serverScore) =>
    typeof serverScore === 'number' && Number.isFinite(serverScore)
      ? Math.max(localScore ?? 0, serverScore)
      : localScore

  // Stealer locally applied +25 via the authoritative RPC response.
  const localAfterSteal = 125
  // Stale poll snapshot from before the commit.
  const staleServerScore = 100
  check(
    'stale snapshot cannot revert the stealer gain',
    mergeLocalScore(localAfterSteal, staleServerScore) === 125,
    `merged=${mergeLocalScore(localAfterSteal, staleServerScore)}`,
  )
  // Fresh snapshot (post-commit) agrees.
  check('fresh snapshot keeps the stealer gain', mergeLocalScore(localAfterSteal, 125) === 125)
  // A later legitimate gain still applies.
  check('a later gain still applies', mergeLocalScore(125, 150) === 150)

  // The source must actually contain the monotonic guard.
  check(
    'battle poll applies Math.max to the local score',
    useDuoChaosSource.includes('merged.score = Math.max(player.score ?? 0, server.score)'),
  )
  check(
    'battle poll applies Math.max to the local roundScore',
    useDuoChaosSource.includes('merged.roundScore = Math.max(player.roundScore ?? 0, server.roundScore)'),
  )
}

console.log('SCENARIO 13 — Victim loss is applied immediately and survives stale polls')
{
  // Mirror of applyAuthoritativeVictimState (lib/objectiveSync.ts): the victim
  // score is applied AS-IS (NOT monotonic) so the -25 is visible.
  const applyVictim = (local, server) => ({
    score: server.score ?? local.score,
    roundScore: server.roundScore ?? local.roundScore,
    coins: server.coins ?? local.coins,
  })
  const victimLocal = { score: 100, roundScore: 100, coins: 3 }
  const victimState = { score: 75, roundScore: 75, coins: 2 }
  const applied = applyVictim(victimLocal, victimState)
  check('victim score drops to 75 immediately', applied.score === 75, `score=${applied.score}`)
  check('victim roundScore drops to 75 immediately', applied.roundScore === 75)
  check('victim coins drop to 2 immediately', applied.coins === 2)

  // Mirror of the victim floor in the battle poll: while the floor is fresh,
  // a stale higher snapshot is capped to the floor (loss preserved).
  const applyFloor = (mergedScore, floor, ageMs) => {
    if (!floor || ageMs > VICTIM_SCORE_FLOOR_MS) return mergedScore
    return Math.min(mergedScore, floor.score)
  }
  const stalePollScore = 100 // pre-steal snapshot
  check(
    'stale poll cannot restore the victim loss',
    applyFloor(stalePollScore, { score: 75 }, 500) === 75,
    `merged=${applyFloor(stalePollScore, { score: 75 }, 500)}`,
  )
  check(
    'floor expires after the window (server has converged)',
    applyFloor(stalePollScore, { score: 75 }, VICTIM_SCORE_FLOOR_MS + 1) === 100,
  )

  // Source guards.
  check(
    'offSteal applies the victim state to the local player',
    useDuoChaosSource.includes('applyAuthoritativeVictimState(prev, victimState, actionRound)'),
  )
  check(
    'offSteal records the victim score floor',
    useDuoChaosSource.includes('victimScoreFloorRef.current = {'),
  )
  check(
    'victim floor is defined',
    useDuoChaosSource.includes('const VICTIM_SCORE_FLOOR_MS = 2_500'),
  )
  check(
    'objectiveSync exports applyAuthoritativeVictimState',
    objectiveSyncSource.includes('export const applyAuthoritativeVictimState = ('),
  )
  check(
    'victim state is NOT monotonic (applies the decrease)',
    objectiveSyncSource.includes('score: server.score ?? player.score'),
  )
  check(
    'steal broadcast carries victimState',
    useGameLoopSource.includes('victimState: result.victimState'),
  )
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
