'use client'

import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { avatarGlyph } from '../../lib/config'
import { resultScoreForPlayer } from '../../lib/results'
import type { State } from '../../lib/types'
import { useI18n } from '../../lib/i18n'

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
}: Props) {
  const { t } = useI18n()
  const isMatchOver = state.phase === 'matchover'
  const winner = state.winner
  const meWon = winner === 'p1'

  return (
    <Panel
      title={isMatchOver ? t('Match over') : t('Round {round} results', { round: state.round })}
      subtitle={
        isMatchOver
          ? winner
            ? meWon
              ? t('You win the match!')
              : t('Your rival takes the match.')
            : t('Match complete')
          : t('Next round starting soon')
      }
      className="results"
    >
      {isMatchOver && winner && (
        <div className="results-celebrate" aria-hidden>
          <span>{meWon ? '🏆' : '🎈'}</span>
          <strong>{meWon ? t('Victory!') : t('Good game!')}</strong>
        </div>
      )}

      <div className="score-list">
        {state.players.map((player, index) => {
          // TUR TOPLAMI (SUNUCU OTORİTESİ): `roundCoins` sunucunun tur boyunca
          // biriktirdiği GERÇEK toplamdır ve HER İKİ istemcide de AYNIDIR.
          // `player.coins` görev tamamlanmasında sıfırlandığı için tur sonu
          // istatistikleri için kullanılmaz; aksi halde iki istemci farklı değer
          // gösterir (çelişkili sonuç ekranı).
          const roundCoins = player.roundCoins ?? player.coins ?? 0
          // Yalnızca PUAN gösterilir. Görev/round/match/XP kaldırıldı: puan
          // zaten oyunun tek ölçüsü, XP ise kişisel bir ilerleme verisi.
          //
          // ÖNEMLİ (MAÇ SONU — ÇELİŞKİLİ SKOR DÜZELTMESİ): Maç bittiğinde
          // (`matchover`) TUR puanı değil, MAÇ TOPLAMI gösterilir.
          //
          // OTORİTE KAYNAĞI `state.matchScores`'tur: sunucu `duo_tick` tur
          // bitişinde `match_scores = { p1: total_score, p2: total_score }`
          // üretir ve bu harita İKİ istemcide de AYNIDIR. Buna karşılık
          // `player.totalScore` istemci tarafında bayat kalabilir (snapshot
          // birleştirmesi yerel değeri koruyordu) ve iki istemcide FARKLI
          // değerler gösterip "değerler birbirini tutmuyor" hatasına yol
          // açıyordu. Bu yüzden ÖNCE `matchScores`'u, sonra `totalScore`'u
          // deneriz.
          const score = resultScoreForPlayer(
            state.phase,
            player,
            state.roundScores,
            state.matchScores,
          )
          const isWinner = winner === player.id
          return (
            <div key={player.id} className={['score-row', isWinner ? 'winner' : ''].join(' ')}>
              <div className="score-id">
                <span className={['score-avatar', isWinner ? 'crowned' : ''].filter(Boolean).join(' ')} aria-hidden>
                  {avatarGlyph(player.avatar, index === 0 ? 'rabbit' : 'bear')}
                  {isWinner ? <span className="score-crown">👑</span> : null}
                </span>
                <div>
                  <strong>{player.name}</strong>
                  <small className="muted">{index === 0 ? t('You') : t('Rival')}</small>
                </div>
              </div>
              <div className="score-values">
                <span className="score-big">
                  <small>{t('Score')}</small>
                  {score}
                </span>
                {/* Tur içi performans kırılımı: toplanan coin ve tamamlanan
                    görev. Maç sonunda tur istatistikleri sıfırlandığı için
                    yalnızca tur sonuçlarında gösterilir. */}
                {!isMatchOver && (
                  <span className="score-stats" aria-label={t('Round stats')}>
                    <span className="stat-chip" title={t('Coins collected')}>
                      <span aria-hidden>🪙</span>
                      {roundCoins}
                    </span>
                    <span className="stat-chip" title={t('Missions completed')}>
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
              {rematchReady ? t('✅ Rematch — waiting for rival') : t('Rematch')}
            </Button>
            <p className="muted next-ready-status" aria-live="polite">
              {rematchReady && rivalRematchReady
                ? t('Both ready — starting a new match…')
                : rematchReady
                  ? t('Waiting for your rival to accept…')
                  : rivalRematchReady
                    ? t('Your rival wants a rematch. Your turn!')
                    : t('Both players must accept to start a rematch.')}
            </p>
          </>
        ) : (
          <>
            {/* Tur, İKİ oyuncunun da onayıyla başlar. Onay vermeden önce
                buton "Ready for next round"; verdikten sonra rakip beklenir. */}
            <Button onClick={onApproveNextRound} disabled={busy || nextReady}>
              {nextReady ? t('✅ Ready — waiting for rival') : t('Ready for next round')}
            </Button>
            <p className="muted next-ready-status" aria-live="polite">
              {nextReady && rivalNextReady
                ? t('Both ready — starting…')
                : nextReady
                  ? t('Waiting for your rival to accept…')
                  : rivalNextReady
                    ? t('Your rival is ready. Your turn!')
                    : t('Both players must accept to start the next round.')}
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}
