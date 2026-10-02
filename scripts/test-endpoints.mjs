#!/usr/bin/env node
/**
 * DUO CHAOS — end-to-end RPC smoke test.
 *
 * Exercises every RPC the client actually calls, in the same order a real
 * match would, and asserts the responses. Run with:
 *
 *   node scripts/test-endpoints.mjs
 *
 * Uses the project's public anon key (safe to embed — it is the anon key).
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const code = `T${Math.random().toString(36).slice(2, 7).toUpperCase()}`.slice(0, 6)
const hostToken = `t-${code}-host`
const guestToken = `t-${code}-guest`

// Walk a player to (tx, ty) in small, time-legal increments. The server
// validates each move against its own stored position + elapsed time
// (migration 0047/0048), so a single teleport is rejected as `too_fast`.
const stepTo = async (roomCode, token, tx, ty) => {
  const { body } = await rpc('duo_public_state', { p_code: roomCode, p_token: token })
  const me = body?.players?.find((p) => p.token === token) ?? body?.players?.[0]
  let x = me?.x ?? 18
  let y = me?.y ?? 50
  const MAX_STEP = 12 // well under the server's per-frame allowance
  for (let guard = 0; guard < 200; guard += 1) {
    const dx = tx - x
    const dy = ty - y
    const dist = Math.hypot(dx, dy)
    if (dist <= 1) return
    const scale = Math.min(1, MAX_STEP / dist)
    x += dx * scale
    y += dy * scale
    await rpc('duo_move', { p_code: roomCode, p_token: token, p_x: x, p_y: y })
    await sleep(20)
  }
}

console.log(`\nDUO CHAOS endpoint test \u2014 room ${code}\n`)

// 1. create
{
  const { status, body } = await rpc('duo_create_room', {
    p_code: code,
    p_token: hostToken,
    p_name: 'Melih',
  })
  check('duo_create_room', status === 200 && body?.name === 'Melih', `${status} ${JSON.stringify(body)}`)
}

// 2. start_round before the rival joins -> must be a SOFT failure, not a 400.
{
  const { status, body } = await rpc('duo_start_round', { p_code: code, p_token: hostToken })
  check(
    'duo_start_round (solo) -> soft not_ready',
    status === 200 && body?.ok === false && body?.reason === 'not_ready',
    `${status} ${JSON.stringify(body)}`,
  )
}

// 3. public_state exposes playerCount = 1
{
  const { status, body } = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  check(
    'duo_public_state playerCount=1',
    status === 200 && body?.playerCount === 1,
    `${status} ${JSON.stringify(body?.playerCount)}`,
  )
}

// 4. join
{
  const { status, body } = await rpc('duo_join_room', {
    p_code: code,
    p_token: guestToken,
    p_name: 'Rival',
  })
  check('duo_join_room', status === 200 && body?.name === 'Rival', `${status} ${JSON.stringify(body)}`)
}

// 5. public_state now reports 2 players
{
  const { status, body } = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  check(
    'duo_public_state playerCount=2',
    status === 200 && body?.playerCount === 2,
    `${status} ${JSON.stringify(body?.playerCount)}`,
  )
}

// 6. rename
{
  const { status, body } = await rpc('duo_set_name', {
    p_code: code,
    p_token: hostToken,
    p_name: 'Melih2',
  })
  check('duo_set_name', status === 200 && body?.name === 'Melih2', `${status} ${JSON.stringify(body)}`)
}

// 7. start_round now succeeds
{
  const { status, body } = await rpc('duo_start_round', { p_code: code, p_token: hostToken })
  check(
    'duo_start_round (ready) -> ok',
    status === 200 && body?.ok === true,
    `${status} ${JSON.stringify(body)}`,
  )
}

// The server holds a 3s countdown before the battle phase begins. Gameplay
// RPCs (collect/steal/scout) correctly reject during the countdown, so wait
// it out, then advance countdown -> battle (this is what the client's game
// loop does automatically).
console.log('  \u2026 waiting for the 3s countdown to elapse')
await sleep(3400)

// 8. advance countdown -> battle
{
  const { status, body } = await rpc('duo_advance_phase', { p_code: code, p_token: hostToken })
  check(
    'duo_advance_phase (countdown -> battle)',
    status === 200 && body?.phase === 'battle',
    `${status} ${JSON.stringify(body)}`,
  )
}

// 9. move
{
  const { status, body } = await rpc('duo_move', {
    p_code: code,
    p_token: hostToken,
    p_x: 30,
    p_y: 40,
  })
  check('duo_move', status === 200 && body?.ok === true, `${status} ${JSON.stringify(body)}`)
}

// 9. collect the first coin. The server now validates reachability from its
//    OWN stored position (migration 0047/0048), so we must move in small,
//    time-legal steps instead of teleporting onto the coin.
{
  const { body: snap } = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  const coin = snap?.coins?.find((c) => !c.collectedBy && c.type !== 'diamond')
  if (coin) {
    await stepTo(code, hostToken, coin.x, coin.y)
    const { status, body } = await rpc('duo_collect', {
      p_code: code,
      p_token: hostToken,
      p_coin_id: coin.id,
    })
    check('duo_collect', status === 200 && body?.ok === true, `${status} ${JSON.stringify(body)}`)
  } else {
    check('duo_collect', false, 'no coins in snapshot')
  }
}

// 10. steal. The victim must actually HOLD coins for a steal to transfer
//     anything, so first walk the guest onto a coin and collect it, then walk
//     the host onto the guest and steal.
{
  const { body: snap } = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  const guestCoin = snap?.coins?.find((c) => !c.collectedBy && c.type !== 'diamond')
  if (guestCoin) {
    await stepTo(code, guestToken, guestCoin.x, guestCoin.y)
    await rpc('duo_collect', { p_code: code, p_token: guestToken, p_coin_id: guestCoin.id })
  }
  const { body: after } = await rpc('duo_public_state', { p_code: code, p_token: hostToken })
  const opp = after?.players?.find((p) => p.id === 'p2')
  if (opp) {
    await stepTo(code, hostToken, opp.x, opp.y)
    const { status, body } = await rpc('duo_steal', { p_code: code, p_token: hostToken })
    check('duo_steal', status === 200 && body?.ok === true, `${status} ${JSON.stringify(body)}`)
  } else {
    check('duo_steal', false, 'no opponent in snapshot')
  }
}

// 11. scout
{
  const { status, body } = await rpc('duo_scout', { p_code: code, p_token: hostToken })
  check('duo_scout', status === 200 && body?.ok === true, `${status} ${JSON.stringify(body)}`)
}

// 13. award progress — returns the updated profile (no `ok` field).
{
  const { status, body } = await rpc('duo_award_progress', {
    p_client_id: `test-${code}`,
    p_xp: 120,
  })
  check(
    'duo_award_progress',
    status === 200 && typeof body?.xp === 'number' && body.xp >= 120,
    `${status} ${JSON.stringify(body)}`,
  )
}

// 14. set cosmetics — `wave`/`sparkle` are locked at level 1, so a locked
// cosmetic must be rejected with `locked_cosmetic` (this is correct behavior).
{
  const { status, body } = await rpc('duo_set_cosmetics', {
    p_client_id: `test-${code}`,
    p_emote: 'wave',
    p_trail: 'sparkle',
    p_avatar: null,
  })
  check(
    'duo_set_cosmetics rejects locked cosmetic',
    status === 400 && body?.message === 'locked_cosmetic',
    `${status} ${JSON.stringify(body)}`,
  )
}

// 14b. set cosmetics with the default (unlocked) values must succeed.
{
  const { status, body } = await rpc('duo_set_cosmetics', {
    p_client_id: `test-${code}`,
    p_emote: null,
    p_trail: null,
    p_avatar: null,
  })
  check(
    'duo_set_cosmetics (defaults)',
    status === 200 && body?.ok === true,
    `${status} ${JSON.stringify(body)}`,
  )
}

// 15. rematch
{
  const { status, body } = await rpc('duo_rematch', { p_code: code, p_token: hostToken })
  check('duo_rematch', status === 200 && body?.ok === true, `${status} ${JSON.stringify(body)}`)
}

// 16. leave (host) then (guest) -> room deleted
{
  const { status, body } = await rpc('duo_leave', { p_code: code, p_token: hostToken })
  check('duo_leave (host)', status === 200 && body?.ok === true, `${status} ${JSON.stringify(body)}`)
  const guest = await rpc('duo_leave', { p_code: code, p_token: guestToken })
  check('duo_leave (guest)', guest.status === 200 && guest.body?.ok === true, `${guest.status}`)
}

console.log(`\n${passes} passed, ${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
