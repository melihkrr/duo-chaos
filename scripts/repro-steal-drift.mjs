// ============================================================================
// DUO CHAOS — steal drift reproduction.
//
// Simulates the REAL client behaviour that the simple repro missed:
//   * The client moves locally every frame (60Hz) and queues `duo_move`.
//   * When the player enters STEAL_RADIUS, `positionIncludedInAction` becomes
//     true and ALL queued `duo_move` tasks are DROPPED.
//   * The steal RPC then carries the client's CURRENT local position, while the
//     server's stored position is several frames BEHIND.
//
// This script drives the real RPCs and reports the rejection reason, so we can
// confirm whether the drift causes `too_fast` / `not_chasing`.
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/repro-steal-drift.mjs
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

const run = async () => {
  const client = await connect()
  const code = `DR${Math.floor(Math.random() * 9000 + 1000)}`
  const hostToken = `host-${Date.now()}`
  const guestToken = `guest-${Date.now()}`

  try {
    await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
    await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
    await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
    await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
    await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })

    const state = async (token) => rpc(client, 'duo_public_state', { p_code: code, p_token: token })
    const s = await state(hostToken)
    console.log(`phase=${s.phase} round=${s.round}`)

    // Victim with coins, standing still at (50,50).
    const vx = 50
    const vy = 50
    await client.query(`update duo_players set x = $2, y = $3, coins = 5, round_coins = 5 where room_code = $1 and slot = 2`, [code, vx, vy])

    // -----------------------------------------------------------------------
    // Scenario D: client is AHEAD of the server (queued moves dropped).
    //
    // The server's stored position is (44,50) but the client's local position
    // has already advanced to (48,50) — 4 units of drift, exactly the kind of
    // gap produced when `duo_move` tasks are dropped while stealing.
    // The client sends p_x=48, p_from_x=47.6 (its own previous frame).
    // -----------------------------------------------------------------------
    console.log('\n--- Scenario D: client ahead of server (drift) ---')
    await client.query(`update duo_players set x = 44, y = 50, last_move_at = now() where room_code = $1 and slot = 1`, [code])
    await sleep(30)
    const resD = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: hostToken,
      p_expected_objectives_done: 0,
      p_expected_round: s.round,
      p_x: 48,
      p_y: 50,
      p_from_x: 47.6,
      p_from_y: 50,
    })
    console.log(`  result: ${JSON.stringify(resD)}`)

    // -----------------------------------------------------------------------
    // Scenario E: client sends its own from-position but the server position
    // is stale by MORE than the segment length (the validation rejects the
    // caller-supplied segment → falls back to zero-length synthesis).
    // -----------------------------------------------------------------------
    console.log('\n--- Scenario E: from-position far from server position ---')
    await client.query(`update duo_players set x = 44, y = 50, last_move_at = now(), last_stolen_at = 0 where room_code = $1 and slot = 1`, [code])
    await client.query(`update duo_players set coins = 5, round_coins = 5, last_stolen_at = 0 where room_code = $1 and slot = 2`, [code])
    await sleep(30)
    const resE = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: hostToken,
      p_expected_objectives_done: 0,
      p_expected_round: s.round,
      p_x: 48,
      p_y: 50,
      p_from_x: 47.6,
      p_from_y: 50,
    })
    console.log(`  result: ${JSON.stringify(resE)}`)

    // -----------------------------------------------------------------------
    // Scenario F: the client sends a from-position that IS consistent with the
    // server position (the ideal case). This should succeed.
    // -----------------------------------------------------------------------
    console.log('\n--- Scenario F: consistent from-position (ideal) ---')
    await client.query(`update duo_players set x = 44, y = 50, last_move_at = now(), last_stolen_at = 0 where room_code = $1 and slot = 1`, [code])
    await client.query(`update duo_players set coins = 5, round_coins = 5, last_stolen_at = 0 where room_code = $1 and slot = 2`, [code])
    await sleep(30)
    const resF = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: hostToken,
      p_expected_objectives_done: 0,
      p_expected_round: s.round,
      p_x: 48,
      p_y: 50,
      p_from_x: 44,
      p_from_y: 50,
    })
    console.log(`  result: ${JSON.stringify(resF)}`)

    const row = await client.query(
      `select slot, x, y, previous_x, previous_y, previous_position_at, position_updated_at, last_move_at, last_stolen_at from duo_players where room_code = $1 order by slot`,
      [code],
    )
    console.log('\nstored rows:')
    for (const r of row.rows) console.log(' ', JSON.stringify(r))
  } finally {
    await client.query(`delete from duo_players where room_code = $1`, [code]).catch(() => {})
    await client.query(`delete from duo_coins where room_code = $1`, [code]).catch(() => {})
    await client.query(`delete from duo_rooms where code = $1`, [code]).catch(() => {})
    await client.end()
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
