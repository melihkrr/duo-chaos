'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  ACTION_MS,
  BATTLE_MS,
  BUMP_SLOW_MS,
  BUMP_SPEED_MULTIPLIER,
  COIN_RESPAWN_MS,
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  MOVE_SEND_MS,
  MOVE_SPEED,
  PHASE_TICK_MS,
  REMOTE_SMOOTHING,
  REMOTE_SNAP_DISTANCE,
  STEAL_COOLDOWN_MS,
  STEAL_RADIUS,
  getCoinValue,
  randomObjective,
} from './config'
import { objectiveSatisfied } from './display'
import { resolveMove } from './movement'
import { playSound } from './sound'
import type { Coin, Player, State } from './types'

/** Rakip interpolasyonunun "oturduğu" eşik (arena %). Altındaysa yazmayız. */
const REMOTE_SETTLE = 0.25

/**
 * Görev tamamlandıktan sonra yeni görevin gelmesi için beklenen süre (ms).
 * Oyuncunun "3/3 tamamlandı" durumunu görebilmesi için kısa bir kutlama
 * penceresi bırakırız. Aksi halde görev, son coin toplanır toplanmaz anında
 * değişiyordu ("görevi yapıyorum yeni görev sonra geliyor" şikâyeti).
 */
const OBJECTIVE_COMPLETE_HOLD_MS = 1_200

/**
 * Bir görev tamamlandığında kümülatif skora eklenen bonus puan. Skor artık
 * "görev sayısı" değil, toplanan coin + çalınan + görev bonuslarının toplamıdır.
 */
const OBJECTIVE_BONUS = 25

/**
 * Bir broadcast konumunun "taze" sayıldığı süre (ms). Bu süreden eski bir
 * broadcast hedefi yok sayılır ve sunucu snapshot'ı otorite kabul edilir.
 */
const REMOTE_POS_TTL = 1_500

