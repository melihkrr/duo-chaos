import { objectiveSatisfied, progressOf } from '../lib/display.ts'
import { claimSinglePlayerPickupIds } from '../lib/singlePlayerPickup.ts'

let failures = 0
const check = (name, condition) => {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}`)
  }
}

const objective = {
  id: 'red-pair',
  kind: 'collect',
  label: 'Collect 2 Red',
  shortLabel: '2 Red',
  target: 2,
  coinType: 'red',
  points: 50,
}
const player = {
  id: 'p1',
  name: 'You',
  x: 0,
  y: 0,
  coins: 0,
  stolen: 0,
  collectedTypes: {},
  objectiveProgress: 0,
  score: 0,
  objective,
  rematch: false,
}
const redCoins = [
  { id: 10, type: 'red', collectedBy: undefined },
  { id: 11, type: 'red', collectedBy: undefined },
]
const claimed = new Map()

const processPickupEvent = (ids, now) => {
  const accepted = claimSinglePlayerPickupIds(redCoins, ids, now, claimed)
  player.collectedTypes.red = (player.collectedTypes.red ?? 0) + accepted.length
  player.coins += accepted.length
  const countersOnly = { ...player, objectiveProgress: undefined }
  player.objectiveProgress = progressOf(countersOnly)
  return { accepted, done: objectiveSatisfied(countersOnly) }
}

console.log('Single-player Collect 2 Red: unique coin pickup accounting')
const first = processPickupEvent([10], 1_000)
check('One Red pickup produces exactly 1/2 and stays incomplete',
  first.accepted.length === 1 && player.objectiveProgress === 1 && !first.done)

const duplicate = processPickupEvent([10], 1_016)
check('Retriggering the same coin event does not increase progress',
  duplicate.accepted.length === 0 && player.objectiveProgress === 1 && !duplicate.done)

const duplicateIds = processPickupEvent([10, 10], 1_032)
check('Duplicate IDs in one event are counted at most once',
  duplicateIds.accepted.length === 0 && player.objectiveProgress === 1 && !duplicateIds.done)

const second = processPickupEvent([11], 1_048)
check('A second distinct Red pickup produces exactly 2/2 and completes',
  second.accepted.length === 1 && player.objectiveProgress === 2 && second.done)

const respawned = claimSinglePlayerPickupIds(redCoins, [10], 4_100, claimed)
check('A coin ID can be claimed again after its respawn',
  respawned.length === 1 && respawned[0] === 10)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
