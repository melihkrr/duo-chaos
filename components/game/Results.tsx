'use client'

import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import type { State } from '../../lib/types'

type Props = {
  state: State
  isHost: boolean
  /** Yerel oyuncu "sonraki tur" için onay verdi mi? */
  nextReady: boolean
  /** Rakip "sonraki tur" için onay verdi mi? */
  rivalNextReady: boolean
  /** Onay ver — tur ancak iki oyuncu da onaylayınca başlar. */
  onApproveNextRound: () => void
  onRematch: () => void
  busy?: boolean
}

export function Results({
  state,
  isHost,
  nextReady,
  rivalNextReady,
  onApproveNextRound,
  onRematch,
  busy,
}: Props) {
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
          <>
            {/* Tur, İKİ oyuncunun da onayıyla başlar. Onay vermeden önce
                buton "Ready for next round"; verdikten sonra rakip beklenir. */}
            <Button onClick={onApproveNextRound} disabled={busy || nextReady}>
              {nextReady ? '✅ Ready — waiting for rival' : 'Ready for next round'}
            </Button>
            <p className="muted next-ready-status" aria-live="polite">
              {nextReady && rivalNextReady
                ? 'Both ready — starting…'
                : nextReady
                  ? 'Waiting for your rival to accept…'
                  : rivalNextReady
                    ? 'Your rival is ready. Your turn!'
                    : 'Both players must accept to start the next round.'}
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}
