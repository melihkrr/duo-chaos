'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  ACTION_MS,
  BATTLE_MS,
  BUMP_SLOW_MS,
  BUMP_SPEED_MULTIPLIER,
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  MOVE_SEND_MS,
  MOVE_SPEED,
  PHASE_TICK_MS,
  STEAL_COOLDOWN_MS,
  STEAL_RADIUS,
  getCoinValue,
} from './config'
import { resolveMove } from './movement'
import { playSound } from './sound'
import type { Coin, Player, State } from './types'

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
      void call('duo_advance_phase', { p_token: token })
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
          coins: prev.coins.map((coin) =>
            ids.has(coin.id) ? { ...coin, collectedBy: 'p1' } : coin,
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
        void call('duo_collect', { p_token: token, p_coin_id: [...ids][0] })
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
      void call('duo_steal', { p_token: token })
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
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      step(now, dt)
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
