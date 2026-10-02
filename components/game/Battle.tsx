'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChaosBanner } from './ChaosBanner'
import { CosmeticsPicker } from './CosmeticsPicker'
import { VirtualJoystick } from './VirtualJoystick'
import { Button } from '../ui/Button'
import { ARENA, OBSTACLES, avatarGlyph, emoteById, isRiskyCoin, trailById } from '../../lib/config'
import { SCORE_POP_MS } from '../../lib/useGameLoop'
import { objectiveOf, progressOf, targetOf } from '../../lib/display'
import type { ChaosApi } from '../../lib/useChaos'
import type { CosmeticsApi } from '../../lib/useCosmetics'
import type { State } from '../../lib/types'
import { localizedObjectiveLabel, useI18n } from '../../lib/i18n'

type Props = {
  state: State
  chaos: ChaosApi
  cosmetics: CosmeticsApi
  level: number
  secondsLeft: number
  onJoystick: (dx: number, dy: number) => void
  /**
   * Yerel oyuncunun ANLIK konumu (arena %). Oyun döngüsü her karede buraya
   * yazar; `Battle` bunu doğrudan DOM'a uygular. Böylece 60Hz hareket React
   * render'ı tetiklemez ve hareket akıcı kalır. `null` iken (döngü henüz
   * tohumlamadı) DOM'a YAZILMAZ — ilk karede (0,0) ışınlanmasını engeller
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
  /**
   * Elmas (jackpot) toplama bilgisi: `{ x, y, at }`. Yerel oyuncu elması
   * topladığında doldurulur; `Battle` elmasın üstünde uçan "+50" rozetini
   * gösterir. `null` = gösterilecek ödül yok.
   */
  diamondPopRef: React.RefObject<{ x: number; y: number; at: number } | null>
  /**
   * COMBO serisi: `{ count, at }`. Yerel oyuncu ardışık topladıkça `count`
   * artar; `Battle` HUD'da "x3 COMBO" rozetini gösterir. Yalnızca görseldir.
   */
  comboRef: React.RefObject<{ count: number; at: number }>
  /**
   * Uçan puan rozetleri: her toplamada coinin konumunda beliren "+5/+15/+25"
   * etiketleri. `Battle` bunları arena'ya basar ve süresi dolunca temizler.
   */
  scorePopRef: React.RefObject<Array<{ id: number; x: number; y: number; value: number; at: number }>>
  /**
   * Ekran sarsıntısı sinyali: çarpışma anında `{ at, kind }` yazılır.
   * `Battle` değer değiştiğinde arena'ya kısa bir shake animasyonu uygular.
   */
  shakeRef: React.RefObject<{ at: number; kind: 'bump' } | null>
  /** Rakip oyundan ayrıldı mı? True iken oyun duraklar ve bir uyarı gösterilir. */
  rivalLeft: boolean
  /**
   * Bağlantı durumu. `'recovering'` iken küçük, rahatsız etmeyen bir
   * "Yeniden bağlanılıyor…" rozeti gösterilir. Oyun DURMAZ; `useRoom` arka
   * planda kendini onarır ve durum otomatik olarak `'live'`e döner.
   */
  connection: 'idle' | 'connecting' | 'live' | 'recovering' | 'error'
  /** "Odadan ayrıl" — oyuncu odayı terk eder. */
  onLeaveRoom: () => void
}

const coinClass = (type: string, risky: boolean) =>
  `coin coin-${type}${risky ? ' coin-risky' : ''}`

/** Görev tamamlanma kutlamasının ekranda kalma süresi (ms). */
const CELEBRATE_MS = 1_400
/** Elmas "+50" rozetinin ekranda kalma süresi (ms). */
const DIAMOND_POP_MS = 1_100
/** COMBO rozetinin, son toplamadan sonra görünür kaldığı süre (ms). */
const COMBO_WINDOW_MS = 2_200
/** Ekran sarsıntısı animasyonunun süresi (ms). */
const SHAKE_MS = 320

/**
 * HUD skorunu yumuşakça hedefe "sayarak" gösterir. Sunucu skoru sıçradığında
 * (ör. +50 elmas) sayı aniden değişmek yerine kısa bir animasyonla artar; bu,
 * kazanılan puanı çok daha tatmin edici kılar. Fark büyükse hız ölçeklenir.
 */
