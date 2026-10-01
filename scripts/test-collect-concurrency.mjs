// ============================================================================
// DUO CHAOS — live concurrency test for collection loss (migration 0039).
//
// Reproduces the reported bug:
//   Objective "Collect 4 Blue". The player visibly collects 4 Blue coins, but
//   the objective stays at "3/4" — one valid collection is NOT counted.
//
// ROOT CAUSE (fixed in 0039):
//   `duo_collect` read the player row via `duo_require_player` (a plain SELECT
//   with NO row lock). Two concurrent collections for the SAME player both read
//   the same stale `collected_types`, computed the same `v_collected`, and the
//   second UPDATE overwrote the first → one collection lost. The `for update`
//   only locked the COIN row, not the PLAYER row.
//
// FIX: `duo_collect`/`duo_steal` now lock the player row `FOR UPDATE` at the
//   start, serializing concurrent actions per player so each reads the latest
//   counters and applies atomically.
//
// IMPORTANT SEMANTICS (0031/0033):
//   When an objective is satisfied, `duo_reroll_objective` runs IMMEDIATELY and
//   resets `coins`, `collected_types`, `objective_progress` to 0 for the NEW
//   objective. Therefore `coins`/`collected_types` are NOT a valid "no lost
//   collection" invariant once the objective completes. The per-round total
//   `round_coins` is NEVER reset mid-round, so it is the correct invariant.
//
// This test drives the REAL RPCs against the live DB and fires N concurrent
// `duo_collect` calls for the same player, then asserts that EVERY valid
// collection was counted exactly once (round_coins, collectedTypes, progress).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/test-collect-concurrency.mjs
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

// Shared room bootstrap: create + join + start + advance to battle + spawn.
const bootstrapRoom = async (client, code, hostToken, guestToken) => {
  await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
  await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
  await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
  await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
  await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })
  await rpc(client, 'duo_spawn_coins', { p_room: code })
}

// Force a deterministic objective + zeroed counters for the host.
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

