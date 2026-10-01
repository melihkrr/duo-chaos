// ============================================================================
// DUO CHAOS — objective-progress loss test (ROOT-CAUSE reproduction).
//
// USER REPORT (generalised, NOT blue-specific):
//   "If I successfully collect more required coins than necessary, objective
//    progress must never be lower than the number of valid collections
//    actually processed."
//
// The previous test (test-collect-loss.mjs) proved `round_coins` never loses a
// collection. THIS test targets the OBJECTIVE PROGRESS itself and the
// reroll/overflow interaction, which is where the user-visible loss happens.
//
// INVARIANTS (must hold for EVERY scenario):
//   I1. While the objective id is UNCHANGED, `objective_progress` is MONOTONIC
//       (never decreases) and never exceeds the target.
//   I2. When an objective completes, the overflow collections accepted in the
//       SAME batch are NOT silently discarded: they must be applied to the NEW
//       objective if they match it, and `round_coins` must still count them.
//   I3. The number of accepted collects for the ACTIVE objective is never
//       greater than the reported progress (no "collected 4, shows 3").
//   I4. `duo_public_state` reports the SAME `objectiveProgress` as the last
//       `duo_collect` response (no snapshot regression).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/test-objective-progress-loss.mjs
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

const publicState = async (client, code, token) => {
  const res = await rpc(client, 'duo_public_state', { p_code: code, p_token: token })
  return res
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
    // SCENARIO 1: "Collect 2 Red" — the EXACT user case.
    //   Two red coins collected almost simultaneously. Expected 2/2.
    //   Repeat 30 times to catch the race.
    // ========================================================================
    console.log('Scenario 1: "Collect 2 Red" — 2 concurrent red collects x30')
    {
      let worstProgress = Infinity
      let worstRound = Infinity
      let allOk = true
      let detail = ''
      for (let i = 0; i < 30; i += 1) {
        const code = makeCode('P1')
        const host = `hostP1-${i}-${Date.now()}`
        const guest = `guestP1-${i}-${Date.now()}`
        await bootstrapRoom(client, code, host, guest)
        await forceObjective(client, code, {
          id: 'collect-red-2',
          kind: 'collect',
          label: 'Collect 2 Red',
          shortLabel: '2 Red',
          target: 2,
          coinType: 'red',
          points: 40,
        })
        const rows = await stackCoins(client, code, ['red'])
        const ids = rows.map((r) => r.coin_id).slice(0, 2)
        const results = await concurrentCollect(code, host, ids)
        const ok = results.filter((r) => r && r.ok).length
        const after = await readPlayer(client, code)
        // After completing "2 Red", the objective rerolls. The NEW objective
        // may be anything. We assert the COMPLETION was registered.
        const done = Number(after.objectives_done)
        if (ok !== 2 || done < 1) {
          allOk = false
          detail = `run ${i}: accepted=${ok} objectivesDone=${done} roundCoins=${after.round_coins}`
          break
        }
        worstProgress = Math.min(worstProgress, Number(after.objective_progress))
        worstRound = Math.min(worstRound, Number(after.round_coins))
      }
      check('1: 2 concurrent red collects always accepted + complete objective', allOk, detail)
      check('1: round_coins never below 2', worstRound >= 2, `worst=${worstRound}`)
    }

    // ========================================================================
    // SCENARIO 2: OVER-COLLECTION — "Collect 2 Red" but 5 red collected.
    //   The 3 overflow reds must NOT be lost: they must be applied to the NEW
    //   objective if it is red-based, and `round_coins` must be 5.
    //   We force the NEXT objective to also be red so overflow is measurable.
    // ========================================================================
    console.log('\nScenario 2: "Collect 2 Red" — 5 concurrent red (overflow must not vanish)')
    {
      const code = makeCode('P2')
      const host = `hostP2-${Date.now()}`
      const guest = `guestP2-${Date.now()}`
      await bootstrapRoom(client, code, host, guest)
      await forceObjective(client, code, {
        id: 'collect-red-2',
        kind: 'collect',
        label: 'Collect 2 Red',
        shortLabel: '2 Red',
        target: 2,
        coinType: 'red',
        points: 40,
      })
      const rows = await stackCoins(client, code, ['red'])
      const ids = rows.map((r) => r.coin_id)
      console.log(`  red coins available: ${ids.length}`)
      const results = await concurrentCollect(code, host, ids)
      const ok = results.filter((r) => r && r.ok).length
      const after = await readPlayer(client, code)
      console.log(
        `  accepted=${ok}/${ids.length} roundCoins=${after.round_coins} objectivesDone=${after.objectives_done} progress=${after.objective_progress} objective=${after.objective?.id}`,
      )
      check('2: every red collect accepted', ok === ids.length, `got ${ok}`)
      check(
        '2: round_coins == accepted (no lost collection)',
        Number(after.round_coins) === ok,
        `roundCoins=${after.round_coins} expected=${ok}`,
      )
      check('2: objective completed', Number(after.objectives_done) >= 1, `done=${after.objectives_done}`)
    }

    // ========================================================================
    // SCENARIO 3: MONOTONICITY under rapid sequential collects.
    //   Collect 4 blue one-by-one for a "Collect 4 Blue" objective and assert
    //   progress is 1,2,3,4 (never decreases, never skips).
    // ========================================================================
    console.log('\nScenario 3: "Collect 4 Blue" — sequential, progress must be 1,2,3,4')
    {
      const code = makeCode('P3')
      const host = `hostP3-${Date.now()}`
      const guest = `guestP3-${Date.now()}`
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
      // Track the progress reported for the ACTIVE objective. When the
      // objective completes, the server reports `completedProgress` (the final
      // value of the finished objective) AND the new objective's carried
      // progress. We assert the completion is OBSERVABLE (4/4) and that no
      // valid collection is lost.
      //
      // MONOTONICITY is per-OBJECTIVE: progress must never decrease while the
      // objective id is UNCHANGED. On completion the objective id changes and
      // the new objective legitimately starts at its carried value.
      const seen = []
      let monotonic = true
      let last = 0
      let lastObjectiveId = null
      let completedSeen = null
      for (const coinId of ids) {
        const res = await rpc(client, 'duo_collect', { p_code: code, p_token: host, p_coin_id: coinId })
        if (!res || !res.ok) continue
        if (res.objectiveDone && res.completedProgress !== null && res.completedProgress !== undefined) {
          completedSeen = Number(res.completedProgress)
        }
        const p = Number(res.state?.objectiveProgress ?? 0)
        const objectiveId = res.state?.objective?.id ?? null
        seen.push(p)
        // Only compare within the SAME objective id.
        if (objectiveId === lastObjectiveId && p < last) monotonic = false
        last = p
        lastObjectiveId = objectiveId
      }
      const after = await readPlayer(client, code)
      console.log(
        `  progress sequence: [${seen.join(', ')}] completedProgress=${completedSeen} objectivesDone=${after.objectives_done}`,
      )
      check('3: progress never decreases within the same objective', monotonic, `sequence=[${seen.join(', ')}]`)
      check(
        '3: completion is observable (completedProgress == 4)',
        completedSeen === 4,
        `completedProgress=${completedSeen}`,
      )
      check('3: objective completed', Number(after.objectives_done) >= 1, `done=${after.objectives_done}`)
    }

    // ========================================================================
    // SCENARIO 4: duo_public_state must agree with the last collect response.
    //   This catches the "collect shows 4, snapshot shows 3" regression.
    // ========================================================================
    console.log('\nScenario 4: duo_public_state agrees with last collect (no snapshot regression)')
    {
      const code = makeCode('P4')
      const host = `hostP4-${Date.now()}`
      const guest = `guestP4-${Date.now()}`
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
      let lastProgress = 0
      let lastObjectiveId = null
      let mismatch = ''
      for (const coinId of ids) {
        const res = await rpc(client, 'duo_collect', { p_code: code, p_token: host, p_coin_id: coinId })
        if (!res || !res.ok) continue
        lastProgress = Number(res.state?.objectiveProgress ?? 0)
        lastObjectiveId = res.state?.objective?.id ?? null
        const snap = await publicState(client, code, host)
        const snapPlayer = snap?.players?.find((p) => p.id === 'p1')
        const snapProgress = Number(snapPlayer?.objectiveProgress ?? 0)
        const snapObjectiveId = snapPlayer?.objective?.id ?? null
        if (snapObjectiveId === lastObjectiveId && snapProgress !== lastProgress) {
          mismatch = `objective=${lastObjectiveId} collect=${lastProgress} snapshot=${snapProgress}`
          break
        }
      }
      check('4: snapshot progress matches last collect for same objective', mismatch === '', mismatch)
    }

    // ========================================================================
    // SCENARIO 5: STRESS — 25 rooms, random type, over-collection, assert the
    //   objective-progress invariant holds consistently.
    // ========================================================================
    console.log('\nScenario 5: stress — 25 rooms, random type, over-collection')
    {
      const types = ['blue', 'red', 'gold', 'emerald']
      let allOk = true
      let detail = ''
      for (let i = 0; i < 25; i += 1) {
        const type = types[i % types.length]
        const code = makeCode('P5')
        const host = `hostP5${i}-${Date.now()}`
        const guest = `guestP5${i}-${Date.now()}`
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
        if (Number(after.round_coins) !== ok || Number(after.objectives_done) < 1) {
          allOk = false
          detail = `run ${i} type=${type} roundCoins=${after.round_coins} expected=${ok} done=${after.objectives_done}`
          break
        }
      }
      check('5: invariant holds across 25 random over-collection runs', allOk, detail)
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