function AnimatedScore({ value }: { value: number }) {
  const [display, setDisplay] = useState(value)
  const displayRef = useRef(value)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const current = displayRef.current
      const diff = value - current
      if (Math.abs(diff) < 1) {
        if (current !== value) {
          displayRef.current = value
          setDisplay(value)
        }
      } else {
        // Fark büyükse daha hızlı yaklaş (en az 1, en fazla farkın %25'i).
        const step = Math.max(1, Math.ceil(Math.abs(diff) * 0.25)) * Math.sign(diff)
        const next = current + step
        displayRef.current = next
        setDisplay(next)
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [value])

  return <>{display}</>
}

export function Battle({
  state,
  chaos,
  cosmetics,
  level,
  secondsLeft,
  onJoystick,
  livePos,
  liveRivalPos,
  celebrateRef,
  diamondPopRef,
  comboRef,
  scorePopRef,
  shakeRef,
  rivalLeft,
  connection,
  onLeaveRoom,
}: Props) {
  const { language, t } = useI18n()
  const [now, setNow] = useState(0)
  // Tam ekran modu. `true` iken arena tüm ekranı kaplar; HUD üstte kalır,
  // joystick dokunulan yerde yarı şeffaf görünür ve diğer kontroller gizlenir.
  //
  // İki kaynak birleşir:
  //   - `nativeFs`: tarayıcının gerçek Fullscreen API'si (masaüstü/Android).
  //   - `cssFs`: CSS tabanlı yedek mod. iOS Safari `requestFullscreen`'i
  //     desteklemez (yalnızca <video> için); bu yüzden mobilde tam ekran
  //     "çalışmıyordu". CSS modunda `.is-fullscreen` sınıfı uygulanır ve
  //     arena viewport'u kaplar — API olmadan da tam ekran deneyimi verir.
  const [nativeFs, setNativeFs] = useState(false)
  const [cssFs, setCssFs] = useState(false)
  const fullscreen = nativeFs || cssFs
  // Kutlama katmanının görünürlüğü. `celebrateRef` her tamamlanmada artan bir
  // zaman damgası taşır; değer değiştiğinde kutlamayı kısa süreliğine açarız.
  const [celebrate, setCelebrate] = useState(0)
  // Elmas (jackpot) "+50" rozeti. `diamondPopRef` yerel oyuncu elması
  // topladığında dolar; değer değiştiğinde rozeti kısa süreliğine gösteririz.
  const [diamondPop, setDiamondPop] = useState<{ x: number; y: number; at: number } | null>(null)
  // COMBO rozeti: `{ count, at }`. Seri penceresi dolduğunda (comboRef.at
  // bayatladığında) rozeti gizleriz; aksi halde HUD'da kalıcı görünürdü.
  const [combo, setCombo] = useState(0)
  // Uçan puan rozetleri. `scorePopRef` her toplamada büyür; süresi dolanları
  // temizleriz. Ekranda aynı anda en fazla birkaç rozet tutulur.
  const [scorePops, setScorePops] = useState<Array<{ id: number; x: number; y: number; value: number; at: number }>>([])
  // Ekran sarsıntısı: `shakeRef` değiştiğinde kısa süreliğine bir CSS sınıfı
  // uygularız (arena'ya "vuruş" hissi verir).
  const [shake, setShake] = useState<{ at: number; kind: 'bump' } | null>(null)
  // Tam ekrana alınacak sarmalayıcı düğüm (`.battle-wrap`).
  const wrapRef = useRef<HTMLElement | null>(null)
  // Arena düğümü. Avatar konumlarını yüzde yerine PİKSEL `transform` ile
  // yazmak için boyutunu okuruz (mobilde left/top layout'u yerine GPU).
  const arenaRef = useRef<HTMLDivElement | null>(null)
  // Yerel avatarın DOM düğümü. Konumu her karede doğrudan buna yazarız.
  const meRef = useRef<HTMLDivElement | null>(null)
  // Rakip avatarın DOM düğümü. Aynı şekilde doğrudan yazarız.
  const rivalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [])

  // Tam ekran modunu tarayıcının Fullscreen API'siyle senkronla. Kullanıcı
  // Esc ile çıkarsa `fullscreenchange` yakalanır ve yerel durum güncellenir.
  useEffect(() => {
    const onChange = () => {
      setNativeFs(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const node = wrapRef.current
    if (!node) return
    // Zaten (native veya CSS) tam ekrandaysak çık.
    if (fullscreen) {
      if (document.fullscreenElement) void document.exitFullscreen()
      setCssFs(false)
      setNativeFs(false)
      return
    }
    // Fullscreen API yoksa (iOS Safari) doğrudan CSS yedeğine geç.
    const request = node.requestFullscreen
    if (typeof request !== 'function') {
      setCssFs(true)
      return
    }
    // API var: dene. Reddedilirse (iframe izni yok, kullanıcı jesti yok vb.)
    // CSS yedeğine düş — böylece mobilde de tam ekran "çalışır".
    try {
      const result = request.call(node) as Promise<void> | undefined
      if (result && typeof result.catch === 'function') {
        void result.catch(() => setCssFs(true))
      }
    } catch {
      setCssFs(true)
    }
  }

  // TEK RAF DÖNGÜSÜ: Önceden 6 ayrı `requestAnimationFrame` döngüsü vardı
  // (celebrate, diamondPop, combo, scorePops, shake, position). Her biri kendi
  // karesinde `setState` çağırdığından mobilde her karede 6 kez React
  // uzlaştırması (reconciliation) tetikleniyor ve hareket "laglı" görünüyordu.
  // Artık hepsi TEK bir döngüde, yalnızca GERÇEKTEN değişen değerler için
  // `setState` çağrılarak işlenir. Konum ise hiç render tetiklemeden doğrudan
  // DOM'a (`transform: translate3d`) yazılır.
  //
  // SAĞLAMLIK (celebrate): Gizleme kararı `celebrateRef` zaman damgasına göre
  // verilir; damga `CELEBRATE_MS`'ten eskiyse katman kapanır. Böylece hiçbir
  // zaman aşımı sızıntısı kutlamayı kalıcı yapamaz ("Mission complete! yazısı
  // gitmedi" hatası).
  useEffect(() => {
    let raf = 0
    // Arena piksel boyutu. Her karede `getBoundingClientRect()` çağırmak
    // mobilde layout thrash yaratır; bu yüzden yalnızca boyut değişince
    // (resize/fullscreen) yeniden ölçeriz.
    let arenaW = 0
    let arenaH = 0
    const measure = () => {
      const arena = arenaRef.current
      if (!arena) return
      const rect = arena.getBoundingClientRect()
      arenaW = rect.width
      arenaH = rect.height
    }
    measure()
    window.addEventListener('resize', measure)

    // Watcher'ların son gördüğü değerler (gereksiz `setState`'i önlemek için).
    let lastDiamondAt = 0
    let lastShakeAt = 0

    const tick = () => {
      const now = Date.now()

      // --- Konum (render YOK; doğrudan DOM) ---
      // Boyut henüz ölçülmediyse (ilk kare) bir kez ölç.
      if (arenaW === 0 || arenaH === 0) measure()
      const meNode = meRef.current
      const mePos = livePos.current
      // `null` iken yazmayız: döngü henüz spawn konumunu tohumlamadı. Aksi
      // halde ilk karede avatar (0,0) köşesine ışınlanıp sonra spawn'a
      // zıplıyordu ("ilk girdiğimizde garip hareket" şikâyeti).
      if (meNode && mePos && arenaW > 0 && arenaH > 0) {
        const px = (mePos.x / 100) * arenaW
        const py = (mePos.y / 100) * arenaH
        meNode.style.transform = `translate3d(${px}px, ${py}px, 0)`
      }
      const rivalNode = rivalRef.current
      const rivalPos = liveRivalPos.current
      if (rivalNode && rivalPos && arenaW > 0 && arenaH > 0) {
        const px = (rivalPos.x / 100) * arenaW
        const py = (rivalPos.y / 100) * arenaH
        rivalNode.style.transform = `translate3d(${px}px, ${py}px, 0)`
      }

      // --- Kutlama katmanı ---
      const celebrateAt = celebrateRef.current
      const celebrateFresh = celebrateAt > 0 && now - celebrateAt < CELEBRATE_MS
      setCelebrate((current) =>
        current === celebrateAt && !celebrateFresh ? 0 : celebrateFresh ? celebrateAt : current,
      )

      // --- Elmas "+50" rozeti ---
      const pop = diamondPopRef.current
      if (pop && pop.at !== lastDiamondAt) {
        lastDiamondAt = pop.at
        setDiamondPop(pop)
      }
      // Süresi dolan rozeti gizle (zaman aşımı yerine döngü içinde karar).
      setDiamondPop((current) => (current && now - current.at >= DIAMOND_POP_MS ? null : current))

      // --- COMBO rozeti ---
      const comboValue = comboRef.current
      const comboFresh = now - comboValue.at <= COMBO_WINDOW_MS
      setCombo((current) => {
        const next = comboFresh && comboValue.count >= 2 ? comboValue.count : 0
        return current === next ? current : next
      })

      // --- Uçan puan rozetleri ---
      const list = scorePopRef.current
      const cutoff = now - SCORE_POP_MS
      const alive = list.filter((item) => item.at >= cutoff)
      setScorePops((prev) => {
        // Yalnızca gerçekten değiştiyse yeni referans döndür (gereksiz render yok).
        if (prev.length === alive.length && prev.every((item, index) => item.id === alive[index]?.id)) {
          return prev
        }
        return alive
      })

      // --- Ekran sarsıntısı ---
      const shakeValue = shakeRef.current
      if (shakeValue && shakeValue.at !== lastShakeAt) {
        lastShakeAt = shakeValue.at
        setShake(shakeValue)
      }
      setShake((current) => (current && now - current.at >= SHAKE_MS ? null : current))

      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [celebrateRef, diamondPopRef, comboRef, scorePopRef, shakeRef, livePos, liveRivalPos])

  // İLK KONUM TOHUMU: Avatar düğümleri ilk kez DOM'a girdiğinde konumlarını
  // bir kez (paint'ten ÖNCE) yazarız. Böylece avatar bir kare bile (0,0)
  // köşesinde görünmez. Sonraki tüm güncellemeleri RAF döngüsü yapar; React
  // inline `transform` vermediği için döngünün yazdığı değer EZİLMEZ.
  useLayoutEffect(() => {
    const arena = arenaRef.current
    if (!arena) return
    const rect = arena.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const seed = (node: HTMLDivElement | null, pos: { x: number; y: number } | null | undefined) => {
      if (!node || !pos) return
      const px = (pos.x / 100) * rect.width
      const py = (pos.y / 100) * rect.height
      node.style.transform = `translate3d(${px}px, ${py}px, 0)`
    }
    seed(meRef.current, livePos.current ?? { x: state.players[0]?.x ?? 0, y: state.players[0]?.y ?? 0 })
    seed(rivalRef.current, liveRivalPos.current ?? { x: state.players[1]?.x ?? 0, y: state.players[1]?.y ?? 0 })
  }, [livePos, liveRivalPos, state.players])

  // YEREL STATE SIRASI: index 0 = "ben", index 1 = "rakip" (iki istemcide de).
  const me = state.players[0]
  const rival = state.players[1]
  // Yerel oyuncu maçı kazandı mı? Rakip ayrıldığında popup'ta "You win"
  // göstermek için kullanılır. Yerel state'te "ben" her zaman `'p1'`dir.
  const meWon = state.winner === 'p1'
  const myObjective = objectiveOf(me)
  const rivalObjective = objectiveOf(rival)
  // NOT: Sunucu artık HER İKİ oyuncunun görevini de açıkça döndürür
  // (bkz. 0026_reveal_all_objectives.sql). Böylece iki istemci de birbirinin
  // gerçek görevini ve ilerlemesini görür; sahte/uydurma görev yoktur.
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

  // HUD TARAF EŞLEŞMESİ: Yerel oyuncunun arenadaki GERÇEK tarafı sunucu
  // slotuna göre belirlenir (p1 → x=18 SOL, p2 → x=82 SAĞ). Kullanıcı
  // beklentisi: "soldaysam panelim solda, sağdaysam sağda olsun". Bu yüzden
  // yerel oyuncu sağda doğduysa HUD'un oyuncu panellerini aynalarız
  // (`hud-mirrored`), böylece "ben" paneli sağda, rakip paneli solda görünür.
  const meOnLeft = (me?.x ?? 0) < 50

  return (
    <section
      ref={wrapRef}
      className={['battle-wrap', fullscreen ? 'is-fullscreen' : ''].join(' ')}
    >
      <header className={['hud', meOnLeft ? '' : 'hud-mirrored'].filter(Boolean).join(' ')}>
        <div className="hud-player">
          <div className="hud-name">
            <span className="hud-badge me" aria-hidden>
              {avatarGlyph(cosmetics.avatar, 'rabbit')}
            </span>
            <strong>{me?.name === 'Bot' ? t('Bot') : me?.name ?? t('You')}</strong>
            {/* Skor = kümülatif puan (coin + çalma + görev bonusları). */}
            <span className="hud-score" title={t('Total score')}>
              <AnimatedScore value={me?.score ?? 0} />
            </span>
          </div>
          <small>
            {localizedObjectiveLabel(myObjective, language)}
            <span className="hud-missions" title={t('Mission progress')}>
              {' '}
              · {myCount}/{myTarget}
            </span>
          </small>
          <div className="hud-bar">
            <span style={{ width: `${Math.round(myProgress * 100)}%` }} />
          </div>
        </div>
        <div className="hud-center">
          <span className="hud-round">{t('Round {round}', { round: state.round })}</span>
          <span className="hud-clock">{Math.max(0, secondsLeft)}s</span>
          <button
            type="button"
            className="fs-toggle"
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            title={fullscreen ? t('Exit fullscreen') : t('Fullscreen')}
          >
            {fullscreen ? t('⤡ Exit') : t('⛶ Fullscreen')}
          </button>
        </div>
        <div className="hud-player rival">
          <div className="hud-name">
            <strong>{rival?.name === 'Bot' ? t('Bot') : rival?.name ?? t('Rival')}</strong>
            {/* Skor = kümülatif puan. */}
            <span className="hud-score" title={t('Total score')}>
              <AnimatedScore value={rival?.score ?? 0} />
            </span>
            <span className="hud-badge rival" aria-hidden>
              {avatarGlyph(rival?.avatar, 'bear')}
            </span>
          </div>
          <small>
            {localizedObjectiveLabel(rivalObjective, language)}
            <span className="hud-missions" title={t('Mission progress')}>
              {' '}
              · {rivalCount}/{rivalTarget}
            </span>
          </small>
          <div className="hud-bar">
            <span style={{ width: `${Math.round(rivalProgress * 100)}%` }} />
          </div>
        </div>
      </header>

      <div
        ref={arenaRef}
        className={[
          'arena',
          shake ? `shake-${shake.kind}` : '',
          chaos.event ? `arena-chaos-${chaos.event.id}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Chaos banner: arena'nın üstünde mutlak konumlu overlay. Normal
            akışta olmadığı için görünüp kaybolduğunda arena'yı itmez. */}
        <ChaosBanner chaos={chaos} />
        {combo >= 2 && (
          <div className="combo-badge" role="status" aria-live="polite">
            <span className="combo-x">x{combo}</span>
            <span className="combo-label">{t('COMBO')}</span>
          </div>
        )}

        {showCountdown && (
          <div className="countdown-overlay" role="status" aria-live="polite">
            <span key={countdownStep} className="countdown-num">
              {countdownStep}
            </span>
            <span className="countdown-hint">{t('Get ready!')}</span>
          </div>
        )}

        {celebrate > 0 && (
          <div className="celebrate-overlay" role="status" aria-live="polite">
            <span className="celebrate-badge">{t('Mission complete!')}</span>
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
                {meWon ? '🏆' : state.winner ? '🎈' : '🐻💨'}
              </span>
              <h2>{meWon ? t('You win!') : state.winner ? t('Next time') : t('Your rival left the game')}</h2>
              <p>
                {meWon
                  ? t('{rival} left the match — you win. You can stay here and wait for a rematch, or leave the room.', { rival: rival?.name ?? t('Rival') })
                  : state.winner
                    ? t('{rival} left the match. Better luck next time — you can stay for a rematch, or leave the room.', { rival: rival?.name ?? t('Your rival') })
                    : t('{rival} disconnected. The match is paused — you can wait for them to come back, or leave the room.', { rival: rival?.name ?? t('Your rival') })}
              </p>
              <div className="rival-left-actions">
                <Button variant="ghost" onClick={onLeaveRoom}>
                  {t('🚪 Leave room')}
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
          .filter((coin) => !coin.collectedBy && !coin.pendingCollect)
          .map((coin) => (
            <span
              key={coin.id}
              className={coinClass(coin.type, isRiskyCoin(coin.id))}
              style={{ left: `${coin.x}%`, top: `${coin.y}%` }}
            />
          ))}

        {/* Elmas (jackpot) "+50" rozeti: yerel oyuncu elması topladığında
            elmasın son konumunda kısa süreliğine uçar. */}
        {diamondPop && (
          <span
            className="diamond-pop"
            style={{ left: `${diamondPop.x}%`, top: `${diamondPop.y}%` }}
            aria-hidden
          >
            +50
          </span>
        )}

        {/* Uçan puan rozetleri: her toplanan coin için "+5/+15/+25" değeri
            coinin konumunda kısa süreliğine yükselir. */}
        {scorePops.map((pop) => (
          <span
            key={pop.id}
            className="score-pop"
            style={{ left: `${pop.x}%`, top: `${pop.y}%` }}
            aria-hidden
          >
            +{pop.value}
          </span>
        ))}

        {state.players.map((player, index) => {
          const isMe = index === 0
          // Yerel oyuncunun izi, oyuncunun SEÇTİĞİ kozmetikten gelir
          // (`cosmetics.trail`). `state.players[0].trail` yalnızca tur başında
          // tohumlanır ve seçim değişince güncellenmez; bu yüzden iz
          // "seçiyorum ama görünmüyor" oluyordu. Rakip için ise yayınlanan
          // `player.trail` kullanılır.
          const trail = trailById(isMe ? cosmetics.trail : player.trail)
          return (
            <div
              key={player.id}
              ref={isMe ? meRef : rivalRef}
              className={['avatar', isMe ? 'me' : 'rival', (player.slowedUntil ?? 0) > now ? 'slowed' : ''].join(' ')}
              // KONUM BURADA VERİLMEZ. Konum, RAF döngüsünde doğrudan DOM'a
              // `transform: translate3d()` ile yazılır (mobilde left/top
              // layout'undan çok daha akıcı). Inline `transform` verilseydi,
              // React her render'da (skor/coin değişimi) döngünün yazdığı
              // piksel transform'unu yüzde değeriyle EZER ve avatar bir kare
              // geriye zıplardı. İlk boyamadaki konum `useLayoutEffect` ile
              // (aşağıda) bir kez tohumlanır.
              data-avatar={isMe ? 'me' : 'rival'}
            >
              {trail.id !== 'none' && (
                <span className="avatar-trail" style={{ background: trail.color }} aria-hidden />
              )}
              <span className="avatar-body">
                <span className="avatar-face" aria-hidden>
                  {avatarGlyph(isMe ? cosmetics.avatar : player.avatar, isMe ? 'rabbit' : 'bear')}
                </span>
              </span>
              <span className="avatar-name">{isMe ? t('You') : player.name}</span>
              {/*
                RAKİP EMOTE ETİKETİ.
                KÖK SORUN ("emote atmadım ama 'wave' yazısı ekranda kalıyor"):
                Burada `player.emote` gösteriliyordu; bu alan SEÇİLİ (kalıcı)
                emote tercihidir ve varsayılanı `'wave'`'tir. Dolayısıyla hiç
                emote atılmasa bile oyuncunun üstünde kalıcı olarak "wave"
                yazısı asılı kalıyordu. Ayrıca ham id (`wave`) gösteriliyordu,
                animasyon glifi (👋) değil.
                ÇÖZÜM: Etiket yalnızca RAKİP için ve yalnızca geçici bir uzak
                emote aktifken gösterilir; içeriği de gliftir. Yerel oyuncunun
                kendi emote'u zaten `cosmetics.activeGlyph` ile (aşağıda)
                gösterilir; bu yüzden burada tekrar edilmez.
              */}
              {!isMe && player.emote && (
                <span className="avatar-emote" aria-hidden>
                  {emoteById(player.emote)?.glyph ?? ''}
                </span>
              )}
            </div>
          )
        })}

        {cosmetics.activeGlyph && (
          <span className="emote-pop" aria-hidden>
            {cosmetics.activeGlyph}
          </span>
        )}

        {/* BAĞLANTI ROZETİ (rahatsız etmeyen). Yalnızca kanal yeniden
            bağlanırken görünür; oyunu DURDURMAZ ve hata gibi görünmez.
            Oyuncunun sayfayı elle yenilemesi gerekmez. */}
        {connection === 'recovering' && (
          <span className="conn-badge" role="status" aria-live="polite">
            <span className="conn-dot" aria-hidden />
            {t('Reconnecting…')}
          </span>
        )}

        {/* Gizli joystick arena'nın dokunulan yerinde belirir; HUD ve arena
            dışındaki kontroller bu giriş katmanından etkilenmez. */}
        <VirtualJoystick onChange={onJoystick} />
      </div>

      {/* Düzen:
          - Masaüstü: kozmetik (emote + trail) paneli SOLDA.
          - Mobil: panel altta.
          - Tam ekran: panel gizlenir; joystick dokunulan yerde görünür. */}
      <footer className="battle-foot">
        <div className="battle-side">
          <CosmeticsPicker cosmetics={cosmetics} level={level} />
        </div>
      </footer>

      <span className="arena-bounds" data-minx={ARENA.minX} data-maxy={ARENA.maxY} hidden />
      <span className="trail-color" data-color={myTrail.color} hidden />
    </section>
  )
}
