// ============================================================================
// DUO CHAOS — anti-cheat regression for the 0057 lookback DISPLACEMENT rule.
//
// 0057 lets a player who chased, made contact, and then STOPPED still steal by
// sending a "chase anchor" (the position where they were farthest from the
// rival). The server accepts when
//
//     dist(victim, anchor) - dist(victim, now) >= 2.0
//     and that gain > the opponent's own gain + 1.0
//
// This test drives the REAL RPCs against the live database and asserts the
// anti-cheat guarantee is preserved:
//
//   1. A STATIONARY victim (never moved) cannot steal from a pursuer who runs
//      into them, even if the victim sends a bogus far-away anchor.
//   2. A player who genuinely chased and then stopped CAN steal (the fix).
//   3. A player who never moved cannot steal (no anchor).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/test-steal-lookback-anticheat.mjs
// ============================================================================

import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
const DB_NAME = process.env.SUPABASE_DB_NAME ?? 'postgres'
const DB_USER = process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`

if (!PASSWORD) {
  console.error('✖ SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const candidates = [
  { label: 'pooler-session aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, user: DB_USER },
  { label: 'pooler aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: DB_USER },
  { label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' },
]

const connect = async () => {
  let lastError
  for (const candidate of candidates) {
    const client = new Client({
      host: candidate.host,
      port: candidate.port,
      user: candidate.user,
      password: PASSWORD,
      database: DB_NAME,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    })
    try {
      await client.connect()
      console.log(`✔ connected via ${candidate.label}\n`)
      return client
    } catch (error) {
      lastError = error
      try { await client.end() } catch { /* ignore */ }
    }
  }
  throw new Error(`could not connect: ${lastError?.message}`)
}

const rpc = async (client, fn, args) => {
  const keys = Object.keys(args)
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
  const values = keys.map((k) => args[k])
  const { rows } = await client.query(`select ${fn}(${placeholders}) as result`, values)
  return rows[0].result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const setup = async (client, code, hostToken, guestToken) => {
  await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
  await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
  await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
  await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
  await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })
}

const run = async () => {
  const client = await connect()
  const code = `AC${Math.floor(Math.random() * 9000 + 1000)}`
  const hostToken = `host-${Date.now()}`
  const guestToken = `guest-${Date.now()}`

  try {
    await setup(client, code, hostToken, guestToken)
    const s0 = await rpc(client, 'duo_public_state', { p_code: code, p_token: hostToken })
    console.log(`phase=${s0.phase} round=${s0.round}\n`)

    // ---------------------------------------------------------------------
    // SCENARIO 1 — STATIONARY victim cannot steal from a pursuer, even with a
    // bogus far-away anchor.
    // ---------------------------------------------------------------------
    console.log('SCENARIO 1 — stationary victim cannot steal from a pursuer')
    // Host (slot 1) is the STATIONARY victim at (50,50) with coins.
    // Guest (slot 2) is the PURSUER who runs into them.
    await client.query(
      `update duo_players set x = 50, y = 50, coins = 20, round_coins = 20 where room_code = $1 and slot = 1`,
      [code],
    )
    await client.query(
      `update duo_players set x = 60, y = 50, coins = 20, round_coins = 20 where room_code = $1 and slot = 2`,
      [code],
    )
    await sleep(50)

    // Guest chases host: move guest from 60 → 50 over several frames.
    let gx = 60
    const gy = 50
    for (let i = 0; i < 20; i += 1) {
      const dx = 50 - gx
      const len = Math.abs(dx) || 1
      const step = 38 * (16.7 / 1000)
      if (len > 0.01) gx += (dx / len) * step
      await rpc(client, 'duo_move', { p_code: code, p_token: guestToken, p_x: gx, p_y: gy })
      await sleep(16)
    }
    // Guest is now in contact with the stationary host.
    const dist = Math.hypot(50 - gx, 50 - gy)
    console.log(`  guest reached dist=${dist.toFixed(2)} from stationary host`)

    // The STATIONARY host tries to steal from the pursuer, sending a BOGUS
    // far-away anchor (as if they had chased from (10,50)). This must be
    // rejected: the host never moved, so their real displacement is 0.
    const bogus = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: hostToken,
      p_expected_objectives_done: 0,
      p_expected_round: s0.round,
      p_x: 50,
      p_y: 50,
      p_from_x: 50,
      p_from_y: 50,
      p_lookback_x: 10,
      p_lookback_y: 50,
      p_lookback_at: Date.now() - 1000,
    })
    check(
      'stationary victim with bogus anchor is rejected',
      bogus.ok === false,
      `got ok=${bogus.ok} reason=${bogus.reason}`,
    )
    check(
      'rejection reason is not_chasing',
      bogus.reason === 'not_chasing',
      `got ${bogus.reason}`,
    )

    // The PURSUER (guest) should be able to steal from the stationary host.
    const pursuer = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: guestToken,
      p_expected_objectives_done: 0,
      p_expected_round: s0.round,
      p_x: gx,
      p_y: gy,
      p_from_x: gx - 0.6,
      p_from_y: gy,
      p_lookback_x: 60,
      p_lookback_y: 50,
      p_lookback_at: Date.now() - 500,
    })
    check(
      'pursuer steals from the stationary victim',
      pursuer.ok === true,
      `got ok=${pursuer.ok} reason=${pursuer.reason}`,
    )

    // ---------------------------------------------------------------------
    // SCENARIO 2 — a player who genuinely chased and then STOPPED can steal.
    // ---------------------------------------------------------------------
    console.log('\nSCENARIO 2 — chase then stop can steal (the fix)')
    const code2 = `AC${Math.floor(Math.random() * 9000 + 1000)}`
    const hostToken2 = `host2-${Date.now()}`
    const guestToken2 = `guest2-${Date.now()}`
    await setup(client, code2, hostToken2, guestToken2)
    const s2 = await rpc(client, 'duo_public_state', { p_code: code2, p_token: hostToken2 })

    // Victim (slot 2) stands still at (50,50) with coins.
    await client.query(
      `update duo_players set x = 50, y = 50, coins = 20, round_coins = 20 where room_code = $1 and slot = 2`,
      [code2],
    )
    // Stealer (slot 1) starts 10 units away and chases.
    let sx = 40
    const sy = 50
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [code2, sx, sy])
    await sleep(50)

    // Chase for 30 frames (moving), then hold still.
    for (let frame = 0; frame < 30; frame += 1) {
      const dx = 50 - sx
      const len = Math.abs(dx) || 1
      const step = 38 * (16.7 / 1000)
      if (len > 0.01) sx += (dx / len) * step
      await rpc(client, 'duo_move', { p_code: code2, p_token: hostToken2, p_x: sx, p_y: sy })
      await sleep(16)
    }
    // Now hold still on the rival and steal with the chase anchor (40,50).
    const stopped = await rpc(client, 'duo_steal_versioned', {
      p_code: code2,
      p_token: hostToken2,
      p_expected_objectives_done: 0,
      p_expected_round: s2.round,
      p_x: sx,
      p_y: sy,
      p_from_x: sx,
      p_from_y: sy,
      p_lookback_x: 40,
      p_lookback_y: 50,
      p_lookback_at: Date.now() - 800,
    })
    check(
      'chase-then-stop steal succeeds with a real anchor',
      stopped.ok === true,
      `got ok=${stopped.ok} reason=${stopped.reason}`,
    )

    // ---------------------------------------------------------------------
    // SCENARIO 3 — a player who never moved cannot steal (no anchor).
    // ---------------------------------------------------------------------
    console.log('\nSCENARIO 3 — never-moved player cannot steal')
    const code3 = `AC${Math.floor(Math.random() * 9000 + 1000)}`
    const hostToken3 = `host3-${Date.now()}`
    const guestToken3 = `guest3-${Date.now()}`
    await setup(client, code3, hostToken3, guestToken3)
    const s3 = await rpc(client, 'duo_public_state', { p_code: code3, p_token: hostToken3 })

    await client.query(
      `update duo_players set x = 50, y = 50, coins = 20, round_coins = 20 where room_code = $1 and slot = 1`,
      [code3],
    )
    await client.query(
      `update duo_players set x = 50.5, y = 50, coins = 20, round_coins = 20 where room_code = $1 and slot = 2`,
      [code3],
    )
    await sleep(50)
    const neverMoved = await rpc(client, 'duo_steal_versioned', {
      p_code: code3,
      p_token: hostToken3,
      p_expected_objectives_done: 0,
      p_expected_round: s3.round,
      p_x: 50,
      p_y: 50,
      p_from_x: 50,
      p_from_y: 50,
      p_lookback_x: null,
      p_lookback_y: null,
      p_lookback_at: null,
    })
    check(
      'never-moved player is rejected',
      neverMoved.ok === false,
      `got ok=${neverMoved.ok} reason=${neverMoved.reason}`,
    )

    console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 CHECKS FAILED'} — ${passed} passed, ${failed} failed`)
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    try { await client.end() } catch { /* ignore */ }
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
