// ============================================================================
// DUO CHAOS — objective OWNER authority test (two-client convergence).
//
// Reproduces stale snapshots on two independent client projections.
//
// Root cause fixed in lib/useDuoChaos.ts:
//   The owner already merged progress monotonically within an objective, but
//   the rival applied every snapshot verbatim. Overlapping polls could return
//   out of order, making the rival move backwards or temporarily disagree.
//   Local collect/steal broadcasts no longer derive objective progress, so the
//   same monotonic server-authoritative merge is safe for both clients.
//
// This test mirrors the EXACT merge rules and drives them through the reported
// interleaving, asserting the invariant:
//   the owner's objective progress is IDENTICAL on BOTH clients at every step.
//
// Run: node scripts/test-objective-owner-authority.mjs
// ============================================================================

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

// --- Mirror of lib/useDuoChaos.ts mergeProgress (LOCAL player's own objective)
// Monotonic per objective id: the local optimistic value must not be lowered by
// a stale snapshot. Correct for the OWNER's own row.
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

// --- Mirror of lib/useDuoChaos.ts mergeRivalProgress (RIVAL's view of the
// owner's objective). Monotonic within one objective, reset only on reroll.
const mergeRivalProgress = (local, server, objectiveChanged) => {
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
  return {
    coins: server.coins ?? local.coins,
    stolen: server.stolen ?? local.stolen,
    roundCoins: server.roundCoins ?? local.roundCoins,
    roundStolen: server.roundStolen ?? local.roundStolen,
    collectedTypes: server.collectedTypes ?? local.collectedTypes ?? {},
    objectiveProgress:
      serverProgress === undefined
        ? local.objectiveProgress ?? 0
        : Math.max(local.objectiveProgress ?? 0, serverProgress),
  }
}

const OBJ = { id: 'steal-3', kind: 'steal', target: 3 }

const makePlayer = (overrides = {}) => ({
  id: 'p1',
  objective: OBJ,
  objectiveProgress: 0,
  objectivesDone: 0,
  coins: 0,
  stolen: 0,
  roundCoins: 0,
  roundStolen: 0,
  collectedTypes: {},
  ...overrides,
})

// ============================================================================
// Scenario 1: owner-authoritative progress is reflected identically when the
// rival has only received a local event (events do not update objectiveProgress).
// ============================================================================
console.log('Scenario 1: owner 2/3, rival receives a steal event before its snapshot')
{
  // Owner's authoritative server state after 2 steals.
  const server = { objective: OBJ, objectiveProgress: 2, objectivesDone: 0, stolen: 2 }
  const rivalLocal = makePlayer({ objectiveProgress: 0, stolen: 2 })
  const rival = mergeRivalProgress(rivalLocal, server, false)
  const owner = mergeProgress(makePlayer(), server, false)
  check('rival applies the owner\u2019s authoritative progress', rival.objectiveProgress === 2)
  check('owner and rival display the SAME progress (2/3)', rival.objectiveProgress === owner.objectiveProgress)
}

// ============================================================================
// Scenario 2: full step-by-step convergence.
//   Owner steals 1, 2, 3. At each step the rival's client receives the local
//   broadcast (optimistic) AND the server snapshot. Both clients must show the
//   owner's authoritative progress at every step.
// ============================================================================
console.log('\nScenario 2: owner steals 1\u21922\u21923 \u2014 both clients identical at every step')
{
  let owner = makePlayer()
  let rival = makePlayer()
  const steps = [1, 2, 3]
  let allIdentical = true
  for (const n of steps) {
    // Server (owner authority) after n steals.
    const server = { objective: OBJ, objectiveProgress: n, objectivesDone: 0, stolen: n }
    // Owner's own client: monotonic merge of its own objective.
    const ownerMerged = mergeProgress(owner, server, false)
    owner = { ...owner, ...ownerMerged }
    // Rival's client: server-authoritative merge of the owner's objective.
    const rivalMerged = mergeRivalProgress(rival, server, false)
    rival = { ...rival, ...rivalMerged }
    const identical = owner.objectiveProgress === rival.objectiveProgress
    allIdentical = allIdentical && identical
    check(
      `after ${n} steal(s): owner=${owner.objectiveProgress}/3, rival=${rival.objectiveProgress}/3`,
      identical && owner.objectiveProgress === n,
      `owner=${owner.objectiveProgress} rival=${rival.objectiveProgress}`,
    )
  }
  check('both clients identical at EVERY step', allIdentical)
}

