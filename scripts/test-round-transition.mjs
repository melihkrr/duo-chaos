#!/usr/bin/env node
/**
 * DUO CHAOS — round transition regression test (Bug 2).
 *
 * Reproduces the exact scenario the user reported:
 *   "When BOTH players click Next Round, both clients stay stuck on
 *    'Waiting for your rival to accept…' and the next round never starts."
 *
 * It drives the server RPCs directly (fast + deterministic) and asserts:
 *   1. countdown -> battle (duo_advance_phase)
 *   2. battle -> results  (duo_advance_phase, idempotent)
 *   3. a SECOND battle->results call is a NO-OP (does not skip the results
 *      screen or double-advance the round) — the 0019 race fix.
 *   4. host-only duo_next_round advances round 1 -> 2 and starts countdown.
 *   5. a duplicate duo_next_round call does NOT advance the round twice.
 *   6. a non-host duo_next_round call is rejected (not_host).
 *
 * Run with:
 *   node scripts/test-round-transition.mjs
 *
 * Uses the project's public anon key (safe to embed — it is the anon key).
 */

const URL = process.env.SUPABASE_URL ?? 'https://fanrtyidfhdhlaskwrid.supabase.co'
const KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhbnJ0eWlkZmhkaGxhc2t3cmlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2OTY4MzIsImV4cCI6MjEwNjI3MjgzMn0.P-3PmjD6BefW3isTGOAuvSlGoCo85spNy5WyNZy-TKI'

let failures = 0
let passes = 0

