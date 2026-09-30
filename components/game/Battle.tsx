'use client'

import { useEffect, useRef, useState } from 'react'
import { ChaosBanner } from './ChaosBanner'
import { CosmeticsPicker } from './CosmeticsPicker'
import { ScoutPanel } from './ScoutPanel'
import { VirtualJoystick } from './VirtualJoystick'
import { Button } from '../ui/Button'
import { ARENA, OBSTACLES, trailById } from '../../lib/config'
import { missionLabel, objectiveOf, progressOf, targetOf } from '../../lib/display'
import type { ChaosApi } from '../../lib/useChaos'
import type { CosmeticsApi } from '../../lib/useCosmetics'
import type { ScoutApi } from '../../lib/useScout'
import type { State } from '../../lib/types'

type Props = {
  state: State
  chaos: ChaosApi
  scout: ScoutApi
  cosmetics: CosmeticsApi
  level: number
  secondsLeft: number
  onJoystick: (dx: number, dy: number) => void
  /**
   * Yerel oyuncunun ANLIK konumu (arena %). Oyun döngüsü her karede buraya
   * yazar; `Battle` bunu doğrudan DOM'a uygular. Böylece 60Hz hareket React
   * render'ı tetiklemez ve hareket akıcı kalır. `null` iken (döngü henüz
   * tohumlamadı) DOM'a YAZILMAZ — ilk karede (0,0) ışınlanmasını engeller.
   */
  livePos: React.RefObject<{ x: number; y: number } | null>
  /**
   * Rakibin ANLIK konumu (arena %). Aynı şekilde doğrudan DOM'a uygulanır;
   * rakip hareketi de React render'ı tetiklemez.
   */
  liveRivalPos: React.RefObject<{ x: number; y: number } | null>
  /**
   * Son görev tamamlanma anı (epoch ms). Değer değiştiğinde küçük bir kutlama
   * animasyonu (konfeti + "+25") oynatılır. Yeni görev zaten ANINDA atanmıştır.
   */
  celebrateRef: React.RefObject<number>
  /** Rakip oyundan ayrıldı mı? True iken oyun duraklar ve bir uyarı gösterilir. */
  rivalLeft: boolean
  /** "Bekle" — rakibin geri dönmesini bekler (duraklatılmış halde). */
  onWaitForRival: () => void
  /** "Odadan ayrıl" — oyuncu odayı terk eder. */
  onLeaveRoom: () => void
  onEmote: () => void
}

const coinClass = (type: string) => `coin coin-${type}`

