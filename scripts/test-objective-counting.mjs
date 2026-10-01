// ============================================================================
// Deterministic test of the objective COUNTING logic.
//
// Mirrors BOTH the server (`duo_mission_progress` / `duo_mission_satisfied`)
// and the client (`progressOf` / optimistic derivation) so we can prove the
// per-requirement counters are exact and that a coin NEVER counts toward a
// requirement it does not match.
//
// Usage: node scripts/test-objective-counting.mjs
// ============================================================================

let passed = 0
let failed = 0
const check = (label, cond) => {
  if (cond) {
    passed += 1
    console.log(`  ✔ ${label}`)
  } else {
    failed += 1
    console.log(`  ✖ ${label}`)
  }
}

// ---------------------------------------------------------------------------
// SERVER: duo_mission_progress (must be capped at target for ALL branches)
// ---------------------------------------------------------------------------
const serverProgress = (objective, collected, stolen, coins) => {
  if (!objective) return 0
  const reqs = objective.requirements
  let progress = 0
  if (reqs && typeof reqs === 'object') {
    for (const [key, required] of Object.entries(reqs)) {
      progress += Math.min(collected?.[key] ?? 0, required ?? 0)
    }
    // STEAL COMPONENT (0038): "Steal 2 and secure 1 Gold" needs BOTH.
    const stealTarget = objective.stealTarget ?? 0
    if (stealTarget > 0) progress += Math.min(stolen ?? 0, stealTarget)
  } else if (objective.coinType && objective.coinType !== 'mixed') {
    progress = collected?.[objective.coinType] ?? 0
  } else {
    progress = objective.kind === 'steal' ? stolen : coins
  }
  // CAP AT TARGET — a requirement can never exceed the objective's target.
  const target = objective.target ?? 0
  return target > 0 ? Math.min(progress, target) : progress
}

// ---------------------------------------------------------------------------
// SERVER: duo_mission_satisfied
// ---------------------------------------------------------------------------
const serverSatisfied = (objective, collected, stolen, coins) => {
  if (!objective) return false
  const target = objective.target ?? 0
  const reqs = objective.requirements
  let resourcesMet = true
  let stealsMet = true
  let progress = 0
  if (reqs && typeof reqs === 'object') {
    for (const [key, required] of Object.entries(reqs)) {
      if ((collected?.[key] ?? 0) < (required ?? 0)) resourcesMet = false
      progress += Math.min(collected?.[key] ?? 0, required ?? 0)
    }
    // STEAL COMPONENT (0038): resource + steal objectives count steals too.
    const stealTarget = objective.stealTarget ?? 0
    if (stealTarget > 0) progress += Math.min(stolen ?? 0, stealTarget)
  } else if (objective.coinType && objective.coinType !== 'mixed') {
    progress = collected?.[objective.coinType] ?? 0
  } else {
    progress = objective.kind === 'steal' ? stolen : coins
  }
  if (objective.kind === 'steal') {
    stealsMet = stolen >= (objective.stealTarget ?? target)
  }
  return resourcesMet && stealsMet && progress >= target
}

// ---------------------------------------------------------------------------
// CLIENT: progressOf fallback (must match server exactly)
// ---------------------------------------------------------------------------
const clientProgress = (objective, collected, stolen, coins) => {
  if (!objective) return 0
  const target = objective.target ?? 0
  const cap = (v) => (target > 0 ? Math.min(v, target) : v)
  if (objective.requirements) {
    let sum = 0
    for (const [type, required] of Object.entries(objective.requirements)) {
      sum += Math.min(collected?.[type] ?? 0, required ?? 0)
    }
    // STEAL COMPONENT (0038).
    const stealTarget = objective.stealTarget ?? 0
    if (stealTarget > 0) sum += Math.min(stolen ?? 0, stealTarget)
    return cap(sum)
  }
  if (objective.coinType && objective.coinType !== 'mixed') {
    return cap(collected?.[objective.coinType] ?? 0)
  }
  return cap(objective.kind === 'steal' ? stolen : coins)
}

// ---------------------------------------------------------------------------
// CLIENT: optimistic derivation in offCollect (mirrors lib/useDuoChaos.ts)
// ---------------------------------------------------------------------------
const clientOptimistic = (objective, collected, stolen, coins) => {
  const target = objective?.target ?? 0
  const cap = (v) => (target > 0 ? Math.min(v, target) : v)
  if (objective?.requirements) {
    let sum = 0
    for (const [type, required] of Object.entries(objective.requirements)) {
      sum += Math.min(collected?.[type] ?? 0, required ?? 0)
    }
    // STEAL COMPONENT (0038).
    const stealTarget = objective.stealTarget ?? 0
    if (stealTarget > 0) sum += Math.min(stolen ?? 0, stealTarget)
    return cap(sum)
  }
  if (objective?.coinType && objective.coinType !== 'mixed') {
    return cap(collected?.[objective.coinType] ?? 0)
  }
  if (objective?.kind === 'steal') return cap(stolen)
  return cap(coins)
}

