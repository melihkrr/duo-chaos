'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BATTLE_MS, COUNTDOWN_MS, MATCH_ROUNDS, POLL_MS } from './config'
import { playSound, unlockAudio } from './sound'
import { useChaos } from './useChaos'
import { useCosmetics } from './useCosmetics'
import { useGameLoop } from './useGameLoop'
import { useGameState } from './useGameState'
import { useProgress } from './useProgress'
import { useRoom, readToken, saveToken } from './useRoom'
import { useScout } from './useScout'
import { useToast } from './useToast'
import type { Coin, EmoteId, Phase, Player, State } from './types'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const makeCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('')

const mapPlayerId = (rawId: string, meId: string): string => {
  if (rawId === meId) return 'p1'
  if (rawId === 'p1' || rawId === 'p2') return rawId === 'p1' ? 'p2' : 'p1'
  return rawId === 'p2' ? 'p1' : 'p2'
}

/** `duo_public_state` RPC'sinin döndürdüğü anlık görüntü. */
type PublicSnapshot = {
  phase?: Phase
  round?: number
  endsAt?: number
  countdownEndsAt?: number
  winner?: string
  chaos?: { id?: string; endsAt?: number }
  players?: Array<Partial<Player> & { id?: string }>
  coins?: Coin[]
}

/**
 * DUO CHAOS'un tüm parçalarını birleştiren orkestratör.
 * Sayfa bileşeni sadece bunu tüketir.
 */
