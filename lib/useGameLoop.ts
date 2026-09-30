'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  ACTION_MS,
  BATTLE_MS,
  BUMP_SLOW_MS,
  BUMP_SPEED_MULTIPLIER,
  COIN_RESPAWN_MARGIN,
  COIN_RESPAWN_MS,
  COIN_TYPES,
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

/** Rastgele bir arena konumu üretir (kenar payı bırakarak). */
const randomCoinSpot = () => ({
  x: COIN_RESPAWN_MARGIN + Math.random() * (100 - COIN_RESPAWN_MARGIN * 2),
  y: COIN_RESPAWN_MARGIN + Math.random() * (100 - COIN_RESPAWN_MARGIN * 2),
})

/** Rastgele bir coin türü (diamond hariç — o yalnızca jackpot ile gelir). */
const randomCoinType = () => COIN_TYPES[Math.floor(Math.random() * COIN_TYPES.length)] ?? 'gold'

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
}

const keys = { up: false, down: false, left: false, right: false }

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
  // Rakip için yumuşatılmış (interpolasyonlu) konum. Broadcast hedefi ile
  // bu değer arasında her karede yumuşak geçiş yapılır.
  const remoteTarget = useRef<{ x: number; y: number } | null>(null)

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
    const { state, setState, token, publishMove, broadcast, call, syncChaos, advancePhase } = depsRef.current

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

    if (state.phase !== 'battle') return

    // Hareket.
    let dx = 0
    let dy = 0
    if (keys.up) dy -= 1
    if (keys.down) dy += 1
    if (keys.left) dx -= 1
    if (keys.right) dx += 1

    const me = state.players[0]
    if (!me) return

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy) || 1
      const slowed = (me.slowedUntil ?? 0) > now
      const speed = MOVE_SPEED * (slowed ? BUMP_SPEED_MULTIPLIER : 1)
      const targetX = me.x + (dx / length) * speed * dt
      const targetY = me.y + (dy / length) * speed * dt
      const next = resolveMove(me.x, me.y, targetX, targetY)
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 0 ? { ...player, x: next.x, y: next.y } : player,
        ),
      }))
      if (now - lastSend.current >= MOVE_SEND_MS) {
        lastSend.current = now
        publishMove(next.x, next.y)
      }
    }

    // Rakip yumuşatma (interpolasyon).
    //
    // Broadcast pozisyonları 60Hz'de gelir ama ağ jitter'ı yüzünden aralar
    // düzensizdir. Rakip konumunu her karede hedefe doğru `REMOTE_SMOOTHING`
    // oranında yaklaştırarak akıcı hale getiririz. Çok büyük farklar (ışınlanma,
    // yeniden bağlanma) anında atlanır ki rakip "kaymasın".
    const rivalTarget = state.players[1]
    if (rivalTarget) {
      const remote = remoteTarget.current
      if (!remote) {
        remoteTarget.current = { x: rivalTarget.x, y: rivalTarget.y }
      } else {
        const dist = Math.hypot(remote.x - rivalTarget.x, remote.y - rivalTarget.y)
        if (dist > REMOTE_SNAP_DISTANCE) {
          // Çok büyük fark: ışınlanma / yeniden bağlanma — anında hizala.
          remote.x = rivalTarget.x
          remote.y = rivalTarget.y
        } else if (dist > 0.05) {
          remote.x += (rivalTarget.x - remote.x) * REMOTE_SMOOTHING
          remote.y += (rivalTarget.y - remote.y) * REMOTE_SMOOTHING
        }
        const smoothX = remote.x
        const smoothY = remote.y
        if (Math.abs(smoothX - rivalTarget.x) > 0.01 || Math.abs(smoothY - rivalTarget.y) > 0.01) {
          setState((prev) => ({
            ...prev,
            players: prev.players.map((player, index) =>
              index === 1 ? { ...player, x: smoothX, y: smoothY } : player,
            ),
          }))
        }
      }
    }

    // Toplama.
    if (now - lastAction.current >= ACTION_MS) {
      lastAction.current = now
      const nearby = state.coins.filter(
        (coin) =>
          !coin.collectedBy &&
          Math.hypot(coin.x - me.x, coin.y - me.y) <= COLLECT_RADIUS,
      )
      if (nearby.length > 0) {
        const ids = new Set(nearby.map((coin) => coin.id))
        const gained = nearby.reduce(
          (sum, coin) => sum + getCoinValue(coin.type, state.chaosEvent?.id, me.objective),
          0,
        )
        playSound('collect')
        setState((prev) => ({
          ...prev,
          // Toplanan coinler `respawnAt` ile işaretlenir; süre dolunca
          // rastgele konum + rastgele renkle yeniden doğarlar.
          coins: prev.coins.map((coin) =>
            ids.has(coin.id)
              ? { ...coin, collectedBy: 'p1', respawnAt: now + COIN_RESPAWN_MS }
              : coin,
          ),
          players: prev.players.map((player, index) =>
            index === 0
              ? {
                  ...player,
                  coins: player.coins + nearby.length,
                  score: player.score + gained,
                  roundScore: (player.roundScore ?? 0) + gained,
                  collectedTypes: nearby.reduce<Partial<Record<Coin['type'], number>>>(
                    (counts, coin) => ({
                      ...counts,
                      [coin.type]: (counts[coin.type] ?? 0) + 1,
                    }),
                    { ...(player.collectedTypes ?? {}) },
                  ),
                }
              : player,
          ),
        }))
        broadcast('collect', { ids: [...ids], by: 'p1' })
        // Sunucu yazımı best-effort: tur sıfırlanırken yarışıp hata fırlatabilir.
        void call('duo_collect', { p_token: token, p_coin_id: [...ids][0] }).catch(() => undefined)
      }
    }

    // Çalma.
    const rival = state.players[1]
    if (
      rival &&
      now - lastSteal.current >= STEAL_COOLDOWN_MS &&
      Math.hypot(rival.x - me.x, rival.y - me.y) <= STEAL_RADIUS
    ) {
      lastSteal.current = now
      playSound('steal')
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player) => {
          if (player.id === 'p1') {
            return { ...player, stolen: player.stolen + 1, score: player.score + 10, roundScore: (player.roundScore ?? 0) + 10 }
          }
          if (player.id === 'p2') {
            return { ...player, coins: Math.max(0, player.coins - 1), slowedUntil: now + BUMP_SLOW_MS }
          }
          return player
        }),
      }))
      broadcast('steal', { by: 'p1' })
      void call('duo_steal', { p_token: token }).catch(() => undefined)
    }

    // Görev tamamlama + yeniden doğma (tek bir setState'te toplanır).
    setState((prev) => {
      let changed = false
      const nextCoins = prev.coins.map((coin) => {
        if (coin.collectedBy && coin.respawnAt && now >= coin.respawnAt) {
          changed = true
          const spot = randomCoinSpot()
          return {
            ...coin,
            x: spot.x,
            y: spot.y,
            type: randomCoinType(),
            collectedBy: undefined,
            respawnAt: undefined,
          }
        }
        return coin
      })

      const nextPlayers = prev.players.map((player) => {
        // Yalnızca yerel oyuncunun görevini biz yönetiriz; rakip kendi
        // tarafında yönetir ve sunucu otoritesidir.
        if (player.id !== 'p1') return player
        if (!objectiveSatisfied(player)) return player
        changed = true
        const done = (player.objectivesDone ?? 0) + 1
        // Görev tamamlandı: yerine rastgele yeni bir görev ver.
        return {
          ...player,
          objectivesDone: done,
          // Skor = tamamlanan görev sayısı.
          score: done,
          roundScore: done,
          objective: randomObjective(player.objective?.id),
          // Yeni görev için ilerleme sayaçlarını sıfırla.
          coins: 0,
          stolen: 0,
          collectedTypes: {},
          missionDone: false,
        }
      })

      if (!changed) return prev
      return { ...prev, coins: nextCoins, players: nextPlayers }
    })
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

  return { keys }
}

export { COUNTDOWN_MS, PHASE_TICK_MS }
