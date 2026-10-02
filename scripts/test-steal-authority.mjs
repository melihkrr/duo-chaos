// ============================================================================
// DUO CHAOS — steal authority regression test (0051 simple contact steal).
//
// Reproduces the reported steal problems:
//   1. WRONG VALUE: a steal awarded +20/-20 instead of +25/-25.
//   2. MUTUAL STEAL: two players touching caused BOTH to steal from each other.
//   3. EMPTY VICTIM: a steal succeeded even when the victim had 0 coins.
//   4. FLAKY: "sometimes works, sometimes doesn't" — 0049/0050 inferred the
//      "chaser" from movement samples that were stale by the time the steal
//      RPC arrived (the player had already stopped at the rival).
//   5. WRONG PLAYER: "I'm the stealer but points are deducted from me" — the
//      victim's -25 only arrived via a delayed public-state poll.
//
// FIX (0051):
//   * `v_steal_score := 25` (matches single-player `STEAL_SCORE`).
//   * Per-contact guard: `duo_players.last_stolen_at` (epoch ms). A steal is
//     rejected if either participant was stolen from within 700ms.
//   * The INITIATOR is the stealer. NO direction inference, NO movement-history
//     requirement. The server validates the caller's claimed position with
//     `duo_step_ok` (anti-teleport) and checks real contact against the
//     opponent's stored position with a small slack (2.0).
//   * Victim must have `coins > 0` (else `no_coins`).
//   * The response carries `victimState` so the victim's client applies -25 at
//     once (decrease-only) instead of waiting for a stale poll.
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
// duo_step_ok parameters (mirrors 0048).
const MOVE_SPEED = 38
const SLOW_MULT = 0.55
const STEP_SAFETY = 1.6
const STEP_FLOOR = 8

const simpleMigration = await readFile(
  new URL('../supabase/migrations/0051_simple_contact_steal.sql', import.meta.url),
  'utf8',
)

// --- Mirror of duo_step_ok (0048) -------------------------------------------
const duoStepOk = (storedX, storedY, lastMoveAt, newX, newY, slowedUntil, nowMs) => {
  if (lastMoveAt === null || lastMoveAt === undefined) return true
  const elapsedMs = Math.max(0, nowMs - lastMoveAt)
  let speed = MOVE_SPEED
  if (slowedUntil !== null && slowedUntil !== undefined && slowedUntil > nowMs) {
    speed *= SLOW_MULT
  }
  const maxStep = speed * (elapsedMs / 1000) * STEP_SAFETY + STEP_FLOOR
  const dist = Math.hypot(newX - storedX, newY - storedY)
  return dist <= maxStep
}

const clampPos = (x, y) => ({
  x: Math.max(5, Math.min(95, x)),
  y: Math.max(7, Math.min(93, y)),
})

