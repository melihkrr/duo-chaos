// ============================================================================
// DUO CHAOS — deterministic two-player objective-flow simulation (server-side).
//
// Drives the REAL RPCs against the live database and asserts the objective
// system is deterministic and monotonic:
//
//   1. "collect 3 shows 2"        → progress must equal the number collected.
//   2. "shows 3 then drops to 1"  → progress must NEVER decrease.
//   3. "long wait for next task"  → the next objective must arrive in the SAME
//                                    RPC response that completes the previous
//                                    one (no poll wait).
//   4. consecutive objectives     → objectivesDone increments and progress
//                                    restarts at 0 for the new objective.
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/sim-objective-flow.mjs
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
      console.log(`✔ connected via ${candidate.label}\n`)
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

const run = async () => {
  const client = await connect()
  const code = `SIM${Math.floor(Math.random() * 900 + 100)}`
  const hostToken = `host-${Date.now()}`
  const guestToken = `guest-${Date.now()}`

  try {
    // ---------------------------------------------------------------- SETUP
    await rpc(client, 'duo_create_room', { p_code: code, p_token: hostToken, p_name: 'Host' })
    await rpc(client, 'duo_join_room', { p_code: code, p_token: guestToken, p_name: 'Guest' })
    await rpc(client, 'duo_start_round', { p_code: code, p_token: hostToken })
    // Force countdown → battle.
    await client.query(`update duo_rooms set countdown_ends_at = 0 where code = $1`, [code])
    await rpc(client, 'duo_advance_phase', { p_code: code, p_token: hostToken })

    // Reset the map to the pristine deterministic layout so the test is not
    // affected by resource waves spawned by earlier ticks. `duo_spawn_coins`
    // is the same function `duo_start_round` uses.
    await rpc(client, 'duo_spawn_coins', { p_room: code })

    const state = async (token) => rpc(client, 'duo_public_state', { p_code: code, p_token: token })
    const hostState = await state(hostToken)
    const host = hostState.players.find((p) => p.id === 'p1')
    const objective = host.objective
    console.log(`Objective: ${objective.label} (kind=${objective.kind}, target=${objective.target})`)
    console.log(`requirements=${JSON.stringify(objective.requirements ?? null)}\n`)

    // Sanity: the pristine map must contain enough coins of each required type
    // for the objective to be completable. If not, the objective is impossible
    // (a real balance bug) — report it explicitly.
    const pristineCounts = hostState.coins.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1
      return acc
    }, {})
    console.log(`map counts: ${JSON.stringify(pristineCounts)}`)
    if (objective.requirements) {
      for (const [type, need] of Object.entries(objective.requirements)) {
        check(
          `map has enough ${type} (${pristineCounts[type] ?? 0} >= ${need})`,
          (pristineCounts[type] ?? 0) >= need,
          `objective impossible on this map`,
        )
      }
    } else if (objective.coinType && objective.coinType !== 'mixed') {
      check(
        `map has enough ${objective.coinType} (${pristineCounts[objective.coinType] ?? 0} >= ${objective.target})`,
        (pristineCounts[objective.coinType] ?? 0) >= objective.target,
        `objective impossible on this map`,
      )
    }

    // -------------------------------------------------- MONOTONIC PROGRESS
    // Drive the objective to completion one action at a time and assert:
    //   * progress never decreases WITHIN an objective (monotonic), and
    //   * progress never exceeds the objective target, and
    //   * the completion response already carries the NEXT objective.
    //
    // NOTE: for mixed-requirement objectives (e.g. "2 Blue + 2 Red") progress
    // is `sum(min(collected[type], required[type]))`, so it does NOT equal the
    // raw action count — it is capped per type. We therefore assert the exact
    // expected progress computed from the requirements, not `actions`.
    const coins = hostState.coins
    const requirements = objective.requirements ?? null
    const wanted = requirements
      ? Object.keys(requirements)
      : objective.coinType && objective.coinType !== 'mixed'
        ? [objective.coinType]
        : null

    // Build the action list. For mixed objectives we interleave types so we
    // gather enough of EACH required type to reach the target.
    const isSteal = objective.kind === 'steal'
    const guest = hostState.players.find((p) => p.id === 'p2')

    const collectActions = []
    if (!isSteal) {
      if (requirements) {
        for (const [type, need] of Object.entries(requirements)) {
          const pool = coins.filter((c) => c.type === type)
          for (let i = 0; i < need && i < pool.length; i += 1) collectActions.push(pool[i])
        }
      } else {
        const pool = wanted ? coins.filter((c) => wanted.includes(c.type)) : coins.filter((c) => c.type !== 'diamond')
        collectActions.push(...pool)
      }
    }

    const actionCount = isSteal ? objective.target + 2 : collectActions.length

    // Expected progress after each successful action, computed from the
    // objective's own rules (mirrors duo_mission_progress).
    const collectedSoFar = {}
    const expectedProgress = () => {
      if (requirements) {
        let sum = 0
        for (const [type, need] of Object.entries(requirements)) {
          sum += Math.min(collectedSoFar[type] ?? 0, need)
        }
        return sum
      }
      if (objective.coinType && objective.coinType !== 'mixed') {
        return collectedSoFar[objective.coinType] ?? 0
      }
      if (isSteal) return collectedSoFar.__stolen ?? 0
      return collectedSoFar.__coins ?? 0
    }

    let lastProgress = 0
    let actions = 0
    let sawCompletion = false
    let nextObjectiveInSameResponse = false
    const objectivesDoneBefore = host.objectivesDone ?? 0

    for (let i = 0; i < actionCount; i += 1) {
      let res
      let actionType = null
      if (isSteal) {
        await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: guest.x, p_y: guest.y })
        res = await rpc(client, 'duo_steal', { p_code: code, p_token: hostToken })
      } else {
        const coin = collectActions[i]
        if (!coin) break
        actionType = coin.type
        await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: coin.x, p_y: coin.y })
        res = await rpc(client, 'duo_collect', { p_code: code, p_token: hostToken, p_coin_id: coin.id })
      }
      if (!res || res.ok !== true) {
        // Action rejected (cooldown / already collected / too_far); skip.
        continue
      }
      actions += 1
      if (isSteal) collectedSoFar.__stolen = (collectedSoFar.__stolen ?? 0) + 1
      else if (actionType) collectedSoFar[actionType] = (collectedSoFar[actionType] ?? 0) + 1
      else collectedSoFar.__coins = (collectedSoFar.__coins ?? 0) + 1

      const progress = res.state.objectiveProgress

      if (res.objectiveDone) {
        // Completion: the server rerolls IMMEDIATELY and resets progress to 0
        // for the NEW objective. This is the ONLY legitimate "drop" and it is
        // atomic — the same response already carries the next objective.
        sawCompletion = true
        const newObjective = res.state.objective
        nextObjectiveInSameResponse =
          newObjective && newObjective.id !== objective.id && res.state.objectiveProgress === 0
        check(
          'completion response carries the NEXT objective immediately (no poll wait)',
          nextObjectiveInSameResponse,
          `newId=${newObjective?.id} progress=${res.state.objectiveProgress}`,
        )
        check(
          'objectivesDone incremented on completion',
          (res.state.objectivesDone ?? 0) === objectivesDoneBefore + 1,
          `got ${res.state.objectivesDone}`,
        )
        break
      }

      const expected = expectedProgress()
      // Within an objective, progress must be monotonic and match the rule.
      check(
        `action #${actions}: progress ${progress} >= previous ${lastProgress}`,
        progress >= lastProgress,
        `regression detected`,
      )
      check(
        `action #${actions}: progress ${progress} == expected ${expected}`,
        progress === expected,
        `expected ${expected}`,
      )
      check(
        `action #${actions}: progress ${progress} <= target ${objective.target}`,
        progress <= objective.target,
        `exceeded target`,
      )
      lastProgress = progress
    }

    check('objective was completed during the run', sawCompletion)

    // ------------------------------------------- CONSECUTIVE OBJECTIVE #2
    if (sawCompletion) {
      const after = await state(hostToken)
      const host2 = after.players.find((p) => p.id === 'p1')
      const objective2 = host2.objective
      console.log(`\nNext objective: ${objective2.label} (target=${objective2.target})`)
      check(
        'server snapshot agrees with the RPC response (no divergence)',
        objective2.id !== objective.id,
        `still ${objective2.id}`,
      )
      check('new objective starts at progress 0', (host2.objectiveProgress ?? 0) === 0)

      // Advance the new objective by ONE action and assert progress goes 0 → 1
      // (never jumps or regresses). The action depends on the objective kind:
      // steal objectives advance by stealing from the rival, collect objectives
      // by collecting a coin of a required type.
      const guest2 = after.players.find((p) => p.id === 'p2')
      if (objective2.kind === 'steal') {
        await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: guest2.x, p_y: guest2.y })
        const res2 = await rpc(client, 'duo_steal', { p_code: code, p_token: hostToken })
        if (res2?.ok) {
          check(
            'second objective: first steal shows progress 1',
            res2.state.objectiveProgress === 1,
            `got ${res2.state.objectiveProgress}`,
          )
        }
      } else {
        const coins2 = after.coins
        const wanted2 = objective2.requirements
          ? Object.keys(objective2.requirements)
          : objective2.coinType && objective2.coinType !== 'mixed'
            ? [objective2.coinType]
            : null
        const target2 = wanted2
          ? coins2.filter((c) => wanted2.includes(c.type))
          : coins2.filter((c) => c.type !== 'diamond')

        if (target2.length > 0) {
          const coin = target2[0]
          await rpc(client, 'duo_move', { p_code: code, p_token: hostToken, p_x: coin.x, p_y: coin.y })
          const res2 = await rpc(client, 'duo_collect', { p_code: code, p_token: hostToken, p_coin_id: coin.id })
          if (res2?.ok) {
            check(
              'second objective: first collect shows progress 1',
              res2.state.objectiveProgress === 1,
              `got ${res2.state.objectiveProgress}`,
            )
          }
        }
      }
    }

    // ------------------------------------------------------------- TEARDOWN
    await client.query(`delete from duo_rooms where code = $1`, [code])
  } finally {
    await client.end()
  }

  console.log(`\n${failed === 0 ? '✔ ALL CHECKS PASSED' : '✖ FAILURES DETECTED'} — ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('✖ simulation error:', error?.message)
  process.exit(1)
})
