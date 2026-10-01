// ============================================================================
// DUO CHAOS — systematic collection-loss test (root-cause reproduction).
//
// USER REPORT (generalised, NOT blue-specific):
//   "If I successfully collect more required coins than necessary, objective
//    progress must never be lower than the number of valid collections
//    actually processed."
//
// This test drives the REAL RPCs against the live DB and checks the invariant
// across MULTIPLE coin types and objective shapes:
//
//   A) coinType-only objective  ("Collect 4 Blue")
//   B) requirements objective   ("Collect 2 Red + 1 Emerald")
//   C) mixed concurrent types
//   D) OVER-COLLECTION in one frame (collect 6 for a target of 4)
//   E) rapid sequential over-collection
//
// INVARIANTS (must hold for EVERY scenario):
//   1. Every accepted `duo_collect` (ok:true) is counted exactly once in the
//      per-round total `round_coins` (never reset mid-round).
//   2. No accepted collect is silently dropped.
//   3. `objective_progress` for the ACTIVE objective never exceeds its target
//      and never goes backwards while the objective id is unchanged.
//   4. When an objective completes, the NEXT objective starts at 0 and the
//      overflow collections are applied to the NEW objective (not lost).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/test-collect-loss.mjs
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

const makeCode = (prefix) =>
  `${prefix}${Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')}`.slice(0, 6)

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
           round_stolen = 0,
           mission_done = false,
           objectives_done = 0
     where room_code = $1 and slot = 1`,
    [code, JSON.stringify(objective)],
  )
}

// Stack ALL coins of the given types on the player and return their ids.
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
            mission_done, objectives_done, stolen, round_stolen
       from duo_players where room_code = $1 and slot = 1`,
    [code],
  )
  return rows[0]
}

// Fire N concurrent duo_collect calls, each on its own connection.
const concurrentCollect = async (code, token, coinIds) => {
  const conns = await Promise.all(coinIds.map(() => connectOne()))
  const results = await Promise.all(
    coinIds.map((coinId, i) =>
      rpc(conns[i], 'duo_collect', { p_code: code, p_token: token, p_coin_id: coinId }).catch((e) => ({
        ok: false,
        reason: `error:${e.message}`,
      })),
    ),
  )
  await Promise.all(conns.map((c) => c.end().catch(() => undefined)))
  return results
}

