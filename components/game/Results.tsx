'use client'

import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { missionLabel, objectiveOf } from '../../lib/display'
import type { ProgressApi } from '../../lib/useProgress'
import type { State } from '../../lib/types'

type Props = {
  state: State
  progress: ProgressApi
  isHost: boolean
  onNextRound: () => void
  onRematch: () => void
  onLeave: () => void
  busy?: boolean
}

export function Results({ state, progress, isHost, onNextRound, onRematch, onLeave, busy }: Props) {
  const isMatchOver = state.phase === 'matchover'
  const winner = state.winner
  const meWon = winner === 'p1'

  return (
    <Panel
      title={isMatchOver ? 'Match over' : `Round ${state.round} results`}
      subtitle={
        isMatchOver
          ? winner
            ? meWon
              ? 'You win the match!'
              : 'Your rival takes the match.'
            : 'Match complete'
          : 'Next round starting soon'
      }
      className="results"
    >
      {isMatchOver && winner && (
        <div className="results-celebrate" aria-hidden>
          <span>{meWon ? '🏆' : '🎈'}</span>
          <strong>{meWon ? 'Victory!' : 'Good game!'}</strong>
        </div>
      )}

      <div className="score-list">
        {state.players.map((player, index) => {
          const objective = objectiveOf(player)
          const roundScore = state.roundScores?.[player.id] ?? player.roundScore ?? 0
          const matchScore = state.matchScores?.[player.id] ?? player.totalScore ?? 0
          const isWinner = winner === player.id
          return (
            <div key={player.id} className={['score-row', isWinner ? 'winner' : ''].join(' ')}>
              <div className="score-id">
                <span className="score-avatar" aria-hidden>
                  {isWinner ? '👑' : index === 0 ? '🐰' : '🐻'}
                </span>
                <div>
                  <strong>{player.name}</strong>
                  <small className="muted">{missionLabel(objective)}</small>
                </div>
              </div>
              <div className="score-values">
                <span>
                  <small>Round</small>
                  {roundScore}
                </span>
                <span>
                  <small>Match</small>
                  {matchScore}
                </span>
                {index === 0 && (
                  <span>
                    <small>XP</small>
                    {progress.progress.xp}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="results-actions">
        {isMatchOver ? (
          isHost ? (
            <Button onClick={onRematch} disabled={busy}>
              Rematch
            </Button>
          ) : (
            <p className="muted">Waiting for host to rematch…</p>
          )
        ) : (
          <Button onClick={onNextRound} disabled={busy}>
            Next round
          </Button>
        )}
        <Button variant="ghost" onClick={onLeave}>
          Leave
        </Button>
      </div>
    </Panel>
  )
}
