// ============================================================================
// DUO CHAOS — multiplayer state desync test (client merge logic).
//
// Reproduces the two reported desyncs:
//   BUG 1: the SAME objective shows different progress to each player at the
//          same time (Player A: "2/3", Player B: "0/3").
//   BUG 2: SCORE goes backwards (1080 → 1030).
//
// Root causes fixed in lib/useDuoChaos.ts + lib/useGameLoop.ts:
//   * The battle/lobby polls spread the raw server object
//     (`{ ...player, ...server }`), which applied the server's `objective`,
//     `objectiveProgress` and `objectivesDone` UNCONDITIONALLY — decoupling the
//     objective IDENTITY from its PROGRESS. A server-side reroll could therefore
//     show "objective A but progress B". Fixed by restoring the objective trio
//     to local values and applying it ATOMICALLY (identity + progress + stamp).
//   * `score` was applied UNCONDITIONALLY in the phase-reconciliation poll,
//     `applyServerState`, and the lobby poll. A stale snapshot / delayed RPC
//     could overwrite a newer score. Fixed with a monotonic `Math.max` guard.
//   * `objectivesDone` was applied unconditionally in the phase-reconciliation
//     poll, which could lower the monotonic version stamp and break the
//     stale-snapshot guard. Fixed to only move forward.
//   * `offCollect`'s `requirements` branch omitted the steal component, so the
//     optimistic derivation diverged from the server (0038). Fixed to match.
//
// This test mirrors the EXACT merge rules and drives them through adversarial
// interleavings, asserting the invariants:
//   (1) score is monotonic (never decreases),
//   (2) objectiveProgress is monotonic within an objective,
//   (3) both players converge to the SAME authoritative value.
//
// Run: node scripts/test-multiplayer-desync.mjs
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
  const serverDone =
    typeof server.objectivesDone === 'number' && Number.isFinite(server.objectivesDone)
      ? server.objectivesDone
      : undefined
  const localDone =
    typeof local.objectivesDone === 'number' && Number.isFinite(local.objectivesDone)
      ? local.objectivesDone
      : 0
  const staleSnapshot = serverDone !== undefined && serverDone < localDone
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

// --- Mirror of the FIXED battle-poll player merge ----------------------------
// Applies the raw spread, then restores the objective trio, then applies the
// atomic objective identity + monotonic progress + monotonic objectivesDone.
const mergeBattlePlayer = (player, server) => {
  const merged = { ...player, ...server, id: player.id }
  // Restore the objective trio (raw spread must not decouple identity/progress).
  merged.objective = player.objective
  merged.objectiveProgress = player.objectiveProgress
  merged.objectivesDone = player.objectivesDone
  const localObjectiveId = player.objective?.id ?? null
  const serverObjectiveId = server.objective?.id ?? null
  const serverDone =
    typeof server.objectivesDone === 'number' ? server.objectivesDone : undefined
  const localDone = typeof player.objectivesDone === 'number' ? player.objectivesDone : 0
  // STALE-SNAPSHOT GUARD: a snapshot behind the local monotonic version stamp
  // must not apply the objective IDENTITY either (else the old objective is
  // resurrected and identity/progress decouple).
  const staleSnapshot = serverDone !== undefined && serverDone < localDone
  const objectiveChanged =
    !staleSnapshot && serverObjectiveId !== null && serverObjectiveId !== localObjectiveId
  const progress = mergeProgress(player, server, objectiveChanged)
  merged.coins = progress.coins
  merged.stolen = progress.stolen
  merged.roundCoins = progress.roundCoins
  merged.roundStolen = progress.roundStolen
  merged.collectedTypes = progress.collectedTypes
  merged.objectiveProgress = progress.objectiveProgress
  if (objectiveChanged && server.objective) merged.objective = server.objective
  if (serverDone !== undefined && serverDone >= localDone) merged.objectivesDone = serverDone
  return merged
}

// --- Mirror of the FIXED phase-reconciliation score merge --------------------
const mergeReconcileScore = (player, server) => {
  const next = { ...player }
  if (typeof server.score === 'number') next.score = Math.max(player.score ?? 0, server.score)
  if (typeof server.roundScore === 'number') {
    next.roundScore = Math.max(player.roundScore ?? 0, server.roundScore)
  }
  if (typeof server.totalScore === 'number') {
    next.totalScore = Math.max(player.totalScore ?? 0, server.totalScore)
  }
  return next
}