// ---------------------------------------------------------------------------
// Scenario runner: simulate collecting a sequence of coin types.
// ---------------------------------------------------------------------------
const runCollect = (objective, sequence) => {
  const collected = {}
  let coins = 0
  const steps = []
  for (const type of sequence) {
    collected[type] = (collected[type] ?? 0) + 1
    coins += 1
    const sp = serverProgress(objective, collected, 0, coins)
    const cp = clientProgress(objective, collected, 0, coins)
    const op = clientOptimistic(objective, collected, 0, coins)
    steps.push({ type, collected: { ...collected }, server: sp, client: cp, optimistic: op })
  }
  return steps
}

const RED_EMERALD = {
  id: 'red-burn',
  kind: 'collect',
  label: 'Collect 2 Red + 1 Emerald',
  target: 3,
  coinType: 'mixed',
  requirements: { red: 2, emerald: 1 },
}

const GOLD3 = { id: 'gold-rush', kind: 'collect', label: 'Collect 3 Gold', target: 3, coinType: 'gold' }
const BLUE4 = { id: 'blue-pressure', kind: 'collect', label: 'Collect 4 Blue', target: 4, coinType: 'blue' }
const BLUE2RED2 = { id: 'blue-raid', kind: 'collect', label: 'Collect 2 Blue + 2 Red', target: 4, coinType: 'mixed', requirements: { blue: 2, red: 2 } }
const STEAL3 = { id: 'resource-control', kind: 'steal', label: 'Steal 3 from your rival', target: 3, coinType: 'mixed' }
// "Steal 2 and secure 1 Gold" — HEM kaynak (1 Gold) HEM çalma (2 steal).
const GOLD_ROBBERY = {
  id: 'gold-robbery',
  kind: 'steal',
  label: 'Steal 2 and secure 1 Gold',
  target: 3,
  coinType: 'mixed',
  requirements: { gold: 1 },
  stealTarget: 2,
}

console.log('\nScenario A: "Collect 2 Red + 1 Emerald" — collect 2 Red then 1 Emerald')
{
  const steps = runCollect(RED_EMERALD, ['red', 'red', 'emerald'])
  check('after 1 Red → 1/3', steps[0].server === 1 && steps[0].client === 1 && steps[0].optimistic === 1)
  check('after 2 Red → 2/3 (NOT 3)', steps[1].server === 2 && steps[1].client === 2 && steps[1].optimistic === 2)
  check('after 1 Emerald → 3/3', steps[2].server === 3 && steps[2].client === 3 && steps[2].optimistic === 3)
  check('server == client == optimistic at every step', steps.every((s) => s.server === s.client && s.client === s.optimistic))
}

console.log('\nScenario B: "Collect 2 Red + 1 Emerald" — collect 1 Red only')
{
  const steps = runCollect(RED_EMERALD, ['red'])
  check('after 1 Red → exactly 1/3', steps[0].server === 1 && steps[0].client === 1)
}

console.log('\nScenario C: "Collect 2 Red + 1 Emerald" — a Blue coin must NOT count')
{
  const steps = runCollect(RED_EMERALD, ['blue', 'blue', 'blue'])
  check('3 Blue coins → 0/3 (no matching requirement)', steps[2].server === 0 && steps[2].client === 0 && steps[2].optimistic === 0)
}

console.log('\nScenario D: "Collect 2 Red + 1 Emerald" — extra Red must NOT exceed requirement')
{
  const steps = runCollect(RED_EMERALD, ['red', 'red', 'red', 'red'])
  check('4 Red coins → 2/3 (Red capped at 2)', steps[3].server === 2 && steps[3].client === 2 && steps[3].optimistic === 2)
}

console.log('\nScenario E: "Collect 3 Gold" — over-collection must be capped at target')
{
  const steps = runCollect(GOLD3, ['gold', 'gold', 'gold', 'gold', 'gold'])
  check('5 Gold → 3/3 (capped, not 5/3)', steps[4].server === 3 && steps[4].client === 3 && steps[4].optimistic === 3)
  check('non-gold coin does not count', runCollect(GOLD3, ['blue'])[0].server === 0)
}

console.log('\nScenario F: "Collect 4 Blue" — over-collection capped')
{
  const steps = runCollect(BLUE4, ['blue', 'blue', 'blue', 'blue', 'blue', 'blue'])
  check('6 Blue → 4/4 (capped)', steps[5].server === 4 && steps[5].client === 4 && steps[5].optimistic === 4)
}

