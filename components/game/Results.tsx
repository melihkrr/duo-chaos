'use client'

import { useEffect, useState, type RefObject } from 'react'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import type { State } from '../../lib/types'

type Props = {
  state: State
  /** Yerel oyuncu "sonraki tur" için onay verdi mi? */
  nextReady: boolean
  /** Rakip "sonraki tur" için onay verdi mi? */
  rivalNextReady: boolean
  /** Onay ver — tur ancak iki oyuncu da onaylayınca başlar. */
  onApproveNextRound: () => void
  /** Yerel oyuncu rövanş için onay verdi mi? */
  rematchReady: boolean
  /** Rakip rövanş için onay verdi mi? */
  rivalRematchReady: boolean
  onRematch: () => void
  busy?: boolean
  /**
   * Tur boyunca toplanan/çalınan GERÇEK toplamlar. `player.coins` sunucuda
   * görev değişiminde sıfırlandığı için tur sonu istatistikleri için
   * güvenilir değildir; bu ref iki istemcide de aynı değeri taşır.
   */
  roundTotalRef?: RefObject<{ round: number; coins: number; stolen: number } | null>
}

export function Results({
  state,
  nextReady,
  rivalNextReady,
  onApproveNextRound,
  rematchReady,
  rivalRematchReady,
  onRematch,
  busy,
  roundTotalRef,
}: Props) {
  const isMatchOver = state.phase === 'matchover'
  const winner = state.winner
  const meWon = winner === 'p1'

  // TUR TOPLAMI: ref'i render sırasında OKUMAK yasaktır (react-hooks/refs).
  // Bu yüzden değeri bir effect ile state'e anlık görüntü olarak alırız.
  // `state.round` bağımlılığı sayesinde tur bittiğinde güncel toplam yakalanır.
  const [roundTotals, setRoundTotals] = useState<{ coins: number; stolen: number } | null>(null)
  useEffect(() => {
    const snapshot = roundTotalRef?.current
    if (!snapshot) return
    setRoundTotals({ coins: snapshot.coins, stolen: snapshot.stolen })
  }, [roundTotalRef, state.round, state.phase])

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
          // TUR TOPLAMI: yerel oyuncu için `roundTotals` (tur boyunca
          // biriktirilen GERÇEK toplam) kullanılır. `player.coins` sunucuda
          // görev değişiminde sıfırlandığı için iki istemci farklı değer
          // görebiliyordu (19 vs 20). Rakip için sunucu değerine düşeriz.
          const roundCoins = index === 0 && roundTotals ? roundTotals.coins : player.coins ?? 0
          const roundStolen = index === 0 && roundTotals ? roundTotals.stolen : player.stolen ?? 0
          // Yalnızca PUAN gösterilir. Görev/round/match/XP kaldırıldı: puan
          // zaten oyunun tek ölçüsü, XP ise kişisel bir ilerleme verisi.
          //
          // ÖNEMLİ (MAÇ SONU): Maç bittiğinde (`matchover`) TUR puanı değil,
          // MAÇ TOPLAMI gösterilir. Aksi halde kazananın puanı yalnızca son
          // turun puanı gibi görünür ve "puanlar tutmuyor" izlenimi doğar.
          // Sunucu `total_score`'u `duo_tick` tur bitişinde hesaplar.
          const score = isMatchOver
            ? player.totalScore ?? state.matchScores?.[player.id] ?? player.score ?? 0
            : player.score ?? 0
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
                {/* Tur içi performans kırılımı: toplanan coin, çalınan coin ve
                    tamamlanan görev. Maç sonunda tur istatistikleri sıfırlandığı
                    için yalnızca tur sonuçlarında gösterilir. */}
                {!isMatchOver && (
                  <span className="score-stats" aria-label="Round stats">
                    <span className="stat-chip" title="Coins collected">
                      <span aria-hidden>🪙</span>
                      {roundCoins}
                    </span>
                    <span className="stat-chip" title="Coins stolen">
                      <span aria-hidden>🦹</span>
                      {roundStolen}
                    </span>
                    <span className="stat-chip" title="Missions completed">
                      <span aria-hidden>🎯</span>
                      {player.objectivesDone ?? 0}
                    </span>
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="results-actions">
        {isMatchOver ? (
          <>
            {/* RÖVANŞ: İKİ oyuncunun da onayı gerekir. Onay vermeden önce
                buton "Rematch"; verdikten sonra rakip beklenir. Sunucu iki
                onayı da görünce odayı lobiye çeker. */}
            <Button onClick={onRematch} disabled={busy || rematchReady}>
              {rematchReady ? '✅ Rematch — waiting for rival' : 'Rematch'}
            </Button>
            <p className="muted next-ready-status" aria-live="polite">
              {rematchReady && rivalRematchReady
                ? 'Both ready — starting a new match…'
                : rematchReady
                  ? 'Waiting for your rival to accept…'
                  : rivalRematchReady
                    ? 'Your rival wants a rematch. Your turn!'
                    : 'Both players must accept to start a rematch.'}
            </p>
          </>
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