export function Battle({
  state,
  chaos,
  scout,
  cosmetics,
  level,
  secondsLeft,
  onJoystick,
  livePos,
  liveRivalPos,
  celebrateRef,
  rivalLeft,
  onWaitForRival,
  onLeaveRoom,
  onEmote,
}: Props) {
  const [now, setNow] = useState(0)
  // Kutlama katmanının görünürlüğü. `celebrateRef` her tamamlanmada artan bir
  // zaman damgası taşır; değer değiştiğinde kutlamayı kısa süreliğine açarız.
  const [celebrate, setCelebrate] = useState(0)
  // Yerel avatarın DOM düğümü. Konumu her karede doğrudan buna yazarız.
  const meRef = useRef<HTMLDivElement | null>(null)
  // Rakip avatarın DOM düğümü. Aynı şekilde doğrudan yazarız.
  const rivalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [])

  // Görev tamamlanma sinyalini izle. `celebrateRef` her tamamlanmada yeni bir
  // zaman damgası alır; değer değiştiğinde kutlamayı ~1.4 sn gösteririz.
  useEffect(() => {
    let raf = 0
    let last = celebrateRef.current
    const watch = () => {
      const value = celebrateRef.current
      if (value !== last) {
        last = value
        setCelebrate(value)
        window.setTimeout(() => {
          setCelebrate((current) => (current === value ? 0 : current))
        }, 1400)
      }
      raf = window.requestAnimationFrame(watch)
    }
    raf = window.requestAnimationFrame(watch)
    return () => window.cancelAnimationFrame(raf)
  }, [celebrateRef])

  // Yerel oyuncunun konumunu doğrudan DOM'a uygula (React render'ı olmadan).
  // Bu, hareketin 60Hz'de akıcı kalmasını sağlar; `state` yalnızca skor/coin
  // gibi anlamlı değişimlerde güncellenir.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const meNode = meRef.current
      const mePos = livePos.current
      // `null` iken yazmayız: döngü henüz spawn konumunu tohumlamadı. Aksi
      // halde ilk karede avatar (0,0) köşesine ışınlanıp sonra spawn'a
      // zıplıyordu ("ilk girdiğimizde garip hareket" şikâyeti).
      if (meNode && mePos) {
        meNode.style.left = `${mePos.x}%`
        meNode.style.top = `${mePos.y}%`
      }
      const rivalNode = rivalRef.current
      const rivalPos = liveRivalPos.current
      if (rivalNode && rivalPos) {
        rivalNode.style.left = `${rivalPos.x}%`
        rivalNode.style.top = `${rivalPos.y}%`
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [livePos, liveRivalPos])

  const me = state.players[0]
  const rival = state.players[1]
  const myObjective = objectiveOf(me)
  const rivalObjective = objectiveOf(rival)
  const myTrail = trailById(me?.trail)

  // Görev ilerlemesi: `progressOf` HAM sayıyı döner (örn. 3 toplamadan 1 tane
  // toplandıysa 1). Bunu doğrudan yüzde olarak kullanmak hataydı: 1 coin
  // toplayınca çubuk %100 doluyordu ("3 istiyor ama 1'de tam dolu görünüyor").
  // Doğrusu: ilerleme / hedef oranı. Böylece 1/3 → %33 dolar.
  const ratio = (value: number, target?: number) => {
    const goal = target && target > 0 ? target : 1
    return Math.max(0, Math.min(1, value / goal))
  }
  const myTarget = targetOf(myObjective)
  const rivalTarget = targetOf(rivalObjective)
  const myProgress = me ? ratio(progressOf(me), myTarget) : 0
  const rivalProgress = rival ? ratio(progressOf(rival), rivalTarget) : 0
  // Görev sayacı: "1/3" biçiminde gösterilir.
  const myCount = me ? progressOf(me) : 0
  const rivalCount = rival ? progressOf(rival) : 0

  // Geri sayım: `countdown` fazında kalan süreyi 3-2-1 olarak gösteririz.
  // `countdownEndsAt` sunucu saatinden yerel saate çevrilmiş bir deadline'dır.
  const countdownLeft = state.countdownEndsAt - now
  const countdownStep = Math.ceil(countdownLeft / 1000)
  const showCountdown =
    state.phase === 'countdown' && countdownLeft > 0 && countdownStep >= 1 && countdownStep <= 3

  return (
    <section className="battle-wrap">
      <header className="hud">
        <div className="hud-player">
          <div className="hud-name">
            <span className="hud-badge me" aria-hidden>
              🐰
            </span>
            <strong>{me?.name ?? 'You'}</strong>
            {/* Skor = kümülatif puan (coin + çalma + görev bonusları). */}
            <span className="hud-score" title="Total score">
              {me?.score ?? 0}
            </span>
          </div>
          <small>
            {missionLabel(myObjective)}
            <span className="hud-missions" title="Mission progress">
              {' '}
              · {myCount}/{myTarget}
            </span>
          </small>
          <div className="hud-bar">
            <span style={{ width: `${Math.round(myProgress * 100)}%` }} />
          </div>
        </div>
        <div className="hud-center">
          <span className="hud-round">Round {state.round}</span>
          <span className="hud-clock">{Math.max(0, secondsLeft)}s</span>
        </div>
        <div className="hud-player rival">
          <div className="hud-name">
            <strong>{rival?.name ?? 'Rival'}</strong>
            {/* Skor = kümülatif puan. */}
            <span className="hud-score" title="Total score">
              {rival?.score ?? 0}
            </span>
            <span className="hud-badge rival" aria-hidden>
              🐻
            </span>
          </div>
          <small>
            {missionLabel(rivalObjective)}
            <span className="hud-missions" title="Mission progress">
              {' '}
              · {rivalCount}/{rivalTarget}
            </span>
          </small>
          <div className="hud-bar">
            <span style={{ width: `${Math.round(rivalProgress * 100)}%` }} />
          </div>
        </div>
      </header>

      <ChaosBanner chaos={chaos} />

      <div className="arena">
        {showCountdown && (
          <div className="countdown-overlay" role="status" aria-live="polite">
            <span key={countdownStep} className="countdown-num">
              {countdownStep}
            </span>
            <span className="countdown-hint">Get ready!</span>
          </div>
        )}

        {celebrate > 0 && (
          <div className="celebrate-overlay" role="status" aria-live="polite">
            <span className="celebrate-badge">Mission complete!</span>
            <span className="celebrate-bonus">+25</span>
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={`confetti confetti-${i % 5}`} aria-hidden />
            ))}
          </div>
        )}

        {rivalLeft && (
          <div className="rival-left-overlay" role="alertdialog" aria-live="assertive">
            <div className="rival-left-card">
              <span className="rival-left-emoji" aria-hidden>
                🐻💨
              </span>
              <h2>Your rival left the game</h2>
              <p>
                {rival?.name ?? 'Your rival'} disconnected. The match is paused — you can wait for
                them to come back, or leave the room.
              </p>
              <div className="rival-left-actions">
                <Button onClick={onWaitForRival}>⏳ Wait for rival</Button>
                <Button variant="ghost" onClick={onLeaveRoom}>
                  🚪 Leave room
                </Button>
              </div>
            </div>
          </div>
        )}

        {OBSTACLES.map((obstacle, index) => (
          <div
            key={index}
            className={`obstacle ${index === 0 ? 'one' : 'two'}`}
            style={{
              left: `${obstacle.cx}%`,
              top: `${obstacle.cy}%`,
              width: `${obstacle.w}%`,
              height: `${obstacle.h}%`,
              transform: `translate(-50%, -50%) rotate(${obstacle.angleDeg}deg)`,
            }}
          />
        ))}

        {state.coins
          .filter((coin) => !coin.collectedBy)
          .map((coin) => (
            <span
              key={coin.id}
              className={coinClass(coin.type)}
              style={{ left: `${coin.x}%`, top: `${coin.y}%` }}
            />
          ))}

        {state.players.map((player, index) => {
          const trail = trailById(player.trail)
          const isMe = index === 0
          return (
            <div
              key={player.id}
              ref={isMe ? meRef : rivalRef}
              className={['avatar', isMe ? 'me' : 'rival', (player.slowedUntil ?? 0) > now ? 'slowed' : ''].join(' ')}
              style={{ left: `${player.x}%`, top: `${player.y}%` }}
            >
              {trail.id !== 'none' && (
                <span className="avatar-trail" style={{ background: trail.color }} aria-hidden />
              )}
              <span className="avatar-body">
                <span className="avatar-face" aria-hidden>
                  {isMe ? '🐰' : '🐻'}
                </span>
              </span>
              <span className="avatar-name">{isMe ? 'You' : player.name}</span>
              {player.emote && <span className="avatar-emote">{player.emote}</span>}
            </div>
          )
        })}

        {cosmetics.activeGlyph && (
          <span className="emote-pop" aria-hidden>
            {cosmetics.activeGlyph}
          </span>
        )}
      </div>

      <footer className="battle-foot">
        <VirtualJoystick onChange={onJoystick} />
        <div className="battle-side">
          <ScoutPanel scout={scout} disabled={state.phase !== 'battle'} />
          <Button variant="ghost" onClick={onEmote} className="emote-btn">
            {cosmetics.activeGlyph ?? '😀'} Emote
          </Button>
          <CosmeticsPicker cosmetics={cosmetics} level={level} />
        </div>
      </footer>

      <span className="arena-bounds" data-minx={ARENA.minX} data-maxy={ARENA.maxY} hidden />
      <span className="trail-color" data-color={myTrail.color} hidden />
    </section>
  )
}
