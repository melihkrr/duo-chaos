// ============================================================================
// DUO CHAOS — live steal reproduction.
//
// Drives the REAL RPCs against the live database exactly like the client does
// and reports the rejection reason for each steal attempt. This isolates
// whether the failure is server-side (RPC logic) or client-side (call shape).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/repro-steal.mjs
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
  const code = `ST${Math.floor(Math.random() * 9000 + 1000)}`
  const hostToken = `host-${Date.now()}`
  const guestToken = `guest-${Date.now()}`

  try {
    await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
    await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
    await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
    await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
    await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })

    const state = async (token) => rpc(client, 'duo_public_state', { p_code: code, p_token: token })
    let s = await state(hostToken)
    console.log(`phase=${s.phase} round=${s.round}`)
    const host = s.players.find((p) => p.id === 'p1')
    const guest = s.players.find((p) => p.id === 'p2')
    console.log(`host=(${host.x},${host.y}) guest=(${guest.x},${guest.y})`)

    // Give the victim coins so the steal is not rejected as no_coins.
    await client.query(`update duo_players set coins = 5, round_coins = 5 where room_code = $1 and slot = 2`, [code])

    // --- Scenario A: stealer WALKS toward the victim (moving) -------------
    // Place the victim at a fixed spot, then move the stealer toward it in
    // small steps (like the client's 60Hz frames) and attempt a steal.
    const vx = 50
    const vy = 50
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 2`, [code, vx, vy])
    // Stealer starts 12 units away and walks in.
    let sx = vx - 12
    let sy = vy
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [code, sx, sy])
    await sleep(50)

    console.log('\n--- Scenario A: moving stealer ---')
    let lastReason = null
    for (let step = 0; step < 40; step += 1) {
      const fromX = sx
      const fromY = sy
      // Move ~0.6 units per frame toward the victim (MOVE_SPEED * 16ms).
      const dx = vx - sx
      const dy = vy - sy
      const len = Math.hypot(dx, dy) || 1
      sx += (dx / len) * 0.6
      sy += (dy / len) * 0.6
      await sleep(16)
      const res = await rpc(client, 'duo_steal_versioned', {
        p_code: code,
        p_token: hostToken,
        p_expected_objectives_done: 0,
        p_expected_round: s.round,
        p_x: sx,
        p_y: sy,
        p_from_x: fromX,
        p_from_y: fromY,
      })
      lastReason = res.reason ?? (res.ok ? 'OK' : 'unknown')
      if (res.ok) {
        console.log(`  step ${step}: OK stolen=${res.stolen} score=${res.score}`)
        break
      }
      if (step % 5 === 0) console.log(`  step ${step}: ${lastReason}`)
    }
    console.log(`  final: ${lastReason}`)

    // --- Scenario B: stealer STANDS on the victim (not moving) ------------
    console.log('\n--- Scenario B: standing on victim ---')
    await client.query(`update duo_players set coins = 5, round_coins = 5, last_stolen_at = 0 where room_code = $1 and slot = 2`, [code])
    await client.query(`update duo_players set last_stolen_at = 0 where room_code = $1 and slot = 1`, [code])
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [code, vx, vy])
    await sleep(50)
    const resB = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: hostToken,
      p_expected_objectives_done: 0,
      p_expected_round: s.round,
      p_x: vx,
      p_y: vy,
      p_from_x: vx,
      p_from_y: vy,
    })
    console.log(`  result: ${JSON.stringify(resB)}`)

    // --- Scenario C: stealer moves onto victim in ONE frame (teleport-ish) -
    console.log('\n--- Scenario C: single-frame approach ---')
    await client.query(`update duo_players set coins = 5, round_coins = 5, last_stolen_at = 0 where room_code = $1 and slot = 2`, [code])
    await client.query(`update duo_players set last_stolen_at = 0 where room_code = $1 and slot = 1`, [code])
    const startX = vx - 4
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [code, startX, vy])
    await sleep(50)
    const resC = await rpc(client, 'duo_steal_versioned', {
      p_code: code,
      p_token: hostToken,
      p_expected_objectives_done: 0,
      p_expected_round: s.round,
      p_x: vx,
      p_y: vy,
      p_from_x: startX,
      p_from_y: vy,
    })
    console.log(`  result: ${JSON.stringify(resC)}`)

    // Dump the stored row to inspect previous_* / position_updated_at.
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