type LoopDeps = {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
  /** Oyuncunun sunucu token'ı (RPC kimlik doğrulaması). */
  token: string | null
  /** Yerel oyuncunun pozisyonunu yayınlar. */
  publishMove: (x: number, y: number) => void
  /** Toplama/çalma olayını yayınlar. */
  broadcast: (event: string, payload: unknown) => void
  /** Sunucu RPC'si. */
  call: (fn: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Chaos bilgisini senkronize eder. */
  syncChaos: (input: { id?: string; endsAt?: number }) => void
  /** Faz ilerletme (sunucu). */
  advancePhase: (from: State['phase']) => Promise<void>
  /**
   * Rakibin en son broadcast edilen HEDEF konumu. Realtime `move` olayı buraya
   * yazar; döngü her karede bu hedefe yumuşakça yaklaşır. Böylece 60Hz paket
   * başına render tetiklenmez ve hareket akıcı kalır.
   */
  remotePos: React.RefObject<Map<string, { x: number; y: number; at: number }>>
}

const keys = { up: false, down: false, left: false, right: false }

/**
 * Sanal joystick vektörü (-1..1). Klavye ile aynı anda kullanılabilir;
 * ikisi toplanır ve normalize edilir. `useGameLoop` bu nesneyi dışarı verir,
 * `VirtualJoystick` `onChange` ile buraya yazar.
 */
export type JoystickVector = { x: number; y: number }

/**
 * Ana oyun döngüsü: girdi → hareket → toplama/çalma → faz geçişi.
 * Client iyimser çalışır; skor/kazanan sunucudan doğrulanır.
 */
export const useGameLoop = (deps: LoopDeps) => {
  const depsRef = useRef(deps)

  // Ref'i render sırasında değil, commit sonrası senkronize et.
  useEffect(() => {
    depsRef.current = deps
  }, [deps])

  const lastSend = useRef(0)
  const lastAction = useRef(0)
  const lastSteal = useRef(0)
  const lastPhase = useRef<State['phase']>('home')
  const lastRound = useRef<number>(-1)
  // Rakip için yumuşatılmış (interpolasyonlu) konum. Broadcast hedefi ile
  // bu değer arasında her karede yumuşak geçiş yapılır.
  const remoteTarget = useRef<{ x: number; y: number } | null>(null)
  // Yerel oyuncunun ANLIK konumu. React render'ını beklemeden her karede
  // güncellenir; böylece `state` bir kare geride kalsa bile hareket akıcı kalır
  // ("donma + birden ilerleme" sorununun kökü buydu: döngü, commit edilmemiş
  // eski `state.players[0]`'dan hesapladığı için ilerleme kaybediyordu).
  const localPos = useRef<{ x: number; y: number } | null>(null)
  // Yerel oyuncunun EKRANA basılan konumu. `Battle` bu ref'i doğrudan DOM
  // transform'una yazar; böylece 60Hz hareket React render'ı TETİKLEMEZ.
  // Bu, "hareket donuyor / birden ilerliyor" sorununun asıl çözümüdür:
  // render döngüsü artık kare hızına bağlı değil.
  // NOT: Başlangıçta `null`. `Battle` bu değer `null` iken DOM'a YAZMAZ; aksi
  // halde ilk karede avatar (0,0) köşesine ışınlanıp sonra spawn'a zıplıyordu
  // ("ilk girdiğimizde garip hareket ediyoruz" şikâyeti). Değer, döngünün ilk
  // `step`'inde gerçek spawn konumundan tohumlanır.
  const livePos = useRef<{ x: number; y: number } | null>(null)
  // Rakibin ekrana basılan konumu. Aynı şekilde doğrudan DOM'a yazılır.
  const liveRivalPos = useRef<{ x: number; y: number } | null>(null)
  // Görev tamamlandığında yeni görevin verileceği zaman (epoch ms). 0 = bekleme
  // yok. Oyuncunun "tamamlandı" durumunu görmesi için kısa bir pencere bırakır.
  const objectiveHold = useRef(0)
  // Sanal joystick vektörü. `VirtualJoystick` `setJoystick` ile buraya yazar;
  // böylece her pointer hareketinde React render tetiklenmez (yalnızca RAF okur).
  const joystick = useRef<JoystickVector>({ x: 0, y: 0 })

  /**
   * Joystick vektörünü günceller. Ref'i doğrudan dışarı vermek yerine bir
   * setter sunarız; bu, `react-hooks/immutability` kuralına uyar ve çağıran
   * tarafın hook dönüşünü mutasyona uğratmasını engeller.
   */
  const setJoystick = useCallback((x: number, y: number) => {
    joystick.current.x = x
    joystick.current.y = y
  }, [])

  // Klavye girdisi.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (key === 'w' || key === 'arrowup') keys.up = true
      else if (key === 's' || key === 'arrowdown') keys.down = true
      else if (key === 'a' || key === 'arrowleft') keys.left = true
      else if (key === 'd' || key === 'arrowright') keys.right = true
      else return
      event.preventDefault()
    }
    const up = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (key === 'w' || key === 'arrowup') keys.up = false
      else if (key === 's' || key === 'arrowdown') keys.down = false
      else if (key === 'a' || key === 'arrowleft') keys.left = false
      else if (key === 'd' || key === 'arrowright') keys.right = false
    }
    const blur = () => {
      keys.up = keys.down = keys.left = keys.right = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const step = useCallback((now: number, dt: number) => {
    const { state, setState, token, publishMove, broadcast, call, syncChaos, advancePhase, remotePos } =
      depsRef.current

    // Faz geçişleri.
    if (state.phase === 'countdown' && state.countdownEndsAt > 0 && now >= state.countdownEndsAt) {
      playSound('start')
      setState((prev) => ({ ...prev, phase: 'battle', endsAt: now + BATTLE_MS }))
      // Sunucuya da bildir. `advancePhase` hata durumunda yeniden dener; böylece
      // saat farkından dolayı erken tetiklenip `not_ready` alsak bile sunucu
      // fazı eninde sonunda `battle`'a geçer.
      void advancePhase('countdown')
      return
    }
    if (state.phase === 'battle' && state.endsAt > 0 && now >= state.endsAt) {
      void advancePhase('battle')
      return
    }

    if (state.phase !== 'battle') {
      // Savaş dışındayken yerel konum ref'ini bırak; yeni turda `state`'ten
      // yeniden tohumlanır (oyuncu doğru başlangıç noktasına döner).
      localPos.current = null
      return
    }

    const me = state.players[0]
    if (!me) return

    // Yeni tur: konum ref'ini ve görev bekleme sayacını sıfırla.
    if (lastRound.current !== state.round) {
      lastRound.current = state.round
      localPos.current = { x: me.x, y: me.y }
      // Ekrana basılacak konumu da spawn'dan tohumla (ilk karede (0,0)
      // görünmesini engeller).
      livePos.current = { x: me.x, y: me.y }
      objectiveHold.current = 0
    }

    // --- Girdi: klavye + sanal joystick birleşir. ---
    let dx = 0
    let dy = 0
    if (keys.up) dy -= 1
    if (keys.down) dy += 1
    if (keys.left) dx -= 1
    if (keys.right) dx += 1
    dx += joystick.current.x
    dy += joystick.current.y

    // --- Hareket (yerel, iyimser). ---
    //
    // Konumu `state`'ten değil, `localPos` ref'inden okuruz. `state` yalnızca
    // React commit edildikten sonra güncellenir; döngü 60Hz çalıştığı için
    // aradaki karelerde eski konumdan hesaplamak ilerleme kaybettirir ve
    // "donma + birden ilerleme" yaratır. `localPos` her karede anında güncellenir.
    if (!localPos.current) localPos.current = { x: me.x, y: me.y }
    const fromX = localPos.current.x
    const fromY = localPos.current.y
    let nextX = fromX
    let nextY = fromY
    const moving = Math.hypot(dx, dy) > 0.01
    if (moving) {
      const length = Math.hypot(dx, dy) || 1
      const slowed = (me.slowedUntil ?? 0) > now
      const speed = MOVE_SPEED * (slowed ? BUMP_SPEED_MULTIPLIER : 1)
      const targetX = fromX + (dx / length) * speed * dt
      const targetY = fromY + (dy / length) * speed * dt
      const resolved = resolveMove(fromX, fromY, targetX, targetY)
      nextX = resolved.x
      nextY = resolved.y
    }
    // Ref'i hemen güncelle — bir sonraki kare bu değerden devam eder.
    localPos.current = { x: nextX, y: nextY }
    // Ekrana basılacak konumu da her karede güncelle. `Battle` bunu doğrudan
    // DOM'a yazar; React render'ı beklemez → akıcı hareket.
    livePos.current = { x: nextX, y: nextY }

    // --- Rakip interpolasyonu (yalnızca hedefe yaklaşırken yazarız). ---
    //
    // Hedef önceliği: taze broadcast konumu (`remotePos`) > sunucu snapshot'ı
    // (`state.players[1]`). Broadcast 60Hz geldiği için asıl akıcılık kaynağı
    // odur; snapshot yalnızca broadcast kesildiğinde (yeniden bağlanma) devreye
    // girer. Her iki durumda da state'e yalnızca interpolasyon sonucu yazılır.
    const rivalTarget = state.players[1]
    if (rivalTarget) {
      const broadcast = remotePos.current?.get('rival') ?? remotePos.current?.get('p2')
      const fresh = broadcast && now - broadcast.at < REMOTE_POS_TTL
      const goalX = fresh ? broadcast.x : rivalTarget.x
      const goalY = fresh ? broadcast.y : rivalTarget.y
      const remote = remoteTarget.current
      if (!remote) {
        remoteTarget.current = { x: goalX, y: goalY }
      } else {
        const dist = Math.hypot(remote.x - goalX, remote.y - goalY)
        if (dist > REMOTE_SNAP_DISTANCE) {
          // Çok büyük fark: ışınlanma / yeniden bağlanma — anında hizala.
          remote.x = goalX
          remote.y = goalY
        } else if (dist > REMOTE_SETTLE) {
          remote.x += (goalX - remote.x) * REMOTE_SMOOTHING
          remote.y += (goalY - remote.y) * REMOTE_SMOOTHING
        } else if (dist > 0) {
          // Hedefe çok yakın: otur.
          remote.x = goalX
          remote.y = goalY
        }
      }
      // Rakip konumunu da doğrudan DOM'a yazarız (state'e değil) — böylece
      // rakip hareketi de 60Hz render tetiklemez.
      const settled = remoteTarget.current
      if (settled) {
        liveRivalPos.current = { x: settled.x, y: settled.y }
      }
    }

    // --- Toplama (zaman kapılı). ---
    let collectedIds: number[] = []
    let gained = 0
    if (now - lastAction.current >= ACTION_MS) {
      lastAction.current = now
      const nearby = state.coins.filter(
        (coin) => !coin.collectedBy && Math.hypot(coin.x - nextX, coin.y - nextY) <= COLLECT_RADIUS,
      )
      if (nearby.length > 0) {
        collectedIds = nearby.map((coin) => coin.id)
        gained = nearby.reduce(
          (sum, coin) => sum + getCoinValue(coin.type, state.chaosEvent?.id, me.objective),
          0,
        )
        playSound('collect')
      }
    }
    const collectedSet = new Set(collectedIds)

    // --- Çalma (zaman kapılı). ---
    let stealing = false
    if (
      rivalTarget &&
      now - lastSteal.current >= STEAL_COOLDOWN_MS &&
      Math.hypot(rivalTarget.x - nextX, rivalTarget.y - nextY) <= STEAL_RADIUS
    ) {
      lastSteal.current = now
      stealing = true
      playSound('steal')
    }

    // --- Tek `setState`: hareket + rakip + toplama + çalma + yeniden doğma. ---
    // Kare başına tek render hedefi; bu, hareketin akıcı kalmasını sağlar.
    setState((prev) => {
      let changed = false

      // Coinler: toplananları işaretle, süresi dolanları AYNI konum ve AYNI
      // renkte canlandır. Renk yuvaya (id'ye) bağlıdır; yalnızca yeni turda
      // yeniden dağıtılır. Böylece coinler "kendi kendine renk değiştirmez".
      const nextCoins = prev.coins.map((coin) => {
        if (collectedSet.has(coin.id)) {
          changed = true
          return { ...coin, collectedBy: 'p1' as const, respawnAt: now + COIN_RESPAWN_MS }
        }
        if (coin.collectedBy && coin.respawnAt && now >= coin.respawnAt) {
          changed = true
          // Konum VE renk sabit kalır — yalnızca "toplanmış" işareti kalkar.
          return { ...coin, collectedBy: undefined, respawnAt: undefined }
        }
        return coin
      })

      const nextPlayers = prev.players.map((player, index) => {
        if (index === 0) {
          let next = player
          // NOT: Yerel oyuncunun x/y'sini burada state'e YAZMAYIZ. Konum her
          // karede `livePos` ref'i üzerinden doğrudan DOM'a uygulanır; state'e
          // yazmak 60Hz render tetikler ve hareketi bozar. State'teki x/y
          // yalnızca tur başında (spawn) doğru olması yeterlidir.
          if (collectedIds.length > 0) {
            changed = true
            next = {
              ...next,
              coins: next.coins + collectedIds.length,
              score: next.score + gained,
              roundScore: (next.roundScore ?? 0) + gained,
              collectedTypes: prev.coins
                .filter((coin) => collectedSet.has(coin.id))
                .reduce<Partial<Record<Coin['type'], number>>>(
                  (counts, coin) => ({ ...counts, [coin.type]: (counts[coin.type] ?? 0) + 1 }),
                  { ...(next.collectedTypes ?? {}) },
                ),
            }
          }
          if (stealing) {
            changed = true
            next = {
              ...next,
              stolen: next.stolen + 1,
              score: next.score + 10,
              roundScore: (next.roundScore ?? 0) + 10,
            }
          }
          // Görev tamamlandıysa: tamamlanma sayacını artır, kısa bir
          // "tamamlandı" penceresi bırak, SONRA yeni görev ver. Aksi halde
          // görev, son coin toplanır toplanmaz anında değişiyor ve oyuncu
          // tamamlandığını göremiyordu.
          //
          // ÖNEMLİ: `score` KÜMÜLATİF'tir (toplanan coin + çalınan + görev
          // bonusu). Burada `score`'u görev sayısına EŞİTLEMEYİZ; aksi halde
          // oyuncunun topladığı puan silinir ("görev tamamlanınca 1 skor
          // kazanıyor" şikâyeti tam olarak buydu). Görev tamamlama yalnızca
          // `objectivesDone` sayacını ve bir bonusu ekler.
          // ÖNEMLİ: `!next.missionDone` guard'ı şart. Görev tamamlandıktan
          // sonra `collectedTypes` yeni görev verilene kadar hedefi KARŞILAMAYA
          // DEVAM EDER; guard olmadan bu dal her karede tekrar tetiklenir,
          // `objectivesDone` sonsuz artar ve `else if` (yeni görev atama) dalı
          // HİÇ çalışmaz → "sayaç artmadı / yeni görev gelmedi" hatası.
          if (!next.missionDone && objectiveSatisfied(next)) {
            changed = true
            const done = (next.objectivesDone ?? 0) + 1
            // Tamamlanma anını işaretle; yeni görev `holdUntil` sonrası gelir.
            objectiveHold.current = now + OBJECTIVE_COMPLETE_HOLD_MS
            next = {
              ...next,
              objectivesDone: done,
              // Görev başına bonus puan (kümülatif skora eklenir).
              score: next.score + OBJECTIVE_BONUS,
              roundScore: (next.roundScore ?? 0) + OBJECTIVE_BONUS,
              // Görev ŞİMDİLİK korunur (tamamlanmış haliyle gösterilir).
              missionDone: true,
            }
          } else if (
            next.missionDone &&
            objectiveHold.current > 0 &&
            now >= objectiveHold.current
          ) {
            // Bekleme penceresi doldu: yeni rastgele görev ver ve sayaçları sıfırla.
            changed = true
            objectiveHold.current = 0
            next = {
              ...next,
              objective: randomObjective(next.objective?.id),
              coins: 0,
              stolen: 0,
              collectedTypes: {},
              missionDone: false,
            }
          }
          return next
        }

        if (index === 1) {
          let next = player
          // NOT: Rakibin x/y'sini de state'e YAZMAYIZ; konum `liveRivalPos`
          // üzerinden doğrudan DOM'a uygulanır. State'teki x/y yalnızca tur
          // başında (spawn) doğru olması yeterlidir.
          if (stealing) {
            changed = true
            next = { ...next, coins: Math.max(0, next.coins - 1), slowedUntil: now + BUMP_SLOW_MS }
          }
          return next
        }
        return player
      })

      if (!changed) return prev
      return { ...prev, coins: nextCoins, players: nextPlayers }
    })

    // Ağ yayınları (state dışı yan etkiler).
    if (moving && now - lastSend.current >= MOVE_SEND_MS) {
      lastSend.current = now
      publishMove(nextX, nextY)
    }
    if (collectedIds.length > 0) {
      broadcast('collect', { ids: collectedIds, by: 'p1' })
      void call('duo_collect', { p_token: token, p_coin_id: collectedIds[0] }).catch(() => undefined)
    }
    if (stealing) {
      broadcast('steal', { by: 'p1' })
      void call('duo_steal', { p_token: token }).catch(() => undefined)
    }
  }, [])

  // Ana döngü yalnızca aktif fazlarda (countdown/battle) çalışır.
  // home/lobby/results'ta RAF tamamen durur — boşuna 60fps render yok.
  const phase = deps.state.phase
  const loopActive = phase === 'countdown' || phase === 'battle'

  useEffect(() => {
    if (!loopActive) return
    let raf = 0
    let last = performance.now()
    const tick = (perfNow: number) => {
      const dt = Math.min(0.05, (perfNow - last) / 1000)
      last = perfNow
      // `step` içindeki faz karşılaştırmaları (countdownEndsAt / endsAt) mutlak
      // epoch-ms değerleridir; bu yüzden `performance.now()` yerine `Date.now()`
      // geçiririz. `dt` ise monotonik `performance.now()` farkından gelir.
      step(Date.now(), dt)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [step, loopActive])

  // Faz değişiminde ses.
  useEffect(() => {
    if (deps.state.phase !== lastPhase.current) {
      if (deps.state.phase === 'countdown') playSound('countdown')
      lastPhase.current = deps.state.phase
    }
  }, [deps.state.phase])

  return { keys, setJoystick, livePos, liveRivalPos }
}

export { COUNTDOWN_MS, PHASE_TICK_MS }