// Move the host to the centre and stack all coins of the given types on it.
const stackCoins = async (client, code, types) => {
  await client.query(`update duo_players set x = 500, y = 500 where room_code = $1 and slot = 1`, [code])
  await client.query(
    `update duo_coins set x = 500, y = 500, collected_by = null, respawn_at = 0
      where room_code = $1 and type::text = any($2::text[])`,
    [code, types],
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

const run = async () => {
  const client = await connect()

  try {
    // ------------------------------------------------------------------------
    // SCENARIO 1: fire ALL blue collects CONCURRENTLY (the race) — objective
    // COMPLETES on the 4th coin, so we assert on `round_coins` (never reset).
    // ------------------------------------------------------------------------
    console.log('Scenario 1: 4 concurrent duo_collect calls for the same player')
    const code = makeCode('CC')
    const hostToken = `host-${Date.now()}`
    const guestToken = `guest-${Date.now()}`
    await bootstrapRoom(client, code, hostToken, guestToken)
    await forceObjective(client, code, blueObjective)
    const blueRows = await stackCoins(client, code, ['blue'])
    const blueIds = blueRows.map((r) => r.coin_id)
    console.log(`Blue coins on map: ${blueIds.length} (ids: ${blueIds.join(', ')})`)

    const conns = await Promise.all(blueIds.map(() => connectOne()))
    const results = await Promise.all(
      blueIds.map((coinId, i) =>
        rpc(conns[i], 'duo_collect', { p_code: code, p_token: hostToken, p_coin_id: coinId }).catch(
          (e) => ({ ok: false, reason: `error:${e.message}` }),
        ),
      ),
    )
    await Promise.all(conns.map((c) => c.end().catch(() => undefined)))

    const okCount = results.filter((r) => r && r.ok).length
    console.log(`  accepted collects: ${okCount}/${blueIds.length}`)
    check('every concurrent collect was accepted', okCount === blueIds.length, `got ${okCount}`)

    const after = await readPlayer(client, code)
    console.log(
      `  after: roundCoins=${after.round_coins} coins=${after.coins} progress=${after.objective_progress} objectivesDone=${after.objectives_done}`,
    )

    // round_coins is the per-round total and is NEVER reset by a reroll.
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
    // SCENARIO 2: rapid SEQUENTIAL collects that do NOT complete the objective
    // (3 of 4 blue) — here `coins`/`collected_types`/`progress` must be EXACT.
    // ------------------------------------------------------------------------
    console.log('\nScenario 2: rapid sequential collects (3/4, no reroll) count exactly once each')
    const code2 = makeCode('CS')
    const host2 = `host2-${Date.now()}`
    const guest2 = `guest2-${Date.now()}`
    await bootstrapRoom(client, code2, host2, guest2)
    await forceObjective(client, code2, blueObjective)
    const blueRows2 = await stackCoins(client, code2, ['blue'])
    const blueIds2 = blueRows2.map((r) => r.coin_id)
    const take2 = blueIds2.slice(0, 3) // deliberately leave one uncollected
    for (const coinId of take2) {
      await rpc(client, 'duo_collect', { p_code: code2, p_token: host2, p_coin_id: coinId })
    }
    const after2 = await readPlayer(client, code2)
    check(
      'sequential: coins == number collected (no reroll)',
      Number(after2.coins) === take2.length,
      `coins=${after2.coins} expected=${take2.length}`,
    )
    check(
      'sequential: collectedTypes.blue == number collected (no reroll)',
      Number(after2.collected_types?.blue ?? 0) === take2.length,
      `blue=${after2.collected_types?.blue} expected=${take2.length}`,
    )
    check(
      'sequential: objective_progress == number collected (no reroll)',
      Number(after2.objective_progress) === take2.length,
      `progress=${after2.objective_progress} expected=${take2.length}`,
    )
    check(
      'sequential: objective NOT completed (objectivesDone still 0)',
      Number(after2.objectives_done) === 0,
      `objectivesDone=${after2.objectives_done}`,
    )

    // ------------------------------------------------------------------------
    // SCENARIO 3: concurrent collects of DIFFERENT types (mixed objective).
    // Collect 2 blue + 2 red = 4 → completes; assert on round_coins.
    // ------------------------------------------------------------------------
    console.log('\nScenario 3: concurrent collects of different types (mixed objective)')
    const code3 = makeCode('CM')
    const host3 = `host3-${Date.now()}`
    const guest3 = `guest3-${Date.now()}`
    await bootstrapRoom(client, code3, host3, guest3)
    const mixedObjective = {
      id: 'collect-mixed',
      kind: 'collect',
      label: 'Collect 2 Blue + 2 Red',
      shortLabel: '2 Blue + 2 Red',
      target: 4,
      coinType: 'mixed',
      requirements: { blue: 2, red: 2 },
      points: 70,
    }
    await forceObjective(client, code3, mixedObjective)
    const mixedRows = await stackCoins(client, code3, ['blue', 'red'])
    const mixedIds = mixedRows.map((r) => r.coin_id)
    const conns3 = await Promise.all(mixedIds.map(() => connectOne()))
    const results3 = await Promise.all(
      mixedIds.map((coinId, i) =>
        rpc(conns3[i], 'duo_collect', { p_code: code3, p_token: host3, p_coin_id: coinId }).catch(() => null),
      ),
    )
    await Promise.all(conns3.map((c) => c.end().catch(() => undefined)))
    const ok3 = results3.filter((r) => r && r.ok).length
    const after3 = await readPlayer(client, code3)
    console.log(`  accepted collects: ${ok3}/${mixedIds.length}`)
    check(
      'mixed: every concurrent collect was accepted',
      ok3 === mixedIds.length,
      `got ${ok3}`,
    )
    check(
      'mixed: round_coins == number collected (no lost collection)',
      Number(after3.round_coins) === mixedIds.length,
      `roundCoins=${after3.round_coins} expected=${mixedIds.length}`,
    )

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
