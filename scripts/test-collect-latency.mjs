// ============================================================================
// DUO CHAOS — live test for the CONCURRENT collect path (latency optimization).
//
// BACKGROUND
//   The client used to issue, per frame with a nearby coin:
//       await duo_move(...)            // RTT #1
//       for (coin of coins) await duo_collect(...)  // RTT #2..N (serialized)
//   That sequential chain added at least one full network round-trip before the
//   authoritative objective progress could be applied → "progress appears late".
//
//   The optimization fires the position refresh AND all collects CONCURRENTLY:
//       void duo_move(...)                       // fire-and-forget
//       for (coin of coins) void duo_collect(...) // concurrent, applied on resolve
//
//   This is safe because:
//     * `duo_move` is idempotent (writes x/y only).
//     * `duo_collect` locks the player row `FOR UPDATE` (0039), serializing
//       concurrent actions per player so none is lost or double-counted.
//
// WHAT THIS TEST PROVES
//   It reproduces the EXACT new client sequence against the LIVE DB: for each
//   "frame" it fires `duo_move` + N `duo_collect` calls on SEPARATE connections
//   SIMULTANEOUSLY (no ordering), then asserts:
//     1. every valid collect is accepted exactly once (round_coins invariant),
//     2. objective progress is monotonic and never exceeds the collected count,
//     3. no duplicate counting (round_coins == distinct coins collected),
//     4. it holds across MANY rapid frames (stress).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/test-collect-latency.mjs
// ============================================================================

import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
const DB_NAME = process.env.SUPABASE_DB_NAME ?? 'postgres'
const DB_USER = process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`

if (!PASSWORD) {
  console.error('\u2716 SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const candidates = [
  { label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' },
  { label: 'pooler aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: DB_USER },
  { label: 'pooler-session aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, user: DB_USER },
]

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2718 ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

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
      console.log(`\u2714 connected via ${candidate.label}\n`)
      return client
    } catch (error) {
      lastError = error
      try {
        await client.end()
      } catch {
        /* ignore */
      }
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

// A dedicated connection per concurrent call — this is what makes the race
// real: each call runs in its own transaction/session, exactly like two
// overlapping HTTP requests from the client.
const connectOne = async () => {
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
      return client
    } catch {
      try {
        await client.end()
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error('could not open a dedicated connection')
}

// Room codes must match ^[A-Z0-9]{6}$ (exactly 6 chars).
const makeCode = (prefix) =>
  `${prefix}${Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')}`.slice(0, 6)

const blueObjective = {
  id: 'collect-blue-4',
  kind: 'collect',
  label: 'Collect 4 Blue',
  shortLabel: '4 Blue',
  target: 4,
  coinType: 'blue',
  points: 60,
}

const bootstrapRoom = async (client, code, hostToken, guestToken) => {
  await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
  await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
  await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
  await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
  await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })
  await rpc(client, 'duo_spawn_coins', { p_room: code })
}

const forceObjective = async (client, code, objective) => {
  await client.query(
    `update duo_players
       set objective = $2::jsonb,
           objective_progress = 0,
           collected_types = '{}'::jsonb,
           coins = 0,
           stolen = 0,
           round_coins = 0,
           mission_done = false
     where room_code = $1 and slot = 1`,
    [code, JSON.stringify(objective)],
  )
}

// Arena centre — MUST be inside ARENA {minX:5,maxX:95,minY:7,maxY:93} so that
// `duo_clamp_pos` (applied by `duo_move`) does NOT move the player away from the
// coins. Using an out-of-arena value (e.g. 500) would clamp the player to the
// edge and every collect would be rejected `too_far` — a test-harness bug, not
// a client bug.
const CENTER_X = 50
const CENTER_Y = 50

// Move the host to the centre and stack all coins of the given types on it.
const stackCoins = async (client, code, types) => {
  await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [
    code,
    CENTER_X,
    CENTER_Y,
  ])
  await client.query(
    `update duo_coins set x = $2, y = $3, collected_by = null, respawn_at = 0
      where room_code = $1 and type::text = any($4::text[])`,
    [code, CENTER_X, CENTER_Y, types],
  )
  const { rows } = await client.query(
    `select coin_id, type from duo_coins where room_code = $1 and type::text = any($2::text[]) order by coin_id`,
    [code, types],
  )
  return rows
}

