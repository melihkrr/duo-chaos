// ============================================================================
// DUO CHAOS — faithful end-to-end steal simulation (production client loop).
//
// Replicates the EXACT client behaviour:
//   * 60Hz frames (dt = 16.7ms)
//   * `duo_move` heartbeat every MOVE_SEND_MS (16ms) while moving
//   * the steal trigger uses the FRESHEST RAW rival position + STEAL_CONTACT_SLACK
//   * on trigger, the steal RPC is called with p_x/p_y = this frame's position
//     and p_from_x/p_from_y = the previous frame's position
//   * the 700ms cooldown is consumed ONLY on a successful steal
//
// It reports the rejection reason for every attempt so we can see what the
// production server actually answers.
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/repro-steal-live-loop.mjs
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

// Client constants (mirror lib/config.ts + useGameLoop.ts).
const MOVE_SPEED = 38
const MOVE_SEND_MS = 16
const STEAL_COOLDOWN_MS = 700
const STEAL_RADIUS = 2.6 * 2 // 5.2
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
  const code = `LP${Math.floor(Math.random() * 9000 + 1000)}`
  const hostToken = `host-${Date.now()}`
  const guestToken = `guest-${Date.now()}`

  try {
    await setup(client, code, hostToken, guestToken)
    const s0 = await rpc(client, 'duo_public_state', { p_code: code, p_token: hostToken })
    console.log(`phase=${s0.phase} round=${s0.round}`)

    // Victim stands still at (50,50) with coins.
    const vx = 50
    const vy = 50
    await client.query(
      `update duo_players set x = $2, y = $3, coins = 5, round_coins = 5 where room_code = $1 and slot = 2`,
      [code, vx, vy],
    )
    // Stealer starts 10 units to the left and walks in at MOVE_SPEED.
    let sx = vx - 10
    let sy = vy
    await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [code, sx, sy])
    await sleep(50)

    console.log('\n--- Live-loop simulation: walking stealer, 60Hz frames ---')
    let lastStealAt = -Infinity
    let lastMoveSentAt = -Infinity
    let attempts = 0
    let successes = 0
    const reasons = {}
    const t0 = Date.now()
    // Client-side position history (mirrors `posHistory` in useGameLoop.ts).
    const history = []

    for (let frame = 0; frame < 120; frame += 1) {
      const now = Date.now() - t0
      const fromX = sx
      const fromY = sy

      // Move one frame toward the victim (client resolves movement locally).
      const dx = vx - sx
      const dy = vy - sy
      const len = Math.hypot(dx, dy) || 1
      const step = MOVE_SPEED * (FRAME_MS / 1000)
      if (len > 0.01) {
        sx += (dx / len) * step
        sy += (dy / len) * step
      }
      history.push({ x: sx, y: sy, at: now })
      while (history.length > 0 && now - history[0].at > 500) history.shift()

      // `duo_move` heartbeat (client sends every MOVE_SEND_MS while moving).
      if (now - lastMoveSentAt >= MOVE_SEND_MS) {
        lastMoveSentAt = now
        await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: sx, p_y: sy })
      }

      // Client steal trigger: freshest RAW rival position + slack.
      const dist = Math.hypot(vx - sx, vy - sy)
      const inRange = dist <= STEAL_RADIUS + STEAL_CONTACT_SLACK
      if (inRange && now - lastStealAt >= STEAL_COOLDOWN_MS) {
        attempts += 1
        // Lookback: the closest sample at least 350ms old.
        let lookbackX = null
        let lookbackY = null
        for (let i = history.length - 1; i >= 0; i -= 1) {
          if (history[i].at <= now - 350) {
            lookbackX = history[i].x
            lookbackY = history[i].y
            break
          }
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
        })
        const reason = res.ok ? 'OK' : (res.reason ?? 'unknown')
        reasons[reason] = (reasons[reason] ?? 0) + 1
        if (res.ok) {
          successes += 1
          lastStealAt = now
          console.log(`  frame ${frame}: OK (dist=${dist.toFixed(2)})`)
        } else if (attempts <= 12) {
          console.log(`  frame ${frame}: ${reason} (dist=${dist.toFixed(2)})`)
        }
      }

      await sleep(FRAME_MS)
    }

    console.log(`\nattempts=${attempts} successes=${successes}`)
    console.log('reasons:', JSON.stringify(reasons))

    // --- Scenario 2: player CHASES then STOPS on the rival (very common) ---
    // This is the real production sequence: the player walks onto the rival,
    // makes contact, and then holds still. At the moment of contact the
    // instantaneous approach is ~0, so 0049-0054 rejected every attempt with
    // `not_chasing`. 0055 must accept it via the lookback window.
    console.log('\n--- Live-loop simulation: stealer CHASES then STOPS on the rival ---')
    await client.query(
      `update duo_players set x = $2, y = $3, coins = 5, round_coins = 5, last_stolen_at = 0 where room_code = $1 and slot = 2`,
      [code, vx, vy],
    )
    // Start 10 units away and walk in, exactly like the walking scenario.
    sx = vx - 10
    sy = vy
    await client.query(
      `update duo_players set x = $2, y = $3, last_stolen_at = 0 where room_code = $1 and slot = 1`,
      [code, sx, sy],
    )
    await sleep(50)
    let stoppedAttempts = 0
    let stoppedSuccesses = 0
    const stoppedReasons = {}
    const t1 = Date.now()
    let lastStealAt2 = -Infinity
    let lastMoveSentAt2 = -Infinity
    // Client-side position history (mirrors `posHistory` in useGameLoop.ts).
    const stoppedHistory = []
    // Phase 1 (frames 0-25): walk in. Phase 2 (frames 26+): hold still.
    const CHASE_FRAMES = 26
    for (let frame = 0; frame < 90; frame += 1) {
      const now = Date.now() - t1
      const fromX = sx
      const fromY = sy
      if (frame < CHASE_FRAMES) {
        const dx = vx - sx
        const dy = vy - sy
        const len = Math.hypot(dx, dy) || 1
        const step = MOVE_SPEED * (FRAME_MS / 1000)
        if (len > 0.01) {
          sx += (dx / len) * step
          sy += (dy / len) * step
        }
      }
      stoppedHistory.push({ x: sx, y: sy, at: now })
      while (stoppedHistory.length > 0 && now - stoppedHistory[0].at > 500) stoppedHistory.shift()

      // `duo_move` heartbeat while moving (mirrors the client).
      if (frame < CHASE_FRAMES && now - lastMoveSentAt2 >= MOVE_SEND_MS) {
        lastMoveSentAt2 = now
        await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: sx, p_y: sy })
      }

      const dist = Math.hypot(vx - sx, vy - sy)
      if (dist <= STEAL_RADIUS + STEAL_CONTACT_SLACK && now - lastStealAt2 >= STEAL_COOLDOWN_MS) {
        stoppedAttempts += 1
        // Lookback: closest sample at least 350ms old.
        let lookbackX = null
        let lookbackY = null
        for (let i = stoppedHistory.length - 1; i >= 0; i -= 1) {
          if (stoppedHistory[i].at <= now - 350) {
            lookbackX = stoppedHistory[i].x
            lookbackY = stoppedHistory[i].y
            break
          }
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
        })
        const reason = res.ok ? 'OK' : (res.reason ?? 'unknown')
        stoppedReasons[reason] = (stoppedReasons[reason] ?? 0) + 1
        if (res.ok) {
          stoppedSuccesses += 1
          lastStealAt2 = now
          console.log(`  frame ${frame}: OK (dist=${dist.toFixed(2)})`)
        } else if (stoppedAttempts <= 12) {
          console.log(`  frame ${frame}: ${reason} (dist=${dist.toFixed(2)})`)
        }
      }
      await sleep(FRAME_MS)
    }
    console.log(`attempts=${stoppedAttempts} successes=${stoppedSuccesses}`)
    console.log('reasons:', JSON.stringify(stoppedReasons))

    const rows = await client.query(
      `select slot, x, y, coins, stolen, last_stolen_at, last_move_at from duo_players where room_code = $1 order by slot`,
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
