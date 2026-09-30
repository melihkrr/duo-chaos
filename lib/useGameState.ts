'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BATTLE_MS,
  COUNTDOWN_MS,
  MATCH_ROUNDS,
  generateObjectivePair,
  spawnCoins,
  spawnFor,
} from './config'
import type { Coin, Phase, Player, State } from './types'

export const blankPlayer = (id: 'p1' | 'p2'): Player => ({
  id,
  name: id === 'p1' ? 'You' : 'Rival',
  x: spawnFor(id).x,
  y: spawnFor(id).y,
  coins: 0,
  stolen: 0,
  collectedTypes: {},
  score: 0,
  roundScore: 0,
  totalScore: 0,
  objective: null,
  rematch: false,
  scoutCharges: 2,
  scoutUsedAt: 0,
  revealedHint: null,
  emote: null,
  trail: 'spark',
})

export const initialState = (): State => ({
  phase: 'home',
  players: [blankPlayer('p1'), blankPlayer('p2')],
  coins: spawnCoins(),
  endsAt: 0,
  countdownEndsAt: 0,
  round: 1,
  roundScores: { p1: 0, p2: 0 },
  matchScores: { p1: 0, p2: 0 },
  connection: 'idle',
})

export type GameStateApi = {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
  /** Fazı ve ilgili zamanlayıcıları ayarlar. */
  setPhase: (phase: Phase, options?: { endsAt?: number; countdownEndsAt?: number }) => void
  /** Yeni round için oyuncuları/coinleri sıfırlar. */
  resetRound: (round: number, seed?: string) => void
  /** Maçı sıfırlar. */
  resetMatch: () => void
  /** Belirli bir oyuncuyu günceller. */
  updatePlayer: (id: string, patch: Partial<Player> | ((p: Player) => Partial<Player>)) => void
  /** Coin listesini değiştirir. */
  setCoins: (coins: Coin[]) => void
  /** Yerel oyuncunun pozisyonunu günceller. */
  moveLocal: (x: number, y: number) => void
}

/**
 * Oyun durumunun tek sahibi. Tüm alt hook'lar buradan beslenir.
 */
export const useGameState = (): GameStateApi => {
  const [state, setState] = useState<State>(initialState)
  const stateRef = useRef(state)

  // Ref'i render sırasında değil, commit sonrası senkronize et.
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const setPhase = useCallback<GameStateApi['setPhase']>((phase, options) => {
    setState((prev) => ({
      ...prev,
      phase,
      endsAt: options?.endsAt ?? prev.endsAt,
      countdownEndsAt: options?.countdownEndsAt ?? prev.countdownEndsAt,
    }))
  }, [])

  const resetRound = useCallback<GameStateApi['resetRound']>((round, seed) => {
    const [first, second] = generateObjectivePair(seed ?? `round-${round}`)
    setState((prev) => ({
      ...prev,
      round,
      coins: spawnCoins(),
      endsAt: 0,
      countdownEndsAt: 0,
      chaosEvent: undefined,
      chaosEventEndsAt: undefined,
      winner: undefined,
      players: prev.players.map((player, index) => ({
        ...blankPlayer(player.id as 'p1' | 'p2'),
        name: player.name,
        xp: player.xp,
        level: player.level,
        title: player.title,
        trail: player.trail,
        objective: index === 0 ? first : second,
      })),
    }))
  }, [])

  const resetMatch = useCallback(() => {
    setState((prev) => ({
      ...prev,
      round: 1,
      roundScores: { p1: 0, p2: 0 },
      matchScores: { p1: 0, p2: 0 },
      winner: undefined,
      chaosEvent: undefined,
      chaosEventEndsAt: undefined,
      players: prev.players.map((player) => ({
        ...blankPlayer(player.id as 'p1' | 'p2'),
        name: player.name,
        xp: player.xp,
        level: player.level,
        title: player.title,
        trail: player.trail,
      })),
    }))
  }, [])

  const updatePlayer = useCallback<GameStateApi['updatePlayer']>((id, patch) => {
    setState((prev) => ({
      ...prev,
      players: prev.players.map((player) =>
        player.id === id
          ? { ...player, ...(typeof patch === 'function' ? patch(player) : patch) }
          : player,
      ),
    }))
  }, [])

  const setCoins = useCallback((coins: Coin[]) => {
    setState((prev) => ({ ...prev, coins }))
  }, [])

  const moveLocal = useCallback((x: number, y: number) => {
    setState((prev) => ({
      ...prev,
      players: prev.players.map((player, index) =>
        index === 0 ? { ...player, x, y } : player,
      ),
    }))
  }, [])

  return { state, setState, setPhase, resetRound, resetMatch, updatePlayer, setCoins, moveLocal }
}

export { BATTLE_MS, COUNTDOWN_MS, MATCH_ROUNDS }
