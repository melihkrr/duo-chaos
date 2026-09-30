'use client'

import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import type { State } from '../../lib/types'

type Props = {
  state: State
  isHost: boolean
  onNextRound: () => void
  onRematch: () => void
  busy?: boolean
}

export function Results({ state, isHost, onNextRound, onRematch, busy }: Props) {
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
          // Yalnızca PUAN gösterilir. Görev/round/match/XP kaldırıldı: puan
          // zaten oyunun tek ölçüsü, XP ise kişisel bir ilerleme verisi.
          const score = player.score ?? 0
          const isWinner = winner === player.id
          return (
            <div key={player.id} className={['score-row', isWinner ? 'winner' : ''].join(' ')}>
              <div className="score-id">
                <span className="score-avatar" aria-hidden>
                  {isWinner ? '👑' : index === 0 ? '🐰' : '🐻'}
                </span>
                <div>
                  <strong>{player.name}</strong>
                  <small className="muted">{index === 0 ? 'You' : 'Rival'}</small>
                </div>
              </div>
              <div className="score-values">
                <span className="score-big">
                  <small>Score</small>
                  {score}
                </span>
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
      </div>
    </Panel>
  )
}
