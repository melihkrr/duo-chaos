// ============================================================================
// DUO CHAOS — objective OWNER authority test (two-client convergence).
//
// Reproduces the reported bug:
//   Objective: "Steal 3 from your rival".
//   The OWNER correctly sees 2/3, but the OTHER PLAYER sees 3/3.
//
// ROOT CAUSE (fixed in lib/useDuoChaos.ts):
//   The rival's client optimistically DERIVED the owner's `objectiveProgress`
//   from its own local `collect`/`steal` broadcasts (offCollect / offSteal),
//   and the pull loop's rival branch used `mergeProgress` — which is MONOTONIC
//   (`Math.max(local, server)`). Once the rival's locally-derived value reached
//   3, `Math.max` LOCKED it at 3 forever, even when the server (the owner's
//   authority) said 2. Result: owner 2/3, rival 3/3.
//
// FIX:
//   1. offCollect / offSteal NO LONGER derive the owner's objectiveProgress
//      locally (they only update optimistic coins/stolen/collectedTypes).
//   2. The rival branch uses `mergeRivalProgress` — SERVER-AUTHORITATIVE, NOT
//      monotonic — so the owner's authoritative value is reflected EXACTLY.
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
// owner's objective). SERVER-AUTHORITATIVE, NOT monotonic. This is the fix.
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
    objectiveProgress: serverProgress ?? local.objectiveProgress ?? 0,
  }
}

// --- The OLD (buggy) rival merge: monotonic, same as mergeProgress. Used only
// to PROVE the bug reproduces without the fix.
const mergeRivalProgressBuggy = mergeProgress

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
// Scenario 1: the EXACT reported case.
//   Owner steals 2 → server says 2/3. Rival's client ALSO receives a 3rd
//   `steal` broadcast (e.g. a duplicate/late/optimistic local event) BEFORE the
//   server snapshot catches up. With the OLD monotonic merge the rival locks at
//   3; with the FIX the rival follows the server (2).
// ============================================================================
console.log('Scenario 1: owner 2/3, rival receives a spurious 3rd steal broadcast')
{
  // Owner's authoritative server state after 2 steals.
  const server = { objective: OBJ, objectiveProgress: 2, objectivesDone: 0, stolen: 2 }

  // Rival's local row. The OLD offSteal derived progress locally → 3.
  const rivalLocalBuggy = makePlayer({ objectiveProgress: 3, stolen: 3 })
  const rivalLocalFixed = makePlayer({ objectiveProgress: 0, stolen: 3 })

  const buggy = mergeRivalProgressBuggy(rivalLocalBuggy, server, false)
  const fixed = mergeRivalProgress(rivalLocalFixed, server, false)

  check(
    'OLD merge locks the rival at 3/3 (reproduces the bug)',
    buggy.objectiveProgress === 3,
    `got ${buggy.objectiveProgress}`,
  )
  check(
    'FIXED merge shows the owner\u2019s authoritative 2/3 to the rival',
    fixed.objectiveProgress === 2,
    `got ${fixed.objectiveProgress}`,
  )
  check(
    'owner and rival now display the SAME progress (2/3)',
    fixed.objectiveProgress === server.objectiveProgress,
  )
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
// Scenario 3: the rival's local broadcast arrives but the server snapshot is
//   STALE (behind). The rival must NOT jump ahead of the owner's authority.
// ============================================================================
console.log('\nScenario 3: rival local broadcast ahead of a stale server snapshot')
{
  // Rival optimistically saw 3 steals locally, but the server (owner authority)
  // is still at 2 and its snapshot is NOT stale (objectivesDone equal).
  const rivalLocal = makePlayer({ objectiveProgress: 3, stolen: 3 })
  const server = { objective: OBJ, objectiveProgress: 2, objectivesDone: 0, stolen: 2 }
  const merged = mergeRivalProgress(rivalLocal, server, false)
  check(
    'rival follows the server (2), not its local optimistic 3',
    merged.objectiveProgress === 2,
    `got ${merged.objectiveProgress}`,
  )
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
// Scenario 7: adversarial interleaving — rival local 3, then server 2, then
//   server 3. The rival must track the server EXACTLY (2 then 3), never lock.
// ============================================================================
console.log('\nScenario 7: adversarial interleaving \u2014 rival tracks the server exactly')
{
  let rival = makePlayer({ objectiveProgress: 3, stolen: 3 })
  const seq = [2, 2, 3]
  const seen = []
  for (const n of seq) {
    const server = { objective: OBJ, objectiveProgress: n, objectivesDone: 0, stolen: n }
    const merged = mergeRivalProgress(rival, server, false)
    rival = { ...rival, ...merged }
    seen.push(rival.objectiveProgress)
  }
  check(
    'rival sequence is [2,2,3] (follows server, never locked at 3)',
    JSON.stringify(seen) === JSON.stringify([2, 2, 3]),
    `got ${JSON.stringify(seen)}`,
  )
}

console.log(
  `\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2718 FAILURES'} \u2014 ${passed} passed, ${failed} failed`,
)
process.exit(failed === 0 ? 0 : 1)
