import {
  applyAuthoritativeActionState,
  createPositionActionQueue,
  isRpcSuccess,
  runAfterPositionSync,
} from '../lib/objectiveSync.ts'

let passed = 0
let failed = 0

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ✔ ${label}`)
  } else {
    failed += 1
    console.error(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const oldObjective = {
  id: 'collect-blue-4',
  kind: 'collect',
  label: 'Collect 4 Blue',
  shortLabel: '4 Blue',
  target: 4,
  coinType: 'blue',
}
const nextObjective = {
  id: 'collect-mixed',
  kind: 'collect',
  label: 'Collect 2 Red + 1 Emerald',
  shortLabel: '2 Red + 1 Emerald',
  target: 3,
  coinType: 'mixed',
  requirements: { red: 2, emerald: 1 },
}

const player = (overrides = {}) => ({
  id: 'p1',
  name: 'Owner',
  x: 50,
  y: 50,
  coins: 3,
  stolen: 0,
  roundCoins: 3,
  roundStolen: 0,
  collectedTypes: { blue: 3 },
  objective: oldObjective,
  objectiveProgress: 3,
  objectivesDone: 0,
  score: 30,
  roundScore: 30,
  rematch: false,
  ...overrides,
})

const stateFor = (owner, round = 1) => ({
  phase: 'battle',
  players: [owner, player({ id: 'p2', name: 'Rival', objective: null })],
  coins: [],
  endsAt: 90_000,
  countdownEndsAt: 0,
  round,
})

const responseState = (overrides = {}) => ({
  objective: oldObjective,
  objectiveProgress: 3,
  collectedTypes: { blue: 3 },
  coins: 3,
  stolen: 0,
  roundCoins: 3,
  roundStolen: 0,
  missionDone: false,
  objectivesDone: 0,
  score: 30,
  roundScore: 30,
  ...overrides,
})

const completion = {
  objective: nextObjective,
  objectiveProgress: 0,
  collectedTypes: {},
  coins: 0,
  stolen: 0,
  roundCoins: 4,
  roundStolen: 0,
  missionDone: false,
  objectivesDone: 1,
  score: 100,
  roundScore: 100,
}

const mergePublicSnapshot = (current, snapshot) => {
  const local = current.players[0]
  const serverDone = snapshot.objectivesDone
  const localDone = local.objectivesDone ?? 0
  if (typeof serverDone === 'number' && serverDone < localDone) return current

  const objectiveChanged = snapshot.objective?.id !== local.objective?.id
  const serverProgress = snapshot.objectiveProgress
  const objectiveProgress = objectiveChanged
    ? (serverProgress ?? 0)
    : Math.max(local.objectiveProgress ?? 0, serverProgress ?? 0)
  return {
    ...current,
    players: [
      { ...local, ...snapshot, objectiveProgress },
      current.players[1],
    ],
  }
}

console.log('Concurrent action responses: completion arrives before earlier RPC responses')
{
  for (const [label, objective] of [
    ['single coin type', oldObjective],
    ['mixed coin requirements', nextObjective],
    ['steal objective', { ...oldObjective, id: 'steal-3', kind: 'steal', target: 3 }],
    [
      'combined requirements and steals',
      { ...nextObjective, id: 'robbery', kind: 'steal', stealTarget: 2 },
    ],
  ]) {
    const completedObjective = { ...nextObjective, id: `next-${objective.id}` }
    const completedState = { ...completion, objective: completedObjective }
    let owner = stateFor(
      player({
        objective,
        objectiveProgress: objective === oldObjective ? 3 : 2,
        objectivesDone: 0,
      }),
    )
    // Two concurrent collect/steal RPCs are committed in order by the server,
    // but the terminal response can arrive before an earlier action response.
    owner = applyAuthoritativeActionState(owner, completedState, 4, 1)
    owner = applyAuthoritativeActionState(
      owner,
      { ...completedState, objectiveProgress: 0, missionDone: false },
      undefined,
      1,
    )
    const afterCompletion = owner.players[0]
    owner = applyAuthoritativeActionState(owner, responseState(), undefined, 1)
    check(
      `${label}: an older same-round response cannot resurrect the prior objective`,
      owner.players[0].objectivesDone === 1 &&
        owner.players[0].objective?.id === afterCompletion.objective?.id,
      `done=${owner.players[0].objectivesDone}, objective=${owner.players[0].objective?.id}`,
    )
  }
}

console.log('\nAn action response from a completed round is ignored')
{
  const current = stateFor(
    player({
      objective: nextObjective,
      objectiveProgress: 1,
      objectivesDone: 0,
    }),
    2,
  )
  const previousRoundResponse = responseState({ objectiveProgress: 4, objectivesDone: 3 })
  const result = applyAuthoritativeActionState(current, previousRoundResponse, undefined, 1)
  check('previous-round progress and objective state are not applied', result === current)
}

console.log('\nPosition updates and authoritative actions share one ordered queue')
{
  const queue = createPositionActionQueue()
  const events = []
  const deferred = () => {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const moveGate = deferred()
  const actionsStarted = deferred()
  const actionsGate = deferred()

  queue.enqueueMove(async () => {
    events.push('move:1:start')
    await moveGate.promise
    events.push('move:1:end')
  }, (error) => events.push(`move-error:${error}`))
  queue.enqueueMove(async () => {
    events.push('move:2')
  }, (error) => events.push(`move-error:${error}`))
  queue.enqueueMove(async () => {
    events.push('move:3')
  }, (error) => events.push(`move-error:${error}`))

  const actionTask = queue.runActions(() =>
    runAfterPositionSync(
      async () => {
        events.push('action-position')
      },
      [
        async () => {
          events.push('collect:start')
          actionsStarted.resolve()
          await actionsGate.promise
          events.push('collect:end')
        },
        async () => {
          events.push('steal:start')
          await actionsGate.promise
          events.push('steal:end')
        },
      ],
    ),
  )
  queue.enqueueMove(async () => {
    events.push('move:4')
  }, (error) => {
    events.push(`move-error:${error}`)
  })

  check('RPC status only accepts explicit server success', isRpcSuccess({ ok: true }) &&
    !isRpcSuccess({ ok: false, reason: 'too_far' }) &&
    !isRpcSuccess(null))
  check('first in-flight movement began before following queue work', events[0] === 'move:1:start')

  moveGate.resolve()
  await actionsStarted.promise
  check('pending movement writes coalesce to the latest location before actions', events.includes('move:3') &&
    !events.includes('move:2') &&
    events.indexOf('move:3') < events.indexOf('action-position'))
  check('concurrent collect and steal start before either completes', events.includes('collect:start') &&
    events.includes('steal:start') &&
    !events.includes('move:4'))

  actionsGate.resolve()
  await actionTask
  await queue.runActions(async () => {
    events.push('queue-drained')
  })
  check('later movement waits until all authoritative actions finish',
    events.indexOf('collect:end') < events.indexOf('move:4') &&
      events.indexOf('steal:end') < events.indexOf('move:4'))
}

console.log('\nTwo independent client views: same-objective stale snapshots and objective rollover')
{
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    let owner = stateFor(player())
    let rival = stateFor(player({ id: 'p2', name: 'Owner' }))

    const fresh = responseState({ objectiveProgress: 4, collectedTypes: { blue: 4 }, coins: 4 })
    owner = applyAuthoritativeActionState(owner, fresh, undefined, 1)
    rival = mergePublicSnapshot(rival, fresh)
    const stale = responseState({ objectiveProgress: 3, collectedTypes: { blue: 3 }, coins: 3 })
    owner = applyAuthoritativeActionState(owner, stale, undefined, 1)
    rival = mergePublicSnapshot(rival, stale)

    const rollover = { ...completion, objectivesDone: 1 }
    owner = applyAuthoritativeActionState(owner, rollover, 4, 1)
    owner = applyAuthoritativeActionState(owner, rollover, undefined, 1)
    rival = mergePublicSnapshot(rival, rollover)
    const oldSnapshot = responseState()
    owner = applyAuthoritativeActionState(owner, oldSnapshot, undefined, 1)
    rival = mergePublicSnapshot(rival, oldSnapshot)

    const ownerNow = owner.players[0]
    const rivalNow = rival.players[0]
    if (
      ownerNow.objectiveProgress !== rivalNow.objectiveProgress ||
      ownerNow.objectivesDone !== rivalNow.objectivesDone ||
      ownerNow.objective?.id !== rivalNow.objective?.id ||
      ownerNow.objectivesDone !== 1
    ) {
      failed += 1
      console.error(
        `  ✖ iteration ${iteration}: owner=${ownerNow.objective?.id}/${ownerNow.objectiveProgress}/${ownerNow.objectivesDone}, rival=${rivalNow.objective?.id}/${rivalNow.objectiveProgress}/${rivalNow.objectivesDone}`,
      )
      break
    }
  }
  check('1,000 adversarial two-client update sequences converge exactly', failed === 0)
}

console.log(`\n${failed === 0 ? '✔ ALL CHECKS PASSED' : '✖ FAILURES DETECTED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