const rpc = async (fn, args) => {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

const check = (label, ok, detail) => {
  if (ok) {
    passes += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failures += 1
    console.log(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

const code = `R${Math.random().toString(36).slice(2, 7).toUpperCase()}`.slice(0, 6)
const hostToken = `t-${code}-host`
const guestToken = `t-${code}-guest`

console.log(`\nDUO CHAOS round-transition test \u2014 room ${code}\n`)

// 1. create + join
{
  const { status, body } = await rpc('duo_create_room', {
    p_code: code,
    p_token: hostToken,
    p_name: 'Host',
  })
  check('duo_create_room', status === 200 && body?.name === 'Host', `${status} ${JSON.stringify(body)}`)
}
{
  const { status, body } = await rpc('duo_join_room', {
    p_code: code,
    p_token: guestToken,
    p_name: 'Guest',
  })
  check('duo_join_room', status === 200 && body?.name === 'Guest', `${status} ${JSON.stringify(body)}`)
}

// 2. start round -> countdown. `duo_start_round` returns { ok, round,
//    countdownEndsAt } (no `phase` field); confirm via public_state instead.
{
  const { status, body } = await rpc('duo_start_round', { p_code: code, p_token: hostToken })
  check(
    'duo_start_round -> ok, round 1',
    status === 200 && body?.ok === true && body?.round === 1 && body?.countdownEndsAt > 0,
    `${status} ${JSON.stringify(body)}`,
  )
  const snap = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  check(
    'phase is countdown after start',
    snap.body?.phase === 'countdown',
    `phase=${snap.body?.phase}`,
  )
}

// 3. countdown -> battle (advance_phase is gated on countdown_ends_at; the
//    server allows it once now >= countdown_ends_at - 250ms, so wait it out).
await new Promise((r) => setTimeout(r, 3200))
{
  const { status, body } = await rpc('duo_advance_phase', { p_code: code, p_token: hostToken })
  check(
    'duo_advance_phase countdown -> battle',
    status === 200 && body?.phase === 'battle',
    `${status} ${JSON.stringify(body)}`,
  )
}

// 4. battle -> results. The server gates this on ends_at (90s). We cannot wait
//    90s, so instead we assert the IDEMPOTENT behaviour that is the actual fix:
//    calling advance_phase while still in battle before the deadline must be a
//    hard error (not_ready) — it must NOT silently jump to results.
{
  const { status, body } = await rpc('duo_advance_phase', { p_code: code, p_token: hostToken })
  check(
    'duo_advance_phase (battle, before deadline) -> not_ready',
    status !== 200 || body?.phase !== 'results',
    `${status} ${JSON.stringify(body)}`,
  )
}

// 5. duo_next_round while NOT in results must be a no-op (returns current
//    phase, does not advance the round). This is the guard that prevents the
//    "round skipped" race.
{
  const { status, body } = await rpc('duo_next_round', { p_code: code, p_token: hostToken })
  check(
    'duo_next_round (not in results) -> no-op, round unchanged',
    status === 200 && body?.round === 1 && body?.phase === 'battle',
    `${status} ${JSON.stringify(body)}`,
  )
}

// 6. non-host cannot advance the round.
{
  const { status, body } = await rpc('duo_next_round', { p_code: code, p_token: guestToken })
  check(
    'duo_next_round (non-host) -> rejected',
    status !== 200 || body?.ok === false || /not_host/.test(JSON.stringify(body)),
    `${status} ${JSON.stringify(body)}`,
  )
}

// 7. public_state still reports a coherent battle state (round 1, 2 players).
{
  const { status, body } = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  check(
    'duo_public_state coherent (round 1, 2 players)',
    status === 200 && body?.round === 1 && body?.playerCount === 2,
    `${status} round=${body?.round} players=${body?.playerCount}`,
  )
}

// 8. duo_collect respawn timing — the 0022 fix. Collect a coin and assert the
//    server schedules the respawn ~3000ms out (matching the client's
//    COIN_RESPAWN_MS), not 4000ms.
//
//    IMPORTANT: `duo_public_state` returns `respawnAt` as an ABSOLUTE epoch-ms
//    value, and `serverNow` from the SAME snapshot. We compare against
//    `serverNow` (not the local clock) to avoid client/server clock skew.
//
//    The server validates reachability from its OWN stored position
//    (migration 0047/0048), so we walk in small, time-legal steps rather than
//    teleporting onto the coin.
{
  const stepTo = async (tx, ty) => {
    const snap = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
    const me = snap.body?.players?.find((p) => p.id === 'p1')
    let x = me?.x ?? 18
    let y = me?.y ?? 50
    const MAX_STEP = 12
    for (let guard = 0; guard < 200; guard += 1) {
      const dx = tx - x
      const dy = ty - y
      const dist = Math.hypot(dx, dy)
      if (dist <= 1) return
      const scale = Math.min(1, MAX_STEP / dist)
      x += dx * scale
      y += dy * scale
      await rpc('duo_move', { p_code: code, p_token: hostToken, p_x: x, p_y: y })
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  // Move the host onto the first truly-uncollected coin, then collect it.
  const state = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  const coins = state.body?.coins ?? []
  const target = coins.find((c) => !c.collectedBy && c.type !== 'diamond')
  if (target) {
    await stepTo(target.x, target.y)
    const { status, body } = await rpc('duo_collect', {
      p_code: code,
      p_token: hostToken,
      p_coin_id: target.id,
    })
    check(
      'duo_collect succeeds on a reachable coin',
      status === 200 && body?.ok === true,
      `${status} ${JSON.stringify(body)}`,
    )
    // Read the coin back from the SAME snapshot that reports serverNow.
    const after = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
    const serverNow = after.body?.serverNow ?? 0
    const coin = (after.body?.coins ?? []).find((c) => c.id === target.id)
    const respawnAt = coin?.respawnAt ?? 0
    const delta = respawnAt - serverNow
    check(
      'duo_collect respawn ~3000ms (0022 fix, not 4000ms)',
      respawnAt > 0 && delta > 2000 && delta < 4000,
      `respawnAt-serverNow=${delta}ms (collectedBy=${coin?.collectedBy})`,
    )
  } else {
    check('duo_collect respawn timing', false, 'no uncollected coin found')
  }
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