export const useDuoChaos = () => {
  const game = useGameState()
  const room = useRoom()
  const progress = useProgress()
  const chaos = useChaos()
  const scout = useScout(room.code, room.playerId, room.token)
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const remotePos = useRef<Map<string, { x: number; y: number; at: number }>>(new Map())

  const { state, setState, setPhase, resetRound, resetMatch, updatePlayer } = game

  // Saat tiki (geri sayım / süre göstergesi).
  // Yalnızca aktif fazlarda çalışır; home/lobby/results'ta gereksiz render yok.
  useEffect(() => {
    if (state.phase !== 'countdown' && state.phase !== 'battle') return
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [state.phase])

  const cosmetics = useCosmetics(
    { emote: progress.progress.emote, trail: progress.progress.trail },
    (input) => void progress.setCosmetics(input),
    (id) => room.broadcast('emote', { by: room.playerId, id }),
  )

  const publishMove = useCallback(
    (x: number, y: number) => {
      room.broadcast('move', { by: room.playerId, x, y })
      void room.call('duo_move', { p_token: room.token ?? room.playerId, p_x: x, p_y: y })
    },
    [room],
  )

  const advancePhase = useCallback(
    async (from: Phase) => {
      const data = await room.call<{ phase?: Phase; winner?: string; roundScores?: Record<string, number>; matchScores?: Record<string, number> }>(
        'duo_advance_phase',
        { p_token: room.token ?? room.playerId },
      )
      if (data?.phase) {
        setState((prev) => ({
          ...prev,
          phase: data.phase as Phase,
          winner: data.winner ?? prev.winner,
          roundScores: data.roundScores ?? prev.roundScores,
          matchScores: data.matchScores ?? prev.matchScores,
        }))
      } else {
        // Offline: yerel geçiş.
        setState((prev) => {
          if (from === 'battle') {
            const roundScores = { p1: prev.players[0]?.roundScore ?? 0, p2: prev.players[1]?.roundScore ?? 0 }
            const matchScores = {
              p1: (prev.matchScores?.p1 ?? 0) + roundScores.p1,
              p2: (prev.matchScores?.p2 ?? 0) + roundScores.p2,
            }
            const isLast = prev.round >= MATCH_ROUNDS
            const winner = matchScores.p1 === matchScores.p2 ? undefined : matchScores.p1 > matchScores.p2 ? 'p1' : 'p2'
            return {
              ...prev,
              phase: isLast ? 'matchover' : 'results',
              roundScores,
              matchScores,
              winner: isLast ? winner : undefined,
            }
          }
          return prev
        })
      }
    },
    [room, setState],
  )

  useGameLoop({
    state,
    setState,
    token: room.token,
    publishMove,
    broadcast: room.broadcast,
    call: room.call,
    syncChaos: chaos.sync,
    advancePhase,
  })

  // Realtime olaylarını bağla.
  useEffect(() => {
    const offMove = room.on('move', (payload) => {
      const data = payload as { by?: string; x?: number; y?: number }
      if (!data || data.by === room.playerId) return
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return
      remotePos.current.set(data.by ?? 'rival', { x: data.x, y: data.y, at: Date.now() })
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, x: data.x as number, y: data.y as number } : player,
        ),
      }))
    })

    const offCollect = room.on('collect', (payload) => {
      const data = payload as { ids?: number[]; by?: string }
      if (!data || data.by === room.playerId || !data.ids) return
      const ids = new Set(data.ids)
      setState((prev) => ({
        ...prev,
        coins: prev.coins.map((coin) => (ids.has(coin.id) ? { ...coin, collectedBy: 'p2' } : coin)),
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, coins: player.coins + ids.size } : player,
        ),
      }))
    })

    const offSteal = room.on('steal', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      playSound('bump')
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 0
            ? { ...player, coins: Math.max(0, player.coins - 1), slowedUntil: Date.now() + 400 }
            : { ...player, stolen: player.stolen + 1 },
        ),
      }))
    })

    const offEmote = room.on('emote', (payload) => {
      const data = payload as { by?: string; id?: EmoteId }
      if (!data || data.by === room.playerId || !data.id) return
      cosmetics.showRemoteEmote(data.id)
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, emote: data.id ?? null } : player,
        ),
      }))
    })

    // Rakip adını değiştirdiğinde anında yansıt.
    const offName = room.on('name', (payload) => {
      const data = payload as { by?: string; name?: string }
      if (!data || data.by === room.playerId || !data.name) return
      const nextName = data.name.trim().slice(0, 16)
      if (!nextName) return
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, name: nextName } : player,
        ),
      }))
    })

    return () => {
      offMove()
      offCollect()
      offSteal()
      offEmote()
      offName()
    }
  }, [cosmetics, room, setState])

  // Sunucu snapshot'ını periyodik çek.
  //
  // Maliyet optimizasyonu: yalnızca aktif oyun fazlarında (countdown/battle)
  // ve sekme görünürken çalışır. Lobby/home/results fazlarında hiç istek
  // atılmaz — bu fazlardaki değişimler zaten realtime broadcast ile gelir.
  // Aralık `POLL_MS` haritasından seçilir (battle'da 1s, countdown'da 0.5s).
  useEffect(() => {
    if (!room.code) return
    const active = state.phase === 'countdown' || state.phase === 'battle'
    if (!active) return
    let cancelled = false
    const pull = async () => {
      let data: PublicSnapshot | null = null
      try {
        data = await room.call<PublicSnapshot>('duo_public_state', { p_token: room.token ?? room.playerId })
      } catch {
        // Oda silinmiş olabilir (rakip çıktı / leave). Sessizce dur; UI'yi bozma.
        return
      }
      if (cancelled || !data) return
      setState((prev) => {
        const players = prev.players.map((player) => {
          const server = data.players?.find((item) => mapPlayerId(String(item.id), room.playerId) === player.id)
          if (!server) return player
          // Sunucudan gelen adı koru; boşsa mevcut adı bırak.
          const serverName = typeof server.name === 'string' && server.name.trim() ? server.name : player.name
          return { ...player, ...server, id: player.id, name: serverName } as Player
        })
        return {
          ...prev,
          phase: data.phase ?? prev.phase,
          round: data.round ?? prev.round,
          endsAt: data.endsAt ?? prev.endsAt,
          countdownEndsAt: data.countdownEndsAt ?? prev.countdownEndsAt,
          winner: data.winner ?? prev.winner,
          coins: data.coins && data.coins.length > 0 ? data.coins : prev.coins,
          players,
        }
      })
      if (data.chaos) chaos.sync(data.chaos)
      const me = data.players?.find((item) => mapPlayerId(String(item.id), room.playerId) === 'p1')
      if (me) {
        scout.sync({
          charges: me.scoutCharges,
          usedAt: me.scoutUsedAt,
          hint: me.revealedHint ?? null,
        })
      }
    }

    const intervalMs = state.phase === 'countdown' ? POLL_MS.countdown : POLL_MS.battle
    let timer = 0

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return
        // Sekme arka plandaysa istek atma; görünür olunca devam et.
        if (typeof document !== 'undefined' && document.hidden) {
          schedule()
          return
        }
        await pull()
        schedule()
      }, intervalMs)
    }

    void pull()
    schedule()

    const onVisibility = () => {
      if (!document.hidden) void pull()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [chaos, room, scout, setState, state.phase])

  // Maç sonunda XP ver.
  const awarded = useRef(false)
  useEffect(() => {
    if (state.phase !== 'matchover' || awarded.current) return
    awarded.current = true
    const won = state.winner === 'p1'
    playSound(won ? 'win' : 'lose')
    void progress.award({ won, rounds: state.round, missions: won ? 1 : 0 })
  }, [progress, state.phase, state.round, state.winner])

  useEffect(() => {
    if (state.phase !== 'matchover') awarded.current = false
  }, [state.phase])

  const createRoom = useCallback(
    async (name?: string) => {
      setBusy(true)
      setError(null)
      unlockAudio()
      try {
        const code = makeCode()
        const displayName = (name ?? room.name ?? '').trim()
        const data = await room.call<{ token?: string; name?: string }>('duo_create_room', {
          p_code: code,
          p_token: `t-${code}`,
          p_name: displayName || null,
        })
        const token = data?.token ?? `t-${code}`
        saveToken(code, token)
        await room.connect(code, 'p1', token, data?.name ?? displayName)
        resetMatch()
        setPhase('lobby')
        playSound('join')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create room')
      } finally {
        setBusy(false)
      }
    },
    [resetMatch, room, setPhase],
  )

  const joinRoom = useCallback(
    async (code: string, name?: string) => {
      setBusy(true)
      setError(null)
      unlockAudio()
      const normalized = code.trim().toUpperCase()
      try {
        const displayName = (name ?? room.name ?? '').trim()
        const data = await room.call<{ token?: string; name?: string }>('duo_join_room', {
          p_code: normalized,
          p_token: `t-${normalized}`,
          p_name: displayName || null,
        })
        const token = data?.token ?? `t-${normalized}`
        saveToken(normalized, token)
        await room.connect(normalized, 'p2', token, data?.name ?? displayName)
        resetMatch()
        setPhase('lobby')
        playSound('join')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not join room')
      } finally {
        setBusy(false)
      }
    },
    [resetMatch, room, setPhase],
  )

  const restore = useCallback(
    async (code: string) => {
      const token = readToken(code)
      if (!token) return
      await room.connect(code, 'p1', token)
      setPhase('lobby')
    },
    [room, setPhase],
  )

  const startGame = useCallback(async () => {
    setBusy(true)
    try {
      await room.call('duo_start_round', { p_token: room.token ?? room.playerId })
      resetRound(1, room.code ?? 'round-1')
      scout.reset()
      setPhase('countdown', { countdownEndsAt: Date.now() + COUNTDOWN_MS })
    } finally {
      setBusy(false)
    }
  }, [resetRound, room, scout, setPhase])

  const startNextRound = useCallback(async () => {
    setBusy(true)
    try {
      const nextRound = state.round + 1
      await room.call('duo_start_round', { p_token: room.token ?? room.playerId })
      resetRound(nextRound, room.code ?? `round-${nextRound}`)
      scout.reset()
      setPhase('countdown', { countdownEndsAt: Date.now() + COUNTDOWN_MS })
    } finally {
      setBusy(false)
    }
  }, [resetRound, room, scout, setPhase, state.round])

  const rematch = useCallback(async () => {
    setBusy(true)
    try {
      await room.call('duo_rematch', { p_token: room.token ?? room.playerId })
      resetMatch()
      scout.reset()
      setPhase('lobby')
    } finally {
      setBusy(false)
    }
  }, [resetMatch, room, scout, setPhase])

  const leaveGame = useCallback(async () => {
    // Önce sunucudan ayrılmayı dene (best-effort). Hata olsa bile yerel
    // durumu mutlaka temizle, aksi halde kullanıcı odada takılı kalır.
    try {
      await room.call('duo_leave', { p_token: room.token ?? room.playerId })
    } catch {
      /* yoksay — yerel çıkış yine de gerçekleşmeli */
    }
    await room.disconnect()
    resetMatch()
    setPhase('home')
  }, [resetMatch, room, setPhase])

  const setName = useCallback(
    (next: string) => {
      const trimmed = next.trim().slice(0, 16)
      if (!trimmed) return
      room.setName(trimmed)
      // Yerel oyuncu (index 0) adını hemen güncelle.
      updatePlayer('p1', { name: trimmed })
      // Sunucuya da yaz (best-effort).
      if (room.code) {
        void room.call('duo_set_name', { p_token: room.token ?? room.playerId, p_name: trimmed })
      }
    },
    [room, updatePlayer],
  )

  const copyInvite = useCallback(async () => {
    if (!room.code) return
    const url = `${window.location.origin}/play/${room.code}`
    try {
      await navigator.clipboard.writeText(url)
      toast.push('Invite link copied to clipboard.', 'success')
    } catch {
      // Clipboard API can be blocked (insecure context / permissions).
      // Fall back to an in-app toast instead of a native prompt.
      toast.push(`Copy this link: ${url}`, 'info')
    }
  }, [room.code, toast])

  const secondsLeft = state.phase === 'battle' ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0

  return {
    state,
    room,
    progress,
    chaos,
    scout,
    cosmetics,
    toast,
    busy,
    error,
    secondsLeft,
    createRoom,
    joinRoom,
    restore,
    startGame,
    startNextRound,
    rematch,
    leaveGame,
    setName,
    copyInvite,
    triggerEmote: () => cosmetics.triggerEmote(),
  }
}

export { BATTLE_MS }
