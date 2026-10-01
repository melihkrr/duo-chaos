// ============================================================================
// DUO CHAOS — objective-progress monotonicity test (client merge logic).
//
// Reproduces the reported desync: "4/4 → 3/4 → 4/4".
//
// The bug was that objectiveProgress had MULTIPLE writers and a STALE
// `duo_public_state` snapshot (taken before the 4th collect committed) could
// overwrite the fresh RPC value. This test drives the EXACT merge rules used by
// the client (mirrored here) through an adversarial sequence of interleaved
// fresh/stale updates and asserts progress NEVER decreases within an objective.
//
// Run: node scripts/test-progress-monotonic.mjs
// ============================================================================

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

// --- Mirror of lib/useDuoChaos.ts mergeProgress ------------------------------
const mergeProgress = (local, server, objectiveChanged) => {
  // Stale-snapshot guard: a snapshot whose objectivesDone is behind local is
  // stale and must NOT be treated as an objective change.
  const serverDone =
    typeof server.objectivesDone === 'number' && Number.isFinite(server.objectivesDone)
      ? server.objectivesDone
      : undefined
  const localDone =
    typeof local.objectivesDone === 'number' && Number.isFinite(local.objectivesDone)
      ? local.objectivesDone
      : 0
  const staleSnapshot = serverDone !== undefined && serverDone < localDone
  // Stale snapshot is fully ignored.
  if (staleSnapshot) {
    return {
      coins: local.coins,
      stolen: local.stolen,
      roundCoins: local.roundCoins,
      roundStolen: local.roundStolen,
      collectedTypes: local.collectedTypes ?? {},
      objectiveProgress: local.objectiveProgress ?? 0,
    }
  }
  if (objectiveChanged) {
    return {
      coins: server.coins ?? local.coins,
      stolen: server.stolen ?? local.stolen,
      roundCoins: server.roundCoins ?? local.roundCoins,
      roundStolen: server.roundStolen ?? local.roundStolen,
      collectedTypes: server.collectedTypes ?? {},
      objectiveProgress: server.objectiveProgress ?? 0,
    }
  }
  const serverProgress =
    typeof server.objectiveProgress === 'number' && Number.isFinite(server.objectiveProgress)
      ? server.objectiveProgress
      : undefined
  const localProgress =
    typeof local.objectiveProgress === 'number' && Number.isFinite(local.objectiveProgress)
      ? local.objectiveProgress
      : 0
  const objectiveProgress =
    serverProgress === undefined ? localProgress : Math.max(localProgress, serverProgress)
  return {
    coins: server.coins ?? local.coins,
    stolen: server.stolen ?? local.stolen,
    roundCoins: server.roundCoins ?? local.roundCoins,
    roundStolen: server.roundStolen ?? local.roundStolen,
    collectedTypes: server.collectedTypes ?? local.collectedTypes ?? {},
    objectiveProgress,
  }
}

// --- Mirror of lib/useGameLoop.ts applyServerState (monotonic branch) --------
const applyServerState = (player, state) => {
  const nextObjective = state.objective ?? player.objective
  const objectiveChanged = (nextObjective?.id ?? null) !== (player.objective?.id ?? null)
  const serverProgress =
    typeof state.objectiveProgress === 'number' && Number.isFinite(state.objectiveProgress)
      ? state.objectiveProgress
      : undefined
  const localProgress =
    typeof player.objectiveProgress === 'number' && Number.isFinite(player.objectiveProgress)
      ? player.objectiveProgress
      : 0
  const objectiveProgress = objectiveChanged
    ? (serverProgress ?? 0)
    : serverProgress === undefined
      ? localProgress
      : Math.max(localProgress, serverProgress)
  return {
    ...player,
    objective: nextObjective,
    objectiveProgress,
    // Mirror of useGameLoop.applyServerState: it also applies objectivesDone.
    objectivesDone: state.objectivesDone ?? player.objectivesDone,
  }
}

const OBJ = { id: 'blue-pressure', kind: 'collect', target: 4, coinType: 'blue' }
const OBJ2 = { id: 'gold-rush', kind: 'collect', target: 3, coinType: 'gold' }

