import { markPendingCollect, settlePendingCollect } from '../lib/coinCollectionState.ts'

let failures = 0
const check = (name, condition) => {
  if (condition) console.log(`  ✔ ${name}`)
  else {
    failures += 1
    console.error(`  ✖ ${name}`)
  }
}

const initial = {
  phase: 'battle',
  round: 2,
  players: [{ id: 'p1', objectiveProgress: 1, coins: 1 }],
  coins: [
    { id: 10, x: 20, y: 20, type: 'red' },
    { id: 11, x: 30, y: 30, type: 'blue' },
  ],
}

console.log('Pending collect visuals do not change authoritative game progress')
const pending = markPendingCollect(initial, [10], 2)
check('coin hides on the collecting client immediately',
  pending.coins[0].pendingCollect === true)
check('pending visual does not change objective or player counters',
  pending.players === initial.players &&
    pending.players[0].objectiveProgress === 1 &&
    pending.players[0].coins === 1)
check('another round cannot inherit a pending visual update',
  markPendingCollect(initial, [10], 1) === initial)

const rejected = settlePendingCollect(pending, [10], [], 0, 2)
check('a rejected pickup is restored visibly',
  rejected.coins[0].pendingCollect === false &&
    rejected.coins[0].collectedBy === undefined)

const accepted = settlePendingCollect(pending, [10], [10], 5_000, 2)
check('only server-accepted pickup becomes collected',
  accepted.coins[0].collectedBy === 'p1' &&
    accepted.coins[0].pendingCollect === false &&
    accepted.coins[0].respawnAt === 5_000)
check('unrelated coins remain unchanged',
  accepted.coins[1] === pending.coins[1])

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