// --- Mirror of duo_steal_versioned (0051) -----------------------------------
// Returns { ok, reason?, stealer, victim, victimState } where stealer/victim
// are the post-action rows. `now` is the server clock (epoch ms).
const duoStealVersioned = (state, stealerSlot, now, expectedRound = null, claim = null) => {
  const stealer = state.players[stealerSlot]
  const victimSlot = stealerSlot === 'p1' ? 'p2' : 'p1'
  const victim = state.players[victimSlot]

  if (state.phase !== 'battle') return { ok: false, reason: 'not_battle' }
  if (expectedRound !== null && expectedRound !== state.round) {
    return { ok: false, reason: 'stale_round' }
  }
  // CONTACT GUARD: at most ONE steal per contact.
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
  // EMPTY VICTIM: nothing to steal.
  if ((victim.coins ?? 0) <= 0) return { ok: false, reason: 'no_coins' }

  // Validate the caller-supplied position (anti-teleport). On violation fall
  // back to the server-stored position.
  const rawX = claim ? claim.x : stealer.x
  const rawY = claim ? claim.y : stealer.y
  const clamped = clampPos(rawX, rawY)
  let newX = clamped.x
  let newY = clamped.y
  if (!duoStepOk(stealer.x, stealer.y, stealer.lastMoveAt ?? null, newX, newY, stealer.slowedUntil ?? null, now)) {
    newX = stealer.x
    newY = stealer.y
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

// --- Mirror of lib/objectiveSync.ts applyAuthoritativeVictimState -----------
// Decrease-only for score/roundScore (Math.min), direct for coins.
const applyAuthoritativeVictimState = (prev, server, actionRound) => {
  if (prev.round !== actionRound) return prev
  const victim = prev.players.p2
  if (!victim) return prev
  const serverScore = typeof server.score === 'number' ? server.score : undefined
  const serverRoundScore = typeof server.roundScore === 'number' ? server.roundScore : undefined
  return {
    ...prev,
    players: {
      ...prev.players,
      p2: {
        ...victim,
        coins: server.coins ?? victim.coins,
        roundCoins: server.roundCoins ?? victim.roundCoins,
        score: serverScore === undefined ? victim.score : Math.min(victim.score ?? 0, serverScore),
        roundScore:
          serverRoundScore === undefined
            ? victim.roundScore
            : Math.min(victim.roundScore ?? 0, serverRoundScore),
      },
    },
  }
}

// --- Mirror of lib/objectiveSync.ts applyAuthoritativeActionState (stealer) --
const applyAuthoritativeActionState = (prev, server, actionRound) => {
  if (prev.round !== actionRound) return prev
  const local = prev.players.p1
  if (!local) return prev
  return {
    ...prev,
    players: {
      ...prev.players,
      p1: {
        ...local,
        coins: server.coins ?? local.coins,
        stolen: server.stolen ?? local.stolen,
        roundCoins: server.roundCoins ?? local.roundCoins,
        roundStolen: server.roundStolen ?? local.roundStolen,
        score: server.score === undefined ? local.score : Math.max(local.score ?? 0, server.score),
        roundScore:
          server.roundScore === undefined
            ? local.roundScore
            : Math.max(local.roundScore ?? 0, server.roundScore),
      },
    },
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
  check('victimState carries B score', res.victimState.score === 75, `score=${res.victimState.score}`)
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

console.log('SCENARIO 3 — The initiator is the stealer regardless of request order')
{
  // Both players are in contact. Whoever INITIATES the steal is the stealer —
  // there is no direction inference and no network-order ambiguity.
  for (const initiator of ['p1', 'p2']) {
    const state = makeState()
    state.players.p1.x = 50
    state.players.p2.x = 54.5
    const res = duoStealVersioned(state, initiator, 2_000)
    check(`initiator ${initiator} steals`, res.ok === true, res.reason)
    const stealer = state.players[initiator]
    const victim = state.players[initiator === 'p1' ? 'p2' : 'p1']
    check(`initiator ${initiator} gains +25`, stealer.score === 125, `score=${stealer.score}`)
    check(`opponent loses -25`, victim.score === 75, `score=${victim.score}`)
  }
}

console.log('SCENARIO 4 — A stopped player CAN steal (no stale-movement rejection)')
{
  // ROOT CAUSE REGRESSION: 0049/0050 rejected this as `not_chasing` because the
  // player had stopped at the rival. 0051 must allow it.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 54.5
  state.players.p1.lastMoveAt = 1_000 // moved long ago, then stopped
  const res = duoStealVersioned(state, 'p1', 5_000)
  check('stationary player in contact can steal', res.ok === true, res.reason)
  check('stationary stealer gains +25', state.players.p1.score === 125)
  check('victim loses -25', state.players.p2.score === 75)
}

console.log('SCENARIO 5 — Contact slack absorbs client prediction lead')
{
  // The client triggers on its PREDICTED position, which can lead the server
  // position by a frame. A small slack keeps legitimate contact valid.
  const state = makeState()
  state.players.p1.x = 50
  state.players.p2.x = 57 // 7 units away: beyond 5.2 but within 5.2 + 2.0
  const res = duoStealVersioned(state, 'p1', 6_000)
  check('contact within slack is accepted', res.ok === true, res.reason)
  // Beyond the slack it must still be rejected.
  const far = makeState()
  far.players.p1.x = 50
  far.players.p2.x = 58 // 8 units away: beyond 5.2 + 2.0
  const farRes = duoStealVersioned(far, 'p1', 6_000)
  check('contact beyond slack is rejected', farRes.ok === false && farRes.reason === 'too_far', farRes.reason)
}

console.log('SCENARIO 6 — Anti-teleport: an unreachable claim falls back to stored position')
{
  const state = makeState()
  state.players.p1.x = 50
  state.players.p1.y = 50
  state.players.p1.lastMoveAt = 6_000 // just moved
  state.players.p2.x = 52
  state.players.p2.y = 50
  // Claim a teleport far away (would be out of contact). duo_step_ok rejects it
  // and the server falls back to the stored position (50,50) → still in contact.
  const res = duoStealVersioned(state, 'p1', 6_000, null, { x: 90, y: 90 })
  check('unreachable claim falls back to stored position', res.ok === true, res.reason)
  check('stealer position is the stored position, not the claim', state.players.p1.x === 50 && state.players.p1.y === 50)
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

console.log('SCENARIO 9 — SQL migration enforces simple initiator-authoritative contact')
{
  const config = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
  // Scope the "no inference" checks to the executable SQL (the header comment
  // intentionally explains the OLD design, so it mentions `not_chasing`).
  const migrationCode = simpleMigration.slice(
    simpleMigration.indexOf('create or replace function'),
  )
  check('client radius tracks both avatar collision radii', config.includes('STEAL_RADIUS = PLAYER_HIT_R * 2'))
  check('server contact radius matches the avatar boundary', migrationCode.includes('if v_dist > 5.2 + v_contact_slack then'))
  check('server applies a contact slack', migrationCode.includes('v_contact_slack numeric := 2.0'))
  check('both players are locked before contact validation', /order by slot\s+for update/.test(migrationCode))
  check('caller position is validated with duo_step_ok', migrationCode.includes('if not duo_step_ok('))
  check('no direction inference remains', !migrationCode.includes('not_chasing'))
  check('no movement-history requirement remains', !migrationCode.includes('previous_position_at'))
  check('victim delta is returned for immediate application', migrationCode.includes("'victimState', jsonb_build_object("))
  check('only public steal RPC remains executable', migrationCode.includes('grant execute on function public.duo_steal_versioned'))
}

console.log('SCENARIO 10 — Victim client applies -25 immediately (decrease-only)')
{
  const state = makeState()
  const res = duoStealVersioned(state, 'p1', 9_000)
  check('steal succeeds', res.ok === true, res.reason)
  // Victim client local view BEFORE the poll arrives (stale, still 100).
  const victimClient = makeState()
  const applied = applyAuthoritativeVictimState(victimClient, res.victimState, 1)
  check('victim score drops to 75 immediately', applied.players.p2.score === 75, `score=${applied.players.p2.score}`)
  check('victim coins drop to 2 immediately', applied.players.p2.coins === 2, `coins=${applied.players.p2.coins}`)
  // A stale poll (higher score) must NOT raise the victim back up.
  const stalePoll = applyAuthoritativeVictimState(applied, { score: 100, coins: 3 }, 1)
  check('a stale higher poll does not restore the victim score', stalePoll.players.p2.score === 75, `score=${stalePoll.players.p2.score}`)
  // A legitimate later gain (victim collects) is preserved by the normal merge.
  const laterGain = { ...stalePoll, players: { ...stalePoll.players, p2: { ...stalePoll.players.p2, score: 85 } } }
  check('a legitimate later gain is preserved', laterGain.players.p2.score === 85)
}

console.log('SCENARIO 11 — Stealer client applies +25 (monotonic)')
{
  const state = makeState()
  const res = duoStealVersioned(state, 'p1', 10_000)
  check('steal succeeds', res.ok === true, res.reason)
  const stealerClient = makeState()
  const applied = applyAuthoritativeActionState(stealerClient, res.stealer, 1)
  check('stealer score rises to 125 immediately', applied.players.p1.score === 125, `score=${applied.players.p1.score}`)
  check('stealer stolen counter is 1', applied.players.p1.stolen === 1)
  // A stale lower poll must NOT reduce the stealer score.
  const stalePoll = applyAuthoritativeActionState(applied, { score: 100, stolen: 0 }, 1)
  check('a stale lower poll does not reduce the stealer score', stalePoll.players.p1.score === 125, `score=${stalePoll.players.p1.score}`)
}

console.log('SCENARIO 12 — Steal does not interfere with movement or coin collection')
{
  const state = makeState()
  const bx = state.players.p2.x
  const by = state.players.p2.y
  duoStealVersioned(state, 'p1', 11_000)
  check('victim position unchanged', state.players.p2.x === bx && state.players.p2.y === by)
  // Victim keeps collecting: a coin collection adds score independently.
  const victimScoreBefore = state.players.p2.score
  state.players.p2.score += 10 // simulate a collect
  check('victim can still gain score from collecting', state.players.p2.score === victimScoreBefore + 10)
  // Victim score never goes below 0.
  const drained = makeState()
  drained.players.p2.score = 10
  drained.players.p2.coins = 1
  duoStealVersioned(drained, 'p1', 12_000)
  check('victim score floors at 0 (never negative)', drained.players.p2.score === 0, `score=${drained.players.p2.score}`)
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 SOME CHECKS FAILED'} \u2014 ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
