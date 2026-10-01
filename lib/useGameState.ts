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

/**
 * Boş oyuncu. `spawnId` verilirse spawn konumu ONDAN alınır; aksi halde
 * `id`'den. Bu, "yerel slot" (id) ile "sunucu slotu" (spawnId) ayrımını
 * mümkün kılar: yerel oyuncu her zaman `id='p1'` (slot 0) olsa da GERÇEK
 * spawn'ı sunucu slotuna göre belirlenir (bkz. aynalama notu, `config.ts`).
 */
export const blankPlayer = (id: 'p1' | 'p2', spawnId: string = id): Player => ({
  id,
  name: id === 'p1' ? 'You' : 'Rival',
  x: spawnFor(spawnId).x,
  y: spawnFor(spawnId).y,
  coins: 0,
  stolen: 0,
  collectedTypes: {},
  score: 0,
  roundScore: 0,
  totalScore: 0,
  objectivesDone: 0,
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
 *
 * `serverSlot`: yerel oyuncunun SUNUCUDAKİ slotu (`'p1'`/`'p2'`). Yerel state
 * her zaman slot 0 = "ben", slot 1 = "rakip" düzenini kullanır; ancak GERÇEK
 * spawn konumları sunucu slotuna göre belirlenir. Yerel oyuncu sunucuda `p2`
 * ise gerçek spawn'ı sağdadır (x=82); render sırasında aynalanarak ekranda
 * SOLDA gösterilir (bkz. `config.ts` aynalama notu). Bu ayrım olmadan iki
 * oyuncu da kendini solda görüp rakibi "soldaki başlama noktasına ışınlanıyor"
 * gibi görünüyordu.
 */
export const useGameState = (serverSlot: 'p1' | 'p2' = 'p1'): GameStateApi => {
  const [state, setState] = useState<State>(initialState)
  const stateRef = useRef(state)
  // Sunucu slotunu ref'te tutarız; `resetRound`/`resetMatch` kimlikleri kararlı
  // kalır (bağımlılığa eklemeyiz) ama her zaman GÜNCEL slotu okurlar.
  const serverSlotRef = useRef<'p1' | 'p2'>(serverSlot)
  useEffect(() => {
    serverSlotRef.current = serverSlot
  }, [serverSlot])

  /**
   * SUNUCU SLOTU DEĞİŞİNCE SPAWN'LARI YENİDEN TOHUMLA.
   *
   * KÖK SORUN ("biri solda biri sağda başlamış gibi gösteriyor, soldaki
   * hareket ettiği an sağa ışınlanıyor"):
   *
   * `joinRoom`/`restore` akışında `room.connect(code, slot, ...)` çağrılır ve
   * HEMEN ardından `resetMatch()` çalışır. Ancak `connect` içindeki
   * `setPlayerId(slot)` ASENKRON bir React state güncellemesidir; `resetMatch`
   * çalıştığı anda `serverSlotRef.current` hâlâ ESKİ değerdir (varsayılan
   * `'p1'`). Bu yüzden misafir (`p2`) oyuncunun spawn'ı yanlışlıkla `p1`
   * konumundan (x=18) tohumlanıyordu. `mirrored` ise `room.playerId === 'p2'`
   * olduğu için `true` oluyor; render `18`'i aynalayıp oyuncuyu SAĞA koyuyor,
   * `livePos` ise gerçek `18`'den tohumlandığı için ilk hareket karesinde
   * oyuncu "ışınlanmış" gibi zıplıyordu.
   *
   * ÇÖZÜM: Slot gerçekten değiştiğinde (ve maç henüz başlamamışken) spawn
   * konumlarını yeniden tohumlarız. Böylece yerel oyuncunun GERÇEK spawn'ı her
   * zaman sunucu slotuyla eşleşir; aynalama tutarlı çalışır ve ışınlanma olmaz.
   */
  const seededSlotRef = useRef<'p1' | 'p2'>(serverSlot)
  useEffect(() => {
    if (seededSlotRef.current === serverSlot) return
    seededSlotRef.current = serverSlot
    serverSlotRef.current = serverSlot
    setState((prev) => {
      // Yalnızca maç ÖNCESİ fazlarda (home/lobby) yeniden tohumla. Aktif oyun
      // sırasında spawn'ı değiştirmek oyuncuyu ışınlar; orada dokunmayız.
      if (prev.phase !== 'home' && prev.phase !== 'lobby') return prev
      return {
        ...prev,
        players: prev.players.map((player, index) => {
          const spawnId = index === 0 ? serverSlot : serverSlot === 'p1' ? 'p2' : 'p1'
          const spawn = spawnFor(spawnId)
          return { ...player, x: spawn.x, y: spawn.y }
        }),
      }
    })
  }, [serverSlot])

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
    const roundSeed = seed ?? `round-${round}`
    const [first, second] = generateObjectivePair(roundSeed)
    setState((prev) => ({
      ...prev,
      round,
      // Coin düzeni tur seed'ine bağlıdır: iki istemci aynı düzeni görür.
      coins: spawnCoins(roundSeed),
      endsAt: 0,
      countdownEndsAt: 0,
      chaosEvent: undefined,
      chaosEventEndsAt: undefined,
      winner: undefined,
      players: prev.players.map((player, index) => {
        // Yerel slot 0 = "ben" → GERÇEK spawn'ı sunucu slotundan alır.
        // Yerel slot 1 = "rakip" → karşı slotun spawn'ı.
        const slot = serverSlotRef.current
        const spawnId = index === 0 ? slot : slot === 'p1' ? 'p2' : 'p1'
        return {
          ...blankPlayer(player.id as 'p1' | 'p2', spawnId),
          name: player.name,
          xp: player.xp,
          level: player.level,
          title: player.title,
          trail: player.trail,
          objective: index === 0 ? first : second,
        }
      }),
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
      players: prev.players.map((player, index) => {
        const slot = serverSlotRef.current
        const spawnId = index === 0 ? slot : slot === 'p1' ? 'p2' : 'p1'
        return {
          ...blankPlayer(player.id as 'p1' | 'p2', spawnId),
          name: player.name,
          xp: player.xp,
          level: player.level,
          title: player.title,
          trail: player.trail,
        }
      }),
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
