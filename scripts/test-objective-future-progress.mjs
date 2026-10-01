import {
  applyAuthoritativeActionState,
  applyAuthoritativeRivalState,
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

const objectives = [
  {
    id: 'collect-red-3',
    kind: 'collect',
    target: 3,
    requirements: { red: 3 },
    coinType: 'mixed',
  },
  {
    id: 'collect-blue-2',
    kind: 'collect',
    target: 2,
    requirements: { blue: 2 },
    coinType: 'mixed',
  },
  { id: 'collect-green-1', kind: 'collect', target: 1, coinType: 'green' },
]

const initialPlayer = (id) => ({
  id,
  name: id,
  x: 50,
  y: 50,
  coins: 0,
  stolen: 0,
  roundCoins: 0,
  roundStolen: 0,
  collectedTypes: {},
  objective: objectives[0],
  objectiveProgress: 0,
  objectivesDone: 0,
  score: 0,
  roundScore: 0,
  rematch: false,
})

const makeState = (owner, rival) => ({
  phase: 'battle',
  players: [owner, rival],
  coins: [],
  endsAt: 90_000,
  countdownEndsAt: 0,
  round: 1,
})

const progress = (objective, counts, steals, coins) => {
  if (objective.requirements) {
    return Object.entries(objective.requirements).reduce(
      (sum, [type, target]) => sum + Math.min(counts[type] ?? 0, target),
      0,
    )
  }
  if (objective.coinType) return Math.min(counts[objective.coinType] ?? 0, objective.target)
  return Math.min(steals + coins, objective.target)
}

const satisfy = (objective, counts, steals, coins) =>
  progress(objective, counts, steals, coins) >= objective.target

const applyBatch = (server, coinTypes, expectedVersion) => {
  const countsCurrentEpoch = expectedVersion === server.objectivesDone
  const counts = { ...server.collectedTypes }
  let coins = server.coins
  for (const type of coinTypes) {
    if (!countsCurrentEpoch) continue
    counts[type] = (counts[type] ?? 0) + 1
    coins += 1
  }
  const nextProgress = countsCurrentEpoch
    ? progress(server.objective, counts, server.stolen, coins)
    : server.objectiveProgress
  const done = countsCurrentEpoch && satisfy(server.objective, counts, server.stolen, coins)
  const nextObjective = done
    ? objectives[(server.objectivesDone + 1) % objectives.length]
    : server.objective
  const nextServer = done
    ? {
        ...server,
        objective: nextObjective,
        objectiveProgress: 0,
        objectivesDone: server.objectivesDone + 1,
        collectedTypes: {},
        coins: 0,
        stolen: 0,
        roundCoins: server.roundCoins + coinTypes.length,
      }
    : {
        ...server,
        collectedTypes: counts,
        coins,
        objectiveProgress: nextProgress,
        roundCoins: server.roundCoins + coinTypes.length,
      }
  return { server: nextServer, done }
}

const objectiveState = (player) => ({
  objective: player.objective,
  objectiveProgress: player.objectiveProgress,
  collectedTypes: player.collectedTypes,
  coins: player.coins,
  stolen: player.stolen,
  roundCoins: player.roundCoins,
  roundStolen: player.roundStolen,
  missionDone: player.objectivesDone > 0 && player.objectiveProgress === 0,
  objectivesDone: player.objectivesDone,
  score: player.score,
  roundScore: player.roundScore,
})

console.log('Two independent clients: future-objective coins and consecutive rollovers')
{
  let server = initialPlayer('owner')
  let owner = makeState(initialPlayer('owner'), initialPlayer('rival'))
  let rival = makeState(initialPlayer('rival'), initialPlayer('owner'))

  const collect = (types, actionVersion = server.objectivesDone) => {
    const result = applyBatch(server, types, actionVersion)
    server = result.server
    const authoritative = objectiveState(server)
    owner = applyAuthoritativeActionState(owner, authoritative, undefined, 1)
    rival = applyAuthoritativeRivalState(rival, authoritative, 1)
    return result
  }

  collect(['blue'])
  check('Blue collected during the Red objective does not progress Red',
    server.objectiveProgress === 0 && server.collectedTypes.blue === 1)

  collect(['red', 'red'])
  check('Red objective advances only from its required color',
    server.objectiveProgress === 2 && server.objectivesDone === 0)

  const redCompletion = collect(['red'])
  check('Completing Red activates Blue at zero with clean counters',
    redCompletion.done &&
      server.objective.id === 'collect-blue-2' &&
      server.objectiveProgress === 0 &&
      Object.keys(server.collectedTypes).length === 0 &&
      server.coins === 0)
  for (const client of [owner, rival]) {
    const objectiveOwner = client.players[client.players[0].id === 'owner' ? 0 : 1]
    check(`${client.players[0].id} view resets all objective counters on rollover`,
      objectiveOwner.objectiveProgress === 0 &&
        Object.keys(objectiveOwner.collectedTypes).length === 0 &&
        objectiveOwner.coins === 0 &&
        objectiveOwner.stolen === 0)
  }

  collect(['blue'], 0)
  check('An action queued under the old objective cannot progress the new one',
    server.objectiveProgress === 0 &&
      server.collectedTypes.blue === undefined &&
      server.objectivesDone === 1)

  collect(['blue'])
  check('A new Blue action progresses the active Blue objective',
    server.objectiveProgress === 1 && server.collectedTypes.blue === 1)

  collect(['blue'])
  check('Second objective completes and third objective also starts at zero',
    server.objective.id === 'collect-green-1' &&
      server.objectiveProgress === 0 &&
      Object.keys(server.collectedTypes).length === 0 &&
      server.objectivesDone === 2)

  collect(['green'])
  check('Third consecutive objective completes from its own action',
    server.objectivesDone === 3 && server.objectiveProgress === 0)

  for (const client of [owner, rival]) {
    const stateOwner = client.players[client.players[0].id === 'owner' ? 0 : 1]
    check(`${client.players[0].id} client converges to owner objective version`,
      stateOwner.objectivesDone === server.objectivesDone &&
        stateOwner.objective?.id === server.objective.id &&
        stateOwner.objectiveProgress === server.objectiveProgress)
  }
}

console.log('\nCollection transaction latency: one response for a multi-coin action')
{
  let calls = 0
  let positionSyncs = 0
  let acceptedCoinIds = []
  await runAfterPositionSync(
    async () => {
      positionSyncs += 1
    },
    [
      async () => {
        calls += 1
        acceptedCoinIds = [11, 12, 13]
      },
    ],
    true,
  )
  check('three simultaneous pickups are acknowledged by one RPC response',
    calls === 1 && acceptedCoinIds.length === 3 && positionSyncs === 0)
}

console.log(`\n${failed === 0 ? '✔ ALL CHECKS PASSED' : '✖ FAILURES DETECTED'} — ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
