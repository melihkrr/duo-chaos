import type { Phase, Player } from './types'

export const resultScoreForPlayer = (
  phase: Phase,
  player: Pick<Player, 'id' | 'score' | 'totalScore'>,
  roundScores?: Record<string, number>,
  matchScores?: Record<string, number>,
): number =>
  phase === 'matchover'
    ? matchScores?.[player.id] ?? player.totalScore ?? player.score ?? 0
    : roundScores?.[player.id] ?? player.score ?? 0