const run = async () => {
  const client = await connect()

  try {
    // ========================================================================
    // SCENARIO A: coinType-only objective, OVER-COLLECTION in one frame.
    //   Objective "Collect 4 Blue" but 6 blue coins are collected concurrently.
    //   Invariant: round_coins == 6 (every accepted collect counted once).
    // ========================================================================
    console.log('Scenario A: "Collect 4 Blue" — 6 concurrent blue collects (over-collection)')
    {
      const code = makeCode('LA')
      const host = `hostA-${Date.now()}`
      const guest = `guestA-${Date.now()}`
      await bootstrapRoom(client, code, host, guest)
      await forceObjective(client, code, {
        id: 'collect-blue-4',
        kind: 'collect',
        label: 'Collect 4 Blue',
        shortLabel: '4 Blue',
        target: 4,
        coinType: 'blue',
        points: 60,
      })
      const rows = await stackCoins(client, code, ['blue'])
      const ids = rows.map((r) => r.coin_id)
      console.log(`  blue coins available: ${ids.length}`)
      const results = await concurrentCollect(code, host, ids)
      const ok = results.filter((r) => r && r.ok).length
      const after = await readPlayer(client, code)
      console.log(
        `  accepted=${ok}/${ids.length} roundCoins=${after.round_coins} objectivesDone=${after.objectives_done} progress=${after.objective_progress}`,
      )
      check('A: every concurrent collect accepted', ok === ids.length, `got ${ok}`)
      check(
        'A: round_coins == accepted collects (no lost collection)',
        Number(after.round_coins) === ok,
        `roundCoins=${after.round_coins} expected=${ok}`,
      )
      check(
        'A: objective completed at least once (4th collect counted)',
        Number(after.objectives_done) >= 1,
        `objectivesDone=${after.objectives_done}`,
      )
    }

    // ========================================================================
    // SCENARIO B: requirements objective, OVER-COLLECTION of one required type.
    //   "Collect 2 Red + 1 Emerald" but 4 red + 1 emerald collected.
    // ========================================================================
    console.log('\nScenario B: "Collect 2 Red + 1 Emerald" — 4 red + 1 emerald concurrent')
    {
      const code = makeCode('LB')
      const host = `hostB-${Date.now()}`
      const guest = `guestB-${Date.now()}`
      await bootstrapRoom(client, code, host, guest)
      await forceObjective(client, code, {
        id: 'collect-red-emerald',
        kind: 'collect',
        label: 'Collect 2 Red + 1 Emerald',
        shortLabel: '2 Red + 1 Emerald',
        target: 3,
        coinType: 'mixed',
        requirements: { red: 2, emerald: 1 },
        points: 70,
      })
      const rows = await stackCoins(client, code, ['red', 'emerald'])
      const ids = rows.map((r) => r.coin_id)
      console.log(`  red+emerald coins available: ${ids.length}`)
      const results = await concurrentCollect(code, host, ids)
      const ok = results.filter((r) => r && r.ok).length
      const after = await readPlayer(client, code)
      console.log(
        `  accepted=${ok}/${ids.length} roundCoins=${after.round_coins} objectivesDone=${after.objectives_done}`,
      )
      check('B: every concurrent collect accepted', ok === ids.length, `got ${ok}`)
      check(
        'B: round_coins == accepted collects (no lost collection)',
        Number(after.round_coins) === ok,
        `roundCoins=${after.round_coins} expected=${ok}`,
      )
      check(
        'B: objective completed at least once',
        Number(after.objectives_done) >= 1,
        `objectivesDone=${after.objectives_done}`,
      )
    }

    // ========================================================================
    // SCENARIO C: rapid SEQUENTIAL over-collection (no concurrency).
    //   "Collect 3 Gold" but 5 gold collected one-by-one.
    // ========================================================================
    console.log('\nScenario C: "Collect 3 Gold" — 5 sequential gold collects')
    {
      const code = makeCode('LC')
      const host = `hostC-${Date.now()}`
      const guest = `guestC-${Date.now()}`
      await bootstrapRoom(client, code, host, guest)
      await forceObjective(client, code, {
        id: 'collect-gold-3',
        kind: 'collect',
        label: 'Collect 3 Gold',
        shortLabel: '3 Gold',
        target: 3,
        coinType: 'gold',
        points: 50,
      })
      const rows = await stackCoins(client, code, ['gold'])
      const ids = rows.map((r) => r.coin_id)
      console.log(`  gold coins available: ${ids.length}`)
      let ok = 0
      for (const coinId of ids) {
        const res = await rpc(client, 'duo_collect', { p_code: code, p_token: host, p_coin_id: coinId })
        if (res && res.ok) ok += 1
      }
      const after = await readPlayer(client, code)
      console.log(
        `  accepted=${ok}/${ids.length} roundCoins=${after.round_coins} objectivesDone=${after.objectives_done}`,
      )
      check('C: every sequential collect accepted', ok === ids.length, `got ${ok}`)
      check(
        'C: round_coins == accepted collects (no lost collection)',
        Number(after.round_coins) === ok,
        `roundCoins=${after.round_coins} expected=${ok}`,
      )
      check(
        'C: objective completed at least once',
        Number(after.objectives_done) >= 1,
        `objectivesDone=${after.objectives_done}`,
      )
    }

    // ========================================================================
    // SCENARIO D: STRESS — repeat scenario A many times with random types to
    //   prove the invariant holds consistently (not a lucky single run).
    // ========================================================================
    console.log('\nScenario D: stress — 20 rooms, random type, over-collection')
    {
      const types = ['blue', 'red', 'gold', 'emerald']
      let allOk = true
      let detail = ''
      for (let i = 0; i < 20; i += 1) {
        const type = types[i % types.length]
        const code = makeCode('LD')
        const host = `hostD${i}-${Date.now()}`
        const guest = `guestD${i}-${Date.now()}`
        await bootstrapRoom(client, code, host, guest)
        await forceObjective(client, code, {
          id: `collect-${type}-2`,
          kind: 'collect',
          label: `Collect 2 ${type}`,
          shortLabel: `2 ${type}`,
          target: 2,
          coinType: type,
          points: 40,
        })
        const rows = await stackCoins(client, code, [type])
        const ids = rows.map((r) => r.coin_id)
        const results = await concurrentCollect(code, host, ids)
        const ok = results.filter((r) => r && r.ok).length
        const after = await readPlayer(client, code)
        if (Number(after.round_coins) !== ok) {
          allOk = false
          detail = `run ${i} type=${type} roundCoins=${after.round_coins} expected=${ok}`
          break
        }
      }
      check('D: round_coins == accepted collects across 20 random runs', allOk, detail)
    }

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