const readPlayer = async (client, code) => {
  const { rows } = await client.query(
    `select coins, round_coins, collected_types, objective_progress, objective,
            mission_done, objectives_done
       from duo_players where room_code = $1 and slot = 1`,
    [code],
  )
  return rows[0]
}

// ---------------------------------------------------------------------------
// THE CORE SIMULATION: one "frame" = fire duo_move + all collects CONCURRENTLY
// on separate connections, exactly like the optimized client. Returns the
// per-call results (in the same order as `coinIds`).
// ---------------------------------------------------------------------------
const fireFrame = async (code, token, x, y, coinIds) => {
  const conns = await Promise.all(coinIds.map(() => connectOne()))
  const moveConn = await connectOne()
  try {
    // Position refresh and ALL collects issued together — no ordering.
    const movePromise = rpc(moveConn, 'duo_move', { p_code: code, p_token: token, p_x: x, p_y: y }).catch(
      () => null,
    )
    const collectPromises = coinIds.map((coinId, i) =>
      rpc(conns[i], 'duo_collect', { p_code: code, p_token: token, p_coin_id: coinId }).catch((e) => ({
        ok: false,
        reason: `error:${e.message}`,
      })),
    )
    const [, ...results] = await Promise.all([movePromise, ...collectPromises])
    return results
  } finally {
    await Promise.all([moveConn, ...conns].map((c) => c.end().catch(() => undefined)))
  }
}