console.log('\nScenario G: "Collect 2 Blue + 2 Red" — mixed requirements, order independent')
{
  const a = runCollect(BLUE2RED2, ['blue', 'red', 'blue', 'red'])
  const b = runCollect(BLUE2RED2, ['red', 'red', 'blue', 'blue'])
  check('blue,red,blue,red → 4/4', a[3].server === 4 && a[3].client === 4)
  check('red,red,blue,blue → 4/4', b[3].server === 4 && b[3].client === 4)
  check('2 Blue only → 2/4', runCollect(BLUE2RED2, ['blue', 'blue'])[1].server === 2)
  check('3 Blue + 1 Red → 3/4 (Blue capped at 2)', runCollect(BLUE2RED2, ['blue', 'blue', 'blue', 'red'])[3].server === 3)
}

console.log('\nScenario H: "Steal 3" — only steals count, coins do not')
{
  check('0 stolen, 5 coins → 0/3', serverProgress(STEAL3, {}, 0, 5) === 0)
  check('3 stolen → 3/3', serverProgress(STEAL3, {}, 3, 0) === 3)
  check('satisfied only at 3 stolen', serverSatisfied(STEAL3, {}, 3, 0) === true && serverSatisfied(STEAL3, {}, 2, 0) === false)
}

console.log('\nScenario I: completion detection is exact')
{
  check('2 Red + 1 Emerald satisfies', serverSatisfied(RED_EMERALD, { red: 2, emerald: 1 }, 0, 3) === true)
  check('2 Red + 0 Emerald does NOT satisfy', serverSatisfied(RED_EMERALD, { red: 2 }, 0, 2) === false)
  check('3 Red + 0 Emerald does NOT satisfy (missing Emerald)', serverSatisfied(RED_EMERALD, { red: 3 }, 0, 3) === false)
  check('2 Red + 1 Emerald + 5 Blue satisfies', serverSatisfied(RED_EMERALD, { red: 2, emerald: 1, blue: 5 }, 0, 8) === true)
}

console.log('\nScenario J: "Steal 2 and secure 1 Gold" — steals MUST count (0038)')
{
  // The exact user-reported flow: steal twice, then collect 1 Gold.
  check('0 stolen, 0 gold → 0/3', serverProgress(GOLD_ROBBERY, {}, 0, 0) === 0)
  check('1 steal → 1/3 (steal counts!)', serverProgress(GOLD_ROBBERY, {}, 1, 0) === 1)
  check('2 steals → 2/3', serverProgress(GOLD_ROBBERY, {}, 2, 0) === 2)
  check('2 steals + 1 Gold → 3/3', serverProgress(GOLD_ROBBERY, { gold: 1 }, 2, 1) === 3)
  check('1 Gold only (no steals) → 1/3', serverProgress(GOLD_ROBBERY, { gold: 1 }, 0, 1) === 1)
  check('extra steals capped at stealTarget (5 steals → 2/3)', serverProgress(GOLD_ROBBERY, {}, 5, 0) === 2)
  check('extra Gold capped at requirement (3 Gold + 2 steals → 3/3)', serverProgress(GOLD_ROBBERY, { gold: 3 }, 2, 3) === 3)
  check('server == client == optimistic at every step', [
    [serverProgress(GOLD_ROBBERY, {}, 1, 0), clientProgress(GOLD_ROBBERY, {}, 1, 0), clientOptimistic(GOLD_ROBBERY, {}, 1, 0)],
    [serverProgress(GOLD_ROBBERY, {}, 2, 0), clientProgress(GOLD_ROBBERY, {}, 2, 0), clientOptimistic(GOLD_ROBBERY, {}, 2, 0)],
    [serverProgress(GOLD_ROBBERY, { gold: 1 }, 2, 1), clientProgress(GOLD_ROBBERY, { gold: 1 }, 2, 1), clientOptimistic(GOLD_ROBBERY, { gold: 1 }, 2, 1)],
  ].every(([s, c, o]) => s === c && c === o))
  check('NOT satisfied with 2 steals but 0 Gold', serverSatisfied(GOLD_ROBBERY, {}, 2, 0) === false)
  check('NOT satisfied with 1 Gold but 1 steal', serverSatisfied(GOLD_ROBBERY, { gold: 1 }, 1, 1) === false)
  check('satisfied with 2 steals + 1 Gold', serverSatisfied(GOLD_ROBBERY, { gold: 1 }, 2, 1) === true)
  check('satisfied with 3 steals + 1 Gold', serverSatisfied(GOLD_ROBBERY, { gold: 1 }, 3, 1) === true)
}

console.log(`\n${failed === 0 ? '✔ ALL CHECKS PASSED' : '✖ FAILURES'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
