// ============================================================================
// DUO CHAOS — RED-PAIR CONCURRENCY STRESS TEST (the "Collect 2 Red → 1/2" bug).
//
// Reproduces the EXACT reported case:
//   Objective: "Collect 2 Red"
//   Two Red coins are collected within milliseconds.
//   Expected: 2/2.  Actual (bug): 1/2.
//
// This test drives the REAL `duo_collect` RPC against the LIVE database, firing
// TWO valid Red pickups ALMOST SIMULTANEOUSLY (each on its own dedicated
// connection/transaction, exactly like two overlapping HTTP requests), and
// asserts the DATABASE result is 2/2 — not just the UI.
//
// It repeats the pair 60 times (>= 50) and requires EVERY iteration to yield
// exactly 2/2. Any single loss fails the run.
//
// WHY THIS IS THE RIGHT INVARIANT:
//   The objective "Collect 2 Red" has target=2. On the 2nd Red the objective is
//   satisfied and `duo_reroll_objective` runs IMMEDIATELY, resetting
//   `coins`/`collected_types`/`objective_progress` to 0 for the NEW objective.
//   So the post-completion counters are NOT a valid "no lost collection"
//   invariant. The per-round total `round_coins` is NEVER reset mid-round, so
//   `round_coins == 2` is the correct proof that BOTH pickups were committed.
//   We ALSO assert `objectives_done == 1` (the objective completed exactly once)
//   and that exactly 2 Red coins are marked collected in `duo_coins`.
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/test-collect-race-red.mjs
// ============================================================================