// --- Mirror of the FIXED applyServerState score merge ------------------------
const applyServerStateScore = (player, state) => {
  const serverScore =
    typeof state.score === 'number' && Number.isFinite(state.score) ? state.score : undefined
  return {
    ...player,
    score: serverScore === undefined ? player.score : Math.max(player.score ?? 0, serverScore),
  }
}

const OBJ = { id: 'blue-pressure', kind: 'collect', target: 4, coinType: 'blue' }
const OBJ2 = { id: 'gold-rush', kind: 'collect', target: 3, coinType: 'gold' }

// ---------------------------------------------------------------------------
// SCENARIO 1 (BUG 2): score must NEVER decrease across stale snapshots.
// ---------------------------------------------------------------------------
console.log('Scenario 1: score 1080 → stale 1030 → fresh 1080 (must stay 1080)')
{
  let player = { id: 'p1', score: 1080, roundScore: 80, totalScore: 1080 }
  const seen = []
  const record = () => seen.push(player.score)
  record()
  // STALE snapshot (older score) arrives.
  player = mergeReconcileScore(player, { score: 1030, roundScore: 30, totalScore: 1030 })
  record()
  // Fresh snapshot catches up.
  player = mergeReconcileScore(player, { score: 1080, roundScore: 80, totalScore: 1080 })
  record()
  check('sequence is [1080,1080,1080] (never drops to 1030)', JSON.stringify(seen) === '[1080,1080,1080]', `got ${JSON.stringify(seen)}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 2 (BUG 2): delayed RPC response cannot lower score.
// ---------------------------------------------------------------------------
console.log('\nScenario 2: delayed RPC (older score) cannot lower score')
{
  let player = { id: 'p1', score: 1080 }
  // Newer RPC (1080) arrives, then an older one (1030) arrives late.
  player = applyServerStateScore(player, { score: 1080 })
  player = applyServerStateScore(player, { score: 1030 })
  check('late older RPC cannot lower score', player.score === 1080, `got ${player.score}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 3 (BUG 2): interleaved rapid score increases + stale snapshots.
// ---------------------------------------------------------------------------
console.log('\nScenario 3: rapid score increases with stale snapshots interleaved')
{
  let player = { id: 'p1', score: 1000 }
  const seen = []
  for (let n = 1; n <= 8; n += 1) {
    const fresh = 1000 + n * 10
    player = mergeReconcileScore(player, { score: fresh })
    seen.push(player.score)
    // stale snapshot one step behind
    player = mergeReconcileScore(player, { score: fresh - 10 })
    seen.push(player.score)
  }
  const monotonic = seen.every((v, i) => i === 0 || v >= seen[i - 1])
  check('score is monotonic across the whole sequence', monotonic, `got ${JSON.stringify(seen)}`)
  check('final score is 1080', player.score === 1080, `got ${player.score}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 4 (BUG 1): raw spread must NOT decouple objective identity from
// progress. A stale snapshot of the OLD objective must not overwrite the new
// objective's progress.
// ---------------------------------------------------------------------------
console.log('\nScenario 4: stale old-objective snapshot cannot decouple identity/progress')
{
  // Local has already rerolled to OBJ2 with progress 0 (objectivesDone 1).
  let player = { id: 'p1', objective: OBJ2, objectiveProgress: 0, objectivesDone: 1 }
  // STALE snapshot still carries the OLD objective (OBJ) with progress 4 and
  // objectivesDone 0. The raw spread would set objective=OBJ, progress=4.
  const merged = mergeBattlePlayer(player, {
    objective: OBJ,
    objectiveProgress: 4,
    objectivesDone: 0,
  })
  check('objective identity stays OBJ2 (not resurrected to OBJ)', merged.objective.id === 'gold-rush', `got ${merged.objective.id}`)
  check('progress stays 0 (not resurrected to 4)', merged.objectiveProgress === 0, `got ${merged.objectiveProgress}`)
  check('objectivesDone stays 1 (not lowered to 0)', merged.objectivesDone === 1, `got ${merged.objectivesDone}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 5 (BUG 1): a genuine server-side reroll must apply identity AND
// progress ATOMICALLY (new objective + its progress together).
// ---------------------------------------------------------------------------
console.log('\nScenario 5: genuine reroll applies identity + progress atomically')
{
  let player = { id: 'p1', objective: OBJ, objectiveProgress: 4, objectivesDone: 0 }
  const merged = mergeBattlePlayer(player, {
    objective: OBJ2,
    objectiveProgress: 1,
    objectivesDone: 1,
  })
  check('objective identity updated to OBJ2', merged.objective.id === 'gold-rush', `got ${merged.objective.id}`)
  check('progress is the NEW objective progress (1)', merged.objectiveProgress === 1, `got ${merged.objectiveProgress}`)
  check('objectivesDone advanced to 1', merged.objectivesDone === 1, `got ${merged.objectivesDone}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 6 (BUG 1): two players converge to the SAME authoritative value.
// Both clients poll the same server snapshot; the merge must yield identical
// objectiveProgress for the shared objective regardless of local optimistic
// state.
// ---------------------------------------------------------------------------
console.log('\nScenario 6: two clients converge to the same authoritative progress')
{
  // Server truth: objective "gold-robbery" (requirements gold:1 + stealTarget:2),
  // collected gold=1, stolen=2 → progress = min(1,1) + min(2,2) = 3 (capped 3).
  const serverObj = {
    id: 'gold-robbery',
    kind: 'steal',
    target: 3,
    coinType: 'mixed',
    requirements: { gold: 1 },
    stealTarget: 2,
  }
  const serverSnapshot = {
    objective: serverObj,
    objectiveProgress: 3,
    objectivesDone: 0,
    collectedTypes: { gold: 1 },
    stolen: 2,
  }
  // Client A has optimistic progress 2 (saw one steal broadcast).
  const clientA = { id: 'p1', objective: serverObj, objectiveProgress: 2, objectivesDone: 0 }
  // Client B has optimistic progress 0 (saw nothing yet).
  const clientB = { id: 'p1', objective: serverObj, objectiveProgress: 0, objectivesDone: 0 }
  const mergedA = mergeBattlePlayer(clientA, serverSnapshot)
  const mergedB = mergeBattlePlayer(clientB, serverSnapshot)
  check('client A converges to 3', mergedA.objectiveProgress === 3, `got ${mergedA.objectiveProgress}`)
  check('client B converges to 3', mergedB.objectiveProgress === 3, `got ${mergedB.objectiveProgress}`)
  check('both clients show the SAME progress', mergedA.objectiveProgress === mergedB.objectiveProgress, `A=${mergedA.objectiveProgress} B=${mergedB.objectiveProgress}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 7 (BUG 1): optimistic progress HIGHER than server must not be
// lowered by a fresh snapshot (monotonic within an objective).
// ---------------------------------------------------------------------------
console.log('\nScenario 7: optimistic progress higher than server is preserved')
{
  const serverObj = { id: 'blue-pressure', kind: 'collect', target: 4, coinType: 'blue' }
  // Client optimistically derived 3 from a collect broadcast; server snapshot
  // (stale) still says 2.
  const client = { id: 'p1', objective: serverObj, objectiveProgress: 3, objectivesDone: 0 }
  const merged = mergeBattlePlayer(client, {
    objective: serverObj,
    objectiveProgress: 2,
    objectivesDone: 0,
  })
  check('optimistic 3 is not lowered to stale 2', merged.objectiveProgress === 3, `got ${merged.objectiveProgress}`)
}

// ---------------------------------------------------------------------------
// SCENARIO 8 (BUG 1): offCollect requirements branch must include the steal
// component (match server 0038) so the optimistic derivation does not diverge.
// ---------------------------------------------------------------------------
console.log('\nScenario 8: offCollect requirements branch includes steal component')
{
  const objective = {
    id: 'gold-robbery',
    kind: 'steal',
    target: 3,
    coinType: 'mixed',
    requirements: { gold: 1 },
    stealTarget: 2,
  }
  // Mirror of the FIXED offCollect derivation.
  const derive = (collectedTypes, stolen) => {
    const target = objective.target ?? 0
    const cap = (v) => (target > 0 ? Math.min(v, target) : v)
    const resources = Object.entries(objective.requirements).reduce(
      (sum, [type, required]) => sum + Math.min(collectedTypes[type] ?? 0, required || 0),
      0,
    )
    const stealTarget = objective.stealTarget || 0
    const steals = stealTarget > 0 ? Math.min(stolen, stealTarget) : 0
    return cap(resources + steals)
  }
  check('gold=1, stolen=0 → 1', derive({ gold: 1 }, 0) === 1, `got ${derive({ gold: 1 }, 0)}`)
  check('gold=1, stolen=1 → 2', derive({ gold: 1 }, 1) === 2, `got ${derive({ gold: 1 }, 1)}`)
  check('gold=1, stolen=2 → 3 (capped)', derive({ gold: 1 }, 2) === 3, `got ${derive({ gold: 1 }, 2)}`)
  check('gold=0, stolen=2 → 2', derive({}, 2) === 2, `got ${derive({}, 2)}`)
}

console.log(`\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2716 FAILURES DETECTED'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