const run = async () => {
  const client = await connect()

  try {
    // ------------------------------------------------------------------------
    // SCENARIO 1: the EXACT new client sequence — concurrent move + 4 collects
    // that COMPLETE the objective. Assert on `round_coins` (never reset).
    // ------------------------------------------------------------------------
    console.log('Scenario 1: concurrent duo_move + 4 duo_collect (objective completes)')
    const code = makeCode('LC')
    const hostToken = `host-${Date.now()}`
    const guestToken = `guest-${Date.now()}`
    await bootstrapRoom(client, code, hostToken, guestToken)
    await forceObjective(client, code, blueObjective)
    const blueRows = await stackCoins(client, code, ['blue'])
    const blueIds = blueRows.map((r) => r.coin_id)
    console.log(`Blue coins on map: ${blueIds.length} (ids: ${blueIds.join(', ')})`)

    const results = await fireFrame(code, hostToken, CENTER_X, CENTER_Y, blueIds)
    const okCount = results.filter((r) => r && r.ok).length
    console.log(`  accepted collects: ${okCount}/${blueIds.length}`)
    check('every concurrent collect was accepted', okCount === blueIds.length, `got ${okCount}`)

    const after = await readPlayer(client, code)
    console.log(
      `  after: roundCoins=${after.round_coins} coins=${after.coins} progress=${after.objective_progress} objectivesDone=${after.objectives_done}`,
    )
    check(
      'round_coins == number of blue coins collected (no lost collection)',
      Number(after.round_coins) === blueIds.length,
      `roundCoins=${after.round_coins} expected=${blueIds.length}`,
    )
    check(
      'objective completed (objectivesDone advanced) — the 4th collect counted',
      Number(after.objectives_done) >= 1,
      `objectivesDone=${after.objectives_done}`,
    )

    // ------------------------------------------------------------------------
    // SCENARIO 2: concurrent move + 3 collects that do NOT complete the
    // objective — here coins/collected_types/progress must be EXACT (no reroll).
    // ------------------------------------------------------------------------
    console.log('\nScenario 2: concurrent move + 3 collects (3/4, no reroll) count exactly once')
    const code2 = makeCode('LS')
    const host2 = `host2-${Date.now()}`
    const guest2 = `guest2-${Date.now()}`
    await bootstrapRoom(client, code2, host2, guest2)
    await forceObjective(client, code2, blueObjective)
    const blueRows2 = await stackCoins(client, code2, ['blue'])
    const blueIds2 = blueRows2.map((r) => r.coin_id)
    const take2 = blueIds2.slice(0, 3) // deliberately leave one uncollected
    const results2 = await fireFrame(code2, host2, CENTER_X, CENTER_Y, take2)
    const ok2 = results2.filter((r) => r && r.ok).length
    const after2 = await readPlayer(client, code2)
    console.log(`  accepted: ${ok2}/${take2.length}  coins=${after2.coins} progress=${after2.objective_progress}`)
    check('sequential-equivalent: all 3 accepted', ok2 === take2.length, `got ${ok2}`)
    check(
      'coins == number collected (no reroll)',
      Number(after2.coins) === take2.length,
      `coins=${after2.coins} expected=${take2.length}`,
    )
    check(
      'collectedTypes.blue == number collected (no reroll)',
      Number(after2.collected_types?.blue ?? 0) === take2.length,
      `blue=${after2.collected_types?.blue} expected=${take2.length}`,
    )
    check(
      'objective_progress == number collected (no reroll)',
      Number(after2.objective_progress) === take2.length,
      `progress=${after2.objective_progress} expected=${take2.length}`,
    )
    check(
      'objective NOT completed (objectivesDone still 0)',
      Number(after2.objectives_done) === 0,
      `objectivesDone=${after2.objectives_done}`,
    )

    // ------------------------------------------------------------------------
    // SCENARIO 3: STRESS — many rapid frames, each firing move + collects
    // concurrently. Assert the per-round total is EXACTLY the number of
    // distinct coins collected (no loss, no duplication) and progress is
    // monotonic (never exceeds the collected count).
    // ------------------------------------------------------------------------
    console.log('\nScenario 3: stress — 12 rapid concurrent frames (no loss / no duplication)')
    const code3 = makeCode('LX')
    const host3 = `host3-${Date.now()}`
    const guest3 = `guest3-${Date.now()}`
    await bootstrapRoom(client, code3, host3, guest3)
    // A high target so the objective does NOT complete mid-stress (keeps
    // coins/collected_types/progress as exact invariants).
    const bigObjective = {
      id: 'collect-blue-99',
      kind: 'collect',
      label: 'Collect 99 Blue',
      shortLabel: '99 Blue',
      target: 99,
      coinType: 'blue',
      points: 60,
    }
    await forceObjective(client, code3, bigObjective)
    const stressRows = await stackCoins(client, code3, ['blue'])
    const stressIds = stressRows.map((r) => r.coin_id)
    console.log(`Blue coins available for stress: ${stressIds.length}`)

    let collectedSoFar = 0
    let monotonic = true
    let lastProgress = 0
    // Fire frames of up to 4 coins each, concurrently, back-to-back.
    const frameSize = 4
    const frames = Math.min(12, Math.ceil(stressIds.length / frameSize))
    for (let f = 0; f < frames; f += 1) {
      const slice = stressIds.slice(f * frameSize, f * frameSize + frameSize)
      if (slice.length === 0) break
      const res = await fireFrame(code3, host3, CENTER_X, CENTER_Y, slice)
      collectedSoFar += res.filter((r) => r && r.ok).length
      const snap = await readPlayer(client, code3)
      const progress = Number(snap.objective_progress)
      if (progress < lastProgress) monotonic = false
      if (progress > collectedSoFar) monotonic = false
      lastProgress = progress
    }

    const after3 = await readPlayer(client, code3)
    console.log(
      `  frames=${frames} accepted=${collectedSoFar} roundCoins=${after3.round_coins} coins=${after3.coins} progress=${after3.objective_progress}`,
    )
    check(
      'stress: round_coins == accepted collects (no lost collection)',
      Number(after3.round_coins) === collectedSoFar,
      `roundCoins=${after3.round_coins} accepted=${collectedSoFar}`,
    )
    check(
      'stress: coins == accepted collects (no duplication)',
      Number(after3.coins) === collectedSoFar,
      `coins=${after3.coins} accepted=${collectedSoFar}`,
    )
    check(
      'stress: collectedTypes.blue == accepted collects',
      Number(after3.collected_types?.blue ?? 0) === collectedSoFar,
      `blue=${after3.collected_types?.blue} accepted=${collectedSoFar}`,
    )
    check(
      'stress: objective_progress == accepted collects',
      Number(after3.objective_progress) === collectedSoFar,
      `progress=${after3.objective_progress} accepted=${collectedSoFar}`,
    )
    check('stress: progress was MONOTONIC and never exceeded collected count', monotonic)

    console.log(
      `\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2716 FAILURES DETECTED'} — ${passed} passed, ${failed} failed`,
    )
  } finally {
    await client.end().catch(() => undefined)
  }
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('\u2716 test crashed:', error)
  process.exit(1)
})