// ============================================================================
// Scenario 3: an older server snapshot arrives after a newer one; progress
//   must not move backwards on the rival.
// ============================================================================
console.log('\nScenario 3: stale server snapshot cannot move rival progress backwards')
{
  let rival = makePlayer({ objectiveProgress: 3, stolen: 3 })
  const stale = { objective: OBJ, objectiveProgress: 2, objectivesDone: 0, stolen: 2 }
  const merged = mergeRivalProgress(rival, stale, false)
  rival = { ...rival, ...merged }
  check('rival keeps the latest valid value (3), ignoring stale 2', rival.objectiveProgress === 3)
}

// ============================================================================
// Scenario 4: stale snapshot protection still works for the rival.
//   A snapshot whose objectivesDone is BEHIND the local stamp belongs to the
//   PREVIOUS objective; it must be ignored entirely (no field applied).
// ============================================================================
console.log('\nScenario 4: stale snapshot (previous objective) is ignored for the rival')
{
  const rivalLocal = makePlayer({
    objective: { id: 'steal-3', kind: 'steal', target: 3 },
    objectiveProgress: 2,
    objectivesDone: 1,
    stolen: 2,
  })
  // Stale snapshot: objectivesDone 0 < local 1 → belongs to the previous objective.
  const staleServer = {
    objective: { id: 'collect-4', kind: 'collect', target: 4 },
    objectiveProgress: 4,
    objectivesDone: 0,
    stolen: 0,
  }
  const merged = mergeRivalProgress(rivalLocal, staleServer, true)
  check(
    'stale snapshot does not overwrite the rival\u2019s progress',
    merged.objectiveProgress === 2,
    `got ${merged.objectiveProgress}`,
  )
  check('stale snapshot does not overwrite the rival\u2019s stolen', merged.stolen === 2)
}

// ============================================================================
// Scenario 5: genuine reroll resets the rival's view to the new objective.
// ============================================================================
console.log('\nScenario 5: genuine reroll applies the new objective to the rival')
{
  const rivalLocal = makePlayer({ objectiveProgress: 3, objectivesDone: 0, stolen: 3 })
  const newServer = {
    objective: { id: 'collect-2', kind: 'collect', target: 2 },
    objectiveProgress: 0,
    objectivesDone: 1,
    stolen: 0,
  }
  const merged = mergeRivalProgress(rivalLocal, newServer, true)
  check('reroll resets the rival\u2019s progress to 0', merged.objectiveProgress === 0)
  check('reroll resets the rival\u2019s stolen to 0', merged.stolen === 0)
}

// ============================================================================
// Scenario 6: collect objective — owner collects 2 Red, rival sees 2/2.
//   Mirrors offCollect no longer deriving the owner's progress locally.
// ============================================================================
console.log('\nScenario 6: collect objective \u2014 owner 2/2, rival sees 2/2')
{
  const collectObj = { id: 'collect-2-red', kind: 'collect', coinType: 'red', target: 2 }
  const server = { objective: collectObj, objectiveProgress: 2, objectivesDone: 0, coins: 2 }
  // Rival's local row: it received the collect broadcasts but must NOT derive.
  const rivalLocal = makePlayer({ objective: collectObj, objectiveProgress: 0, coins: 2 })
  const merged = mergeRivalProgress(rivalLocal, server, false)
  check(
    'rival shows the owner\u2019s authoritative 2/2',
    merged.objectiveProgress === 2,
    `got ${merged.objectiveProgress}`,
  )
}

// ============================================================================
// Scenario 7: server progress 2 → 3, then a delayed snapshot with 2.
//   Both clients preserve the same monotonic value.
// ============================================================================
console.log('\nScenario 7: adversarial interleaving \u2014 delayed snapshot after progress 3')
{
  let rival = makePlayer({ objectiveProgress: 0, stolen: 0 })
  const seq = [2, 3, 2]
  const seen = []
  for (const n of seq) {
    const server = { objective: OBJ, objectiveProgress: n, objectivesDone: 0, stolen: n }
    const merged = mergeRivalProgress(rival, server, false)
    rival = { ...rival, ...merged }
    seen.push(rival.objectiveProgress)
  }
  check(
    'rival sequence is [2,3,3] (stale progress cannot regress)',
    JSON.stringify(seen) === JSON.stringify([2, 3, 3]),
    `got ${JSON.stringify(seen)}`,
  )
}

console.log(
  `\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 FAILURES'} \u2014 ${passed} passed, ${failed} failed`,
)
process.exit(failed === 0 ? 0 : 1)