// ---------------------------------------------------------------------------
// SCENARIO 1: the exact reported bug — fresh 4 then stale 3 then fresh 4.
// ---------------------------------------------------------------------------
console.log('Scenario 1: fresh 4/4 → stale 3/4 → fresh 4/4 (must stay 4)')
{
  let player = { id: 'p1', objective: OBJ, objectiveProgress: 3 }
  const seen = []
  const record = () => seen.push(player.objectiveProgress)

  // Fresh RPC response for the 4th collect → 4.
  player = applyServerState(player, { objective: OBJ, objectiveProgress: 4 })
  record()
  // STALE poll snapshot (captured before the 4th collect) → 3.
  const merged = mergeProgress(player, { objective: OBJ, objectiveProgress: 3 }, false)
  player = { ...player, ...merged }
  record()
  // Next poll catches up → 4.
  const merged2 = mergeProgress(player, { objective: OBJ, objectiveProgress: 4 }, false)
  player = { ...player, ...merged2 }
  record()

  check('sequence is [4,4,4] (never drops to 3)', JSON.stringify(seen) === '[4,4,4]', `got ${JSON.stringify(seen)}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 2: rapid consecutive collects with interleaved stale snapshots.
// ---------------------------------------------------------------------------
console.log('\nScenario 2: rapid 1→2→3→4 with stale snapshots interleaved')
{
  let player = { id: 'p1', objective: OBJ, objectiveProgress: 0 }
  const seen = []
  // Simulate: fresh RPC for each collect, but after each, a stale poll arrives
  // carrying the PREVIOUS value (one behind).
  for (let n = 1; n <= 4; n += 1) {
    player = applyServerState(player, { objective: OBJ, objectiveProgress: n })
    seen.push(player.objectiveProgress)
    // stale snapshot one behind
    const merged = mergeProgress(player, { objective: OBJ, objectiveProgress: n - 1 }, false)
    player = { ...player, ...merged }
    seen.push(player.objectiveProgress)
  }
  const monotonic = seen.every((v, i) => i === 0 || v >= seen[i - 1])
  check('progress is monotonic across the whole sequence', monotonic, `got ${JSON.stringify(seen)}`)
  check('final progress is 4', player.objectiveProgress === 4, `got ${player.objectiveProgress}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 3: delayed/out-of-order RPC responses (older arrives last).
// ---------------------------------------------------------------------------
console.log('\nScenario 3: out-of-order RPC responses (older arrives last)')
{
  let player = { id: 'p1', objective: OBJ, objectiveProgress: 0 }
  // Newer response (4) arrives first, then the older (2) arrives late.
  player = applyServerState(player, { objective: OBJ, objectiveProgress: 4 })
  player = applyServerState(player, { objective: OBJ, objectiveProgress: 2 })
  check('late older RPC cannot lower progress', player.objectiveProgress === 4, `got ${player.objectiveProgress}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 4: objective change MUST reset to 0 (legitimate drop).
// ---------------------------------------------------------------------------
console.log('\nScenario 4: objective reroll resets progress to 0 (legitimate)')
{
  // objectivesDone: 0 → 1 when the objective is completed/rerolled.
  let player = { id: 'p1', objective: OBJ, objectiveProgress: 4, objectivesDone: 0 }
  player = applyServerState(player, { objective: OBJ2, objectiveProgress: 0, objectivesDone: 1 })
  check('new objective resets progress to 0', player.objectiveProgress === 0, `got ${player.objectiveProgress}`)
  check('objective id updated', player.objective.id === 'gold-rush', `got ${player.objective.id}`)
  // A STALE snapshot of the OLD objective (objectivesDone still 0, behind the
  // local 1) must NOT resurrect the old progress.
  const merged = mergeProgress(
    player,
    { objective: OBJ, objectiveProgress: 4, objectivesDone: 0 },
    true,
  )
  player = { ...player, ...merged }
  check('stale old-objective snapshot does not resurrect progress', player.objectiveProgress === 0, `got ${player.objectiveProgress}`)
}

console.log(`\n${failed === 0 ? '✔ ALL CHECKS PASSED' : '✖ FAILURES DETECTED'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
