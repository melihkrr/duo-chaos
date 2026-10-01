import { resultScoreForPlayer } from '../lib/results.ts'

let failures = 0
const check = (label, condition) => {
  if (condition) console.log(`  ✔ ${label}`)
  else {
    failures += 1
    console.error(`  ✖ ${label}`)
  }
}

console.log('Round results use the same finalized server scores on both clients')
{
  const hostRoundScores = { p1: 1640, p2: 20 }
  const hostPlayers = [
    { id: 'p1', score: 1660, totalScore: 1660 },
    { id: 'p2', score: 20, totalScore: 20 },
  ]
  const guestRoundScores = { p1: 20, p2: 1640 }
  const guestPlayers = [
    { id: 'p1', score: 20, totalScore: 20 },
    { id: 'p2', score: 1640, totalScore: 1660 },
  ]

  const hostScoreByPlayer = {
    host: resultScoreForPlayer('results', hostPlayers[0], hostRoundScores),
    guest: resultScoreForPlayer('results', hostPlayers[1], hostRoundScores),
  }
  const guestScoreByPlayer = {
    guest: resultScoreForPlayer('results', guestPlayers[0], guestRoundScores),
    host: resultScoreForPlayer('results', guestPlayers[1], guestRoundScores),
  }
  check('host results use finalized round score rather than stale higher player score',
    hostScoreByPlayer.host === 1640)
  check('both clients show identical scores for both player identities',
    hostScoreByPlayer.host === guestScoreByPlayer.host &&
      hostScoreByPlayer.guest === guestScoreByPlayer.guest)
}

console.log('\nMatch-over results continue to use cumulative match scores')
check('match score takes precedence over per-round player score',
  resultScoreForPlayer(
    'matchover',
    { id: 'p1', score: 1640, totalScore: 1640 },
    { p1: 1640, p2: 20 },
    { p1: 3120, p2: 2780 },
  ) === 3120)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
