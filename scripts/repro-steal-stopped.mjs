// ============================================================================
// DUO CHAOS — steal repro: player CHASES, makes CONTACT, then STOPS and HOLDS.
//
// This replicates the EXACT production client behaviour that the existing
// repro does NOT cover: after the chase the player stands still on the rival
// for a long time (several seconds) and keeps trying to steal.
//
// The client:
//   * populates `posHistory` EVERY frame (even while stopped),
//   * sends `duo_move` every 16ms while moving and a 1000ms heartbeat while
//     stopped,
//   * computes the lookback as the closest sample at least 350ms old.
//
// Expected (correct) behaviour: the steal should keep succeeding until the
// victim runs out of coins. If it returns `not_chasing` while in contact, the
// lookback window is broken.
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/repro-steal-stopped.mjs
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

const MOVE_SPEED = 38
const MOVE_SEND_MS = 16
const MOVE_HEARTBEAT_MS = 1000
const STEAL_COOLDOWN_MS = 700
const STEAL_RADIUS = 2.6 * 2
const STEAL_CONTACT_SLACK = 1.2
const FRAME_MS = 16.7

const setup = async (client, code, hostToken, guestToken) => {
  await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
  await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
  await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
  await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
  await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })
}

const run = async () => {
  const client = await connect()
  const code = `ST${Math.floor(Math.random() * 9000 + 1000)}`
  const hostToken = `host-${Date.now()}`
  const guestToken = `guest-${Date.now()}`

  try {
    await setup(client, code, hostToken, guestToken)
    const s0 = await rpc(client, 'duo_public_state', { p_code: code, p_token: hostToken })
    console.log(`phase=${s0.phase} round=${s0.round}`)

    const vx = 50
    const vy = 50
    // Victim stands still with plenty of coins.
    await client.query(
      `update duo_players set x = $2, y = $3, coins = 20, round_coins = 20 where room_code = $1 and slot = 2`,
      [code, vx, vy],
    )
    let sx = vx - 10
    let sy = vy
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [code, sx, sy])
    await sleep(50)

    console.log('\n--- CHASE (30 frames) then HOLD STILL (120 frames) ---')
    let lastStealAt = -Infinity
    let lastMoveSentAt = -Infinity
    let lastHeartbeatAt = -Infinity
    let attempts = 0
    let successes = 0
    const reasons = {}
    const t0 = Date.now()
    const history = []
    // FIXED CLIENT (0057): persistent CHASE ANCHOR — the position where the
    // player was FARTHEST from the rival while in contact. Survives buffer
    // eviction and gives a large, meaningful displacement.
    let chaseAnchor = null
    const CHASE_FRAMES = 30

    for (let frame = 0; frame < 150; frame += 1) {
      const now = Date.now() - t0
      const fromX = sx
      const fromY = sy
      const moving = frame < CHASE_FRAMES

      if (moving) {
        const dx = vx - sx
        const dy = vy - sy
        const len = Math.hypot(dx, dy) || 1
        const step = MOVE_SPEED * (FRAME_MS / 1000)
        if (len > 0.01) {
          sx += (dx / len) * step
          sy += (dy / len) * step
        }
      }
      // Client populates posHistory EVERY frame (moving or not). 0056: 2000ms.
      history.push({ x: sx, y: sy, at: now })
      while (history.length > 0 && now - history[0].at > 2000) history.shift()
      // FIXED CLIENT (0057): maintain the CHASE ANCHOR — the position where the
      // player was FARTHEST from the rival while in contact.
      const rivalDist = Math.hypot(vx - sx, vy - sy)
      if (rivalDist <= STEAL_RADIUS + STEAL_CONTACT_SLACK) {
        if (!chaseAnchor || rivalDist > chaseAnchor.dist) {
          chaseAnchor = { x: sx, y: sy, at: now, dist: rivalDist }
        }
      } else if (rivalDist > (STEAL_RADIUS + STEAL_CONTACT_SLACK) * 2) {
        chaseAnchor = null
      }

      // duo_move: every 16ms while moving, 1000ms heartbeat while stopped.
      const heartbeatDue = now - lastHeartbeatAt >= MOVE_HEARTBEAT_MS
      if ((moving && now - lastMoveSentAt >= MOVE_SEND_MS) || heartbeatDue) {
        lastMoveSentAt = now
        if (heartbeatDue) lastHeartbeatAt = now
        await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: sx, p_y: sy })
      }

      const dist = Math.hypot(vx - sx, vy - sy)
      if (dist <= STEAL_RADIUS + STEAL_CONTACT_SLACK && now - lastStealAt >= STEAL_COOLDOWN_MS) {
        attempts += 1
        // FIXED CLIENT (0057): send the CHASE ANCHOR — the position where the
        // player was farthest from the rival while in contact. The server
        // treats this as a DISPLACEMENT, so the anchor gives a large, robust
        // gain regardless of how long the player has been standing still.
        let lookbackX = null
        let lookbackY = null
        let lookbackAt = null
        if (chaseAnchor) {
          lookbackX = chaseAnchor.x
          lookbackY = chaseAnchor.y
          lookbackAt = chaseAnchor.at
        }
        const res = await rpc(client, 'duo_steal_versioned', {
          p_code: code,
          p_token: hostToken,
          p_expected_objectives_done: 0,
          p_expected_round: s0.round,
          p_x: sx,
          p_y: sy,
          p_from_x: fromX,
          p_from_y: fromY,
          p_lookback_x: lookbackX,
          p_lookback_y: lookbackY,
          p_lookback_at: lookbackAt,
        })
        const reason = res.ok ? 'OK' : (res.reason ?? 'unknown')
        reasons[reason] = (reasons[reason] ?? 0) + 1
        if (res.ok) {
          successes += 1
          lastStealAt = now
          console.log(`  frame ${frame}: OK (dist=${dist.toFixed(2)}, moving=${moving})`)
        } else if (attempts <= 20) {
          console.log(`  frame ${frame}: ${reason} (dist=${dist.toFixed(2)}, moving=${moving}, lb=${lookbackX === null ? 'null' : lookbackX.toFixed(2)})`)
        }
      }

      await sleep(FRAME_MS)
    }

    console.log(`\nattempts=${attempts} successes=${successes}`)
    console.log('reasons:', JSON.stringify(reasons))

    const rows = await client.query(
      `select slot, x, y, coins, stolen, last_stolen_at, last_move_at, previous_x, previous_position_at, position_updated_at from duo_players where room_code = $1 order by slot`,
      [code],
    )
    console.log('\nstored rows:')
    for (const r of rows.rows) console.log(' ', JSON.stringify(r))
  } finally {
    await client.end()
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