import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
const DB_NAME = process.env.SUPABASE_DB_NAME ?? 'postgres'
const DB_USER = process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`
const ITERATIONS = Number(process.env.RACE_ITERATIONS ?? 60)

if (!PASSWORD) {
  console.error('\u2716 SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const candidates = [
  { label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' },
  { label: 'pooler aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: DB_USER },
  { label: 'pooler-session aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, user: DB_USER },
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

const rpc = async (client, fn, args) => {
  const keys = Object.keys(args)
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
  const values = keys.map((k) => args[k])
  const { rows } = await client.query(`select ${fn}(${placeholders}) as result`, values)
  return rows[0].result
}

// Room codes must match ^[A-Z0-9]{6}$ (exactly 6 chars).
const makeCode = (prefix) => {
  const digits = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6 - prefix.length, '0')
  return `${prefix}${digits}`.slice(0, 6)
}

// The EXACT objective from the bug report.
const redObjective = {
  id: 'collect-red-2',
  kind: 'collect',
  label: 'Collect 2 Red',
  shortLabel: '2 Red',
  target: 2,
  coinType: 'red',
  points: 50,
}

const bootstrapRoom = async (client, code, hostToken, guestToken) => {
  await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
  await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
  await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
  await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
  await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })
  await rpc(client, 'duo_spawn_coins', { p_room: code })
}

// Force the "Collect 2 Red" objective + zeroed counters for the host.
const forceRedObjective = async (client, code) => {
  await client.query(
    `update duo_players
       set objective = $2::jsonb,
           objective_progress = 0,
           collected_types = '{}'::jsonb,
           coins = 0,
           stolen = 0,
           round_coins = 0,
           round_stolen = 0,
           mission_done = false,
           objectives_done = 0
     where room_code = $1 and slot = 1`,
    [code, JSON.stringify(redObjective)],
  )
}

// Arena coordinates are PERCENTAGES clamped by `duo_clamp_pos` to x∈[5,95],
// y∈[7,93]. We must use an IN-RANGE point so that `duo_move` does NOT clamp the
// player away from the coins (otherwise the distance check fails with too_far).
const ARENA_X = 50
const ARENA_Y = 50

// Move the host to the centre, reset ALL coins, then stack exactly TWO Red coins
// on the host (in range). Returns the two Red coin ids.
const prepareTwoRed = async (client, code) => {
  await client.query(`update duo_players set x = $2, y = $3 where room_code = $1 and slot = 1`, [
    code,
    ARENA_X,
    ARENA_Y,
  ])
  // Reset every coin so no stale collected_by leaks between iterations.
  await client.query(
    `update duo_coins set collected_by = null, collected_at = 0, respawn_at = 0 where room_code = $1`,
    [code],
  )
  // Pick exactly two Red coins and stack them on the host.
  const { rows } = await client.query(
    `select coin_id from duo_coins where room_code = $1 and type::text = 'red' order by coin_id limit 2`,
    [code],
  )
  if (rows.length < 2) throw new Error(`need 2 red coins, found ${rows.length}`)
  const ids = rows.map((r) => r.coin_id)
  await client.query(
    `update duo_coins set x = $2, y = $3 where room_code = $1 and coin_id = any($4::int[])`,
    [code, ARENA_X, ARENA_Y, ids],
  )
  return ids
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

const countCollectedRed = async (client, code) => {
  const { rows } = await client.query(
    `select count(*)::int as n from duo_coins
       where room_code = $1 and type::text = 'red' and collected_by is not null`,
    [code],
  )
  return rows[0].n
}

const run = async () => {
  const client = await connect()
  const code = makeCode('R')
  const hostToken = 'host-token-race'
  const guestToken = 'guest-token-race'

  console.log(`Objective: "Collect 2 Red"  (target=2)`)
  console.log(`Iterations: ${ITERATIONS} concurrent Red pairs\n`)

  await bootstrapRoom(client, code, hostToken, guestToken)

  let losses = 0
  let firstFailure = null

  for (let i = 1; i <= ITERATIONS; i += 1) {
    await forceRedObjective(client, code)
    const [coinA, coinB] = await prepareTwoRed(client, code)

    // Fire BOTH valid Red pickups ALMOST SIMULTANEOUSLY, each on its own
    // dedicated connection/transaction — exactly like two overlapping requests.
    const [connA, connB] = await Promise.all([connectOne(), connectOne()])
    try {
      const [resA, resB] = await Promise.all([
        rpc(connA, 'duo_collect', { p_code: code, p_token: hostToken, p_coin_id: coinA }),
        rpc(connB, 'duo_collect', { p_code: code, p_token: hostToken, p_coin_id: coinB }),
      ])

      const accepted = [resA, resB].filter((r) => r && r.ok === true).length
      const player = await readPlayer(client, code)
      const redCollected = await countCollectedRed(client, code)

      // The DATABASE result must be 2/2:
      //   - both RPCs accepted
      //   - round_coins == 2 (never reset mid-round → proves both committed)
      //   - exactly 2 Red coins marked collected in duo_coins
      //   - objective completed exactly once
      const ok =
        accepted === 2 &&
        player.round_coins === 2 &&
        redCollected === 2 &&
        player.objectives_done === 1

      if (!ok) {
        losses += 1
        if (!firstFailure) {
          firstFailure = {
            i,
            accepted,
            roundCoins: player.round_coins,
            redCollected,
            objectivesDone: player.objectives_done,
            resA,
            resB,
          }
        }
        console.log(
          `  \u2718 iter ${i}: accepted=${accepted} roundCoins=${player.round_coins} redCollected=${redCollected} objectivesDone=${player.objectives_done}`,
        )
      } else if (i % 10 === 0 || i === 1) {
        console.log(`  \u2714 iter ${i}: 2/2 (roundCoins=2, redCollected=2, objectivesDone=1)`)
      }
    } finally {
      await Promise.all([connA.end().catch(() => {}), connB.end().catch(() => {})])
    }
  }

  // --------------------------------------------------------------------------
  // SCENARIO 2: the STALE-POSITION race (the real client-side loss mechanism).
  //
  // The client used to send `duo_move` fire-and-forget and then immediately
  // `duo_collect`. When the player just walked onto the coins, `duo_collect`
  // could reach the server BEFORE `duo_move`, so the server validated distance
  // against a STALE position and rejected with `too_far`. The client still
  // marked the coin collected locally → the player SAW 2/2 but the server
  // counted 1/2.
  //
  // This scenario reproduces that: the server position is left FAR from the
  // coins, then two `duo_collect` calls are fired WITHOUT refreshing position.
  // We assert they are rejected with `too_far` (proving the loss mechanism),
  // then we refresh position (await `duo_move`) and assert the SAME two coins
  // are then accepted → 2/2. This is exactly the fix: refresh position BEFORE
  // collecting.
  // --------------------------------------------------------------------------
  console.log('\nScenario 2: stale-position race (duo_collect before duo_move)')
  const code2 = makeCode('S')
  const host2 = 'host-token-stale'
  const guest2 = 'guest-token-stale'
  await bootstrapRoom(client, code2, host2, guest2)

  let staleFailures = 0
  for (let i = 1; i <= ITERATIONS; i += 1) {
    await forceRedObjective(client, code2)
    const [coinA, coinB] = await prepareTwoRed(client, code2)
    // Move the SERVER position FAR away (stale) — the client has NOT yet sent
    // the fresh `duo_move`. This is the exact race window.
    await client.query(
      `update duo_players set x = 0, y = 0 where room_code = $1 and slot = 1`,
      [code2],
    )

    // (a) Fire both collects WITHOUT refreshing position → must be rejected.
    const [connA, connB] = await Promise.all([connectOne(), connectOne()])
    let resA
    let resB
    try {
      ;[resA, resB] = await Promise.all([
        rpc(connA, 'duo_collect', { p_code: code2, p_token: host2, p_coin_id: coinA }),
        rpc(connB, 'duo_collect', { p_code: code2, p_token: host2, p_coin_id: coinB }),
      ])
    } finally {
      await Promise.all([connA.end().catch(() => {}), connB.end().catch(() => {})])
    }
    const rejected = [resA, resB].filter((r) => r && r.ok === false && r.reason === 'too_far').length
    const afterStale = await readPlayer(client, code2)

    // (b) Now refresh position (await duo_move) THEN collect → must be accepted.
    //     Use the SAME in-range arena point as the coins so the clamped position
    //     lands exactly on them (duo_clamp_pos clamps to x∈[5,95], y∈[7,93]).
    await rpc(client, 'duo_move', { p_code: code2, p_token: host2, p_x: ARENA_X, p_y: ARENA_Y })
    const [connC, connD] = await Promise.all([connectOne(), connectOne()])
    let resC
    let resD
    try {
      ;[resC, resD] = await Promise.all([
        rpc(connC, 'duo_collect', { p_code: code2, p_token: host2, p_coin_id: coinA }),
        rpc(connD, 'duo_collect', { p_code: code2, p_token: host2, p_coin_id: coinB }),
      ])
    } finally {
      await Promise.all([connC.end().catch(() => {}), connD.end().catch(() => {})])
    }
    const accepted = [resC, resD].filter((r) => r && r.ok === true).length
    const afterFresh = await readPlayer(client, code2)
    const redCollected = await countCollectedRed(client, code2)

    const ok =
      rejected === 2 &&
      Number(afterStale.round_coins) === 0 &&
      accepted === 2 &&
      Number(afterFresh.round_coins) === 2 &&
      redCollected === 2 &&
      Number(afterFresh.objectives_done) === 1

    if (!ok) {
      staleFailures += 1
      console.log(
        `  \u2718 iter ${i}: rejected=${rejected} staleRoundCoins=${afterStale.round_coins} accepted=${accepted} freshRoundCoins=${afterFresh.round_coins} redCollected=${redCollected} objectivesDone=${afterFresh.objectives_done}`,
      )
    } else if (i % 10 === 0 || i === 1) {
      console.log(
        `  \u2714 iter ${i}: stale → 2×too_far (0/2), after await move → 2/2 (roundCoins=2, objectivesDone=1)`,
      )
    }
  }

  console.log('')
  const totalFailures = losses + staleFailures
  if (totalFailures === 0) {
    console.log(`\u2714 Scenario 1: ALL ${ITERATIONS} concurrent Red pairs produced 2/2`)
    console.log(`\u2714 Scenario 2: ALL ${ITERATIONS} stale-position pairs rejected then recovered to 2/2`)
    console.log(`\u2714 ALL CHECKS PASSED — ${ITERATIONS * 2} passed, 0 failed`)
  } else {
    if (losses > 0) {
      console.log(`\u2716 Scenario 1: ${losses}/${ITERATIONS} iterations LOST a collection`)
      console.log(`  first failure: ${JSON.stringify(firstFailure, null, 2)}`)
    }
    if (staleFailures > 0) {
      console.log(`\u2716 Scenario 2: ${staleFailures}/${ITERATIONS} iterations did not behave as expected`)
    }
    console.log(`\u2716 FAILURES DETECTED — ${ITERATIONS * 2 - totalFailures} passed, ${totalFailures} failed`)
  }

  await client.end()
  process.exit(totalFailures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('\u2716 test crashed:', error)
  process.exit(1)
})
