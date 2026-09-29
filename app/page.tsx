'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { ArrowLeft, Check, Copy, Link2, LockKeyhole, Sparkles, Trophy, Users, Zap } from 'lucide-react'
import {
  ACTION_MS,
  BATTLE_MS,
  CLOCK_TICK_MS,
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  HEARTBEAT_MS,
  MOVE_SEND_MS,
  MOVE_SPEED,
  getCoinValue,
  nextChaosEvent,
  PHASE_TICK_MS,
  POLL_MS,
  RECONCILE_MS,
  REMOTE_POS_TTL,
  STEAL_COOLDOWN_MS,
  STEAL_RADIUS,
  STEAL_TARGET,
  defaultObjectiveForPlayer,
  spawnCoins,
  spawnFor,
} from '@/lib/config'
import { clampPos, resolveMove } from '@/lib/movement'
import { missionDoneForDisplay, missionLabel, objectiveOf, progressOf, targetOf } from '@/lib/display'
import type { Coin, Phase, Player, RemotePos, State } from '@/lib/types'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 30 } },
      })
    : null

const initialState: State = {
  phase: 'lobby',
  players: [],
  coins: spawnCoins(),
  endsAt: 0,
  countdownEndsAt: 0,
  round: 1,
  chaosEvent: nextChaosEvent(),
}

function parseServerTime(raw: unknown, now: number): number {
  let t = Number(raw)
  if (!Number.isFinite(t) || t <= 0) return 0
  if (t > 1e9 && t < 1e12) t *= 1000
  if (t > 0 && t <= 120) t = now + t * 1000
  return t
}

function mapPlayerId(rawId: string, meId: string): string {
  if (rawId === 'me' || rawId === meId) return meId
  if (rawId === 'opponent' || rawId === 'other' || rawId === 'them') {
    return meId === 'p1' ? 'p2' : 'p1'
  }
  if (rawId === 'p1' || rawId === 'p2') return rawId
  return meId === 'p1' ? 'p2' : 'p1'
}

const blankPlayer = (id: 'p1' | 'p2'): Player => ({
  id,
  name: id === 'p1' ? 'PLAYER 1' : 'PLAYER 2',
  x: spawnFor(id).x,
  y: spawnFor(id).y,
  coins: 0,
  stolen: 0,
  score: 0,
  objective: defaultObjectiveForPlayer(id),
  rematch: false,
})

function applyPositions(
  rawPlayers: Player[] | undefined,
  meId: string,
  phase: Phase,
  localPos: { x: number; y: number },
  remoteMap: Map<string, RemotePos>,
): Player[] {
  const list = rawPlayers || []
  const now = Date.now()
  const live = phase === 'battle' || phase === 'countdown'
  const mapped = list.map((player) => {
    const mappedId = mapPlayerId(String(player.id), meId)
    const isMe = mappedId === meId
    const base = { ...player, id: mappedId }

    if (isMe && live) return { ...base, x: localPos.x, y: localPos.y }

    if (!isMe && live) {
      const remote =
        remoteMap.get(mappedId) ||
        remoteMap.get('p1') ||
        remoteMap.get('p2') ||
        remoteMap.get('opponent')
      if (remote && now - remote.at < REMOTE_POS_TTL) {
        return { ...base, x: remote.x, y: remote.y }
      }
    }
    return base
  })

  if (live && mapped.length < 2) {
    if (!mapped.some((p) => p.id === 'p1')) mapped.push(blankPlayer('p1'))
    if (!mapped.some((p) => p.id === 'p2')) mapped.push(blankPlayer('p2'))
  }

  return mapped.map((p) => {
    if (p.id === meId) return live ? { ...p, x: localPos.x, y: localPos.y } : p
    const remote = remoteMap.get(p.id)
    if (remote && now - remote.at < REMOTE_POS_TTL && live) {
      return { ...p, x: remote.x, y: remote.y }
    }
    return p
  })
}

export default function Page() {
  const [phase, setPhase] = useState<Phase>('home')
  const [room, setRoom] = useState('')
  const [copied, setCopied] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const [state, setState] = useState<State>(initialState)
  const [me, setMe] = useState<'p1' | 'p2'>('p1')
  const [notice, setNotice] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [, setClock] = useState(0)

  const channelRef = useRef<RealtimeChannel | null>(null)
  const channelReady = useRef(false)
  const stateRef = useRef(state)
  const meRef = useRef(me)
  const phaseRef = useRef(phase)
  const keys = useRef(new Set<string>())
  /** Klavye + joystick hareket vektörü, aralık [-1, 1] */
  const moveInput = useRef({ x: 0, y: 0 })
  const tokenRef = useRef('')
  const codeRef = useRef('')
  const refreshInFlight = useRef(false)
  const refreshFailures = useRef(0)
  const lockedDeadline = useRef(0)
  const lockedPhase = useRef<Phase | ''>('')
  const localPosition = useRef({ ...spawnFor('p1') })
  /** peerId → broadcast ile gelen son bilinen pozisyon */
  const remoteMap = useRef(new Map<string, RemotePos>())
  const transitionInFlight = useRef(false)
  const advancedForDeadline = useRef(0)
  const lastBroadcastPos = useRef({ x: 0, y: 0 })
  const lastChaosSwapAt = useRef(0)

  function applyChaosEffect(eventId: string | undefined, nextPlayers: Player[]) {
    if (eventId !== 'swap' || nextPlayers.length < 2) return nextPlayers
    const [first, second] = nextPlayers
    if (!first || !second) return nextPlayers
    return nextPlayers.map((player, index) => ({
      ...player,
      objective: index === 0 ? second.objective ?? player.objective : first.objective ?? player.objective,
    }))
  }

  function getToken() {
    const storageKey = `duo-chaos-token:${codeRef.current}`
    if (!tokenRef.current) {
      tokenRef.current = sessionStorage.getItem(storageKey) || crypto.randomUUID()
    }
    sessionStorage.setItem(storageKey, tokenRef.current)
    return tokenRef.current
  }

  function lockDeadline(forPhase: Phase, msFromNow: number) {
    lockedPhase.current = forPhase
    lockedDeadline.current = Date.now() + msFromNow
    advancedForDeadline.current = 0
  }

  function clearDeadlineLock() {
    lockedPhase.current = ''
    lockedDeadline.current = 0
    advancedForDeadline.current = 0
  }

  /** Rakip hareket paketini state'e hemen uygula */
  function ingestRemoteMove(rawId: string, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const mappedId = mapPlayerId(String(rawId), meRef.current)
    if (mappedId === meRef.current) return

    const clamped = { ...clampPos(x, y), at: Date.now() }
    remoteMap.current.set(mappedId, clamped)
    remoteMap.current.set(String(rawId), clamped)

    setState((prev) => {
      if (prev.phase !== 'battle' && prev.phase !== 'countdown') return prev
      let found = false
      const players = prev.players.map((item) => {
        if (item.id !== mappedId) return item
        found = true
        if (item.x === clamped.x && item.y === clamped.y) return item
        return { ...item, x: clamped.x, y: clamped.y }
      })
      if (!found) {
        players.push({ ...blankPlayer(mappedId === 'p1' ? 'p1' : 'p2'), x: clamped.x, y: clamped.y })
      }
      return { ...prev, players }
    })
  }

  /** Pozisyonu peer'lara (broadcast) + sunucuya (RPC) gönder */
  function publishMove(x: number, y: number) {
    const payload = { id: meRef.current, x, y, t: Date.now(), room: codeRef.current }

    const ch = channelRef.current
    if (ch && channelReady.current) {
      void ch.send({ type: 'broadcast', event: 'move', payload })
      void ch.send({ type: 'broadcast', event: 'pos', payload })
    }

    if (supabase) {
      void supabase.rpc('duo_move', {
        p_code: codeRef.current,
        p_token: getToken(),
        p_x: x,
        p_y: y,
      })
    }
  }

  const refreshAuthoritative = useCallback(async (code = codeRef.current) => {
    if (!supabase || !code || refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const { data, error } = await supabase.rpc('duo_public_state', {
        p_code: code,
        p_token: getToken(),
      })
      if (error) {
        refreshFailures.current += 1
        const msg = error.message || ''
        if (msg.includes('room_not_found')) setNotice('That room has expired or does not exist.')
        else if (msg.includes('not_a_player'))
          setNotice('This browser is not registered in that room. Reopen the invite link.')
        else if (refreshFailures.current >= 3)
          setNotice('Connection interrupted. Retrying automatically…')
        return
      }
      refreshFailures.current = 0
      const raw = data as State & { players?: Player[] }
      const serverPhase = (raw.phase || 'lobby') as Phase
      const now = Date.now()

      let nextPhase = serverPhase
      if (
        phaseRef.current === 'battle' &&
        serverPhase === 'countdown' &&
        lockedPhase.current === 'battle'
      ) {
        nextPhase = 'battle'
      }
      if (
        (phaseRef.current === 'results' || phaseRef.current === 'matchover') &&
        (serverPhase === 'battle' || serverPhase === 'countdown') &&
        (lockedPhase.current === 'results' || lockedPhase.current === 'matchover')
      ) {
        nextPhase = phaseRef.current
      }

      const serverCountdown = parseServerTime(raw.countdownEndsAt, now)
      const serverEnds = parseServerTime(raw.endsAt, now)

      let countdownEndsAt = 0
      let endsAt = 0

      if (nextPhase === 'countdown') {
        if (lockedPhase.current === 'countdown' && lockedDeadline.current > 0) {
          countdownEndsAt = lockedDeadline.current
          if (serverCountdown > now + 200 && serverCountdown <= now + COUNTDOWN_MS + 500) {
            countdownEndsAt = serverCountdown
            lockedDeadline.current = serverCountdown
          }
        } else {
          countdownEndsAt = serverCountdown > now + 200 ? serverCountdown : now + COUNTDOWN_MS
          lockDeadline('countdown', Math.max(500, countdownEndsAt - now))
          lockedDeadline.current = countdownEndsAt
        }
      } else if (nextPhase === 'battle') {
        if (lockedPhase.current === 'battle' && lockedDeadline.current > 0) {
          endsAt = lockedDeadline.current
          if (serverEnds > now + 1000 && serverEnds <= now + BATTLE_MS + 1000) {
            endsAt = serverEnds
            lockedDeadline.current = serverEnds
          }
        } else {
          endsAt = serverEnds > now + 1000 ? serverEnds : now + BATTLE_MS
          lockDeadline('battle', Math.max(1000, endsAt - now))
          lockedDeadline.current = endsAt
        }
      } else {
        if (lockedPhase.current === 'countdown' || lockedPhase.current === 'battle') {
          clearDeadlineLock()
        }
        countdownEndsAt = serverCountdown
        endsAt = serverEnds
      }

      // Yakın zamanda broadcast yoksa remote map'i sunucu pozisyonlarıyla besle
      for (const pl of raw.players || []) {
        const id = mapPlayerId(String(pl.id), meRef.current)
        if (id === meRef.current) continue
        const existing = remoteMap.current.get(id)
        if (!existing || now - existing.at > REMOTE_POS_TTL) {
          if (typeof pl.x === 'number' && typeof pl.y === 'number') {
            remoteMap.current.set(id, { x: pl.x, y: pl.y, at: now - REMOTE_POS_TTL + 500 })
          }
        }
      }

      // Coin: yerelde/peer'da toplanmış coin'i geri canlandırma (sadece görsel)
      const prevCoins = stateRef.current.coins || []
      const localCollected = new Map(
        prevCoins.filter((c) => c.collectedBy).map((c) => [c.id, c.collectedBy as string]),
      )
      const serverCoins: Coin[] = Array.isArray(raw.coins) ? raw.coins : spawnCoins()
      const mergedCoins = serverCoins.map((c) => {
        if (c.collectedBy) return c
        const by = localCollected.get(c.id)
        return by ? { ...c, collectedBy: by } : c
      })

      let players = applyPositions(
        raw.players,
        meRef.current,
        nextPhase,
        localPosition.current,
        remoteMap.current,
      )

      // SADECE battle sırasında, sunucu gecikirse sayaçları akıcı göstermek için
      // iyimser coin/steal değerini koru. Skor ve results/matchover HER ZAMAN sunucudan.
      if (nextPhase === 'battle') {
        const prevPlayers = stateRef.current.players
        players = players.map((p) => {
          const prev = prevPlayers.find((x) => x.id === p.id)
          if (!prev) return p
          return {
            ...p,
            coins: Math.max(p.coins || 0, prev.coins || 0),
            stolen: Math.max(p.stolen || 0, prev.stolen || 0),
            objective: p.objective ?? prev.objective,
          }
        })
      }

      const next: State = {
        ...raw,
        phase: nextPhase,
        countdownEndsAt,
        endsAt,
        coins: mergedCoins,
        players,
        winner: raw.winner, // sunucu kararı, client hesaplamaz
      }

      setState(next)
      setPhase(nextPhase)
      setNotice((n) => (n === 'Connection interrupted. Retrying automatically…' ? '' : n))
    } finally {
      refreshInFlight.current = false
    }
  }, [])

  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    meRef.current = me
  }, [me])
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // Klavye + deep link
  useEffect(() => {
    const pathCode = location.pathname.split('/play/')[1]?.split('?')[0]
    if (pathCode) {
      const normalizedCode = pathCode.toUpperCase()
      const savedToken = sessionStorage.getItem(`duo-chaos-token:${normalizedCode}`)
      if (savedToken) void restoreRoom(normalizedCode, savedToken)
      else void joinRoom(normalizedCode)
    }

    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        e.preventDefault()
        keys.current.add(key)
      }
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase())
    const blur = () => {
      keys.current.clear()
      moveInput.current = { x: 0, y: 0 }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      channelRef.current?.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Hareket döngüsü
  useEffect(() => {
    if (phase !== 'battle' && phase !== 'countdown') return

    let rafId = 0
    let lastSentAt = 0
    let lastActionAt = 0
    let lastStealAt = 0
    let lastFrameTime = performance.now()
    let actionInFlight = false

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick)
      const p = phaseRef.current
      if (p !== 'battle') return

      const dt = Math.min(0.05, (now - lastFrameTime) / 1000)
      lastFrameTime = now

      if (now - lastChaosSwapAt.current >= 15_000) {
        lastChaosSwapAt.current = now
        setState((prev) => {
          const nextEvent = nextChaosEvent()
          const players =
            nextEvent.id === 'swap'
              ? applyChaosEffect(nextEvent.id, prev.players.map((p) => ({ ...p })))
              : prev.players
          return { ...prev, chaosEvent: nextEvent, players }
        })
      }

      const pressedUp = keys.current.has('w') || keys.current.has('arrowup')
      const pressedDown = keys.current.has('s') || keys.current.has('arrowdown')
      const pressedLeft = keys.current.has('a') || keys.current.has('arrowleft')
      const pressedRight = keys.current.has('d') || keys.current.has('arrowright')
      const joy = moveInput.current

      const dx = (pressedRight ? 1 : 0) - (pressedLeft ? 1 : 0) + joy.x
      const dy = (pressedDown ? 1 : 0) - (pressedUp ? 1 : 0) + joy.y

      if (dx !== 0 || dy !== 0) {
        const length = Math.hypot(dx, dy) || 1
        const step = MOVE_SPEED * dt
        const from = localPosition.current
        const { x, y } = resolveMove(
          from.x,
          from.y,
          from.x + (dx / length) * step,
          from.y + (dy / length) * step,
        )
        localPosition.current = { x, y }

        setState((prev) => {
          if (prev.phase !== 'battle') return prev
          let changed = false
          const players = prev.players.map((item) => {
            if (item.id !== meRef.current) return item
            if (Math.abs(item.x - x) < 0.01 && Math.abs(item.y - y) < 0.01) return item
            changed = true
            return { ...item, x, y }
          })
          return changed ? { ...prev, players } : prev
        })

        const movedEnough =
          Math.hypot(x - lastBroadcastPos.current.x, y - lastBroadcastPos.current.y) > 0.15
        if (now - lastSentAt >= MOVE_SEND_MS && movedEnough) {
          lastSentAt = now
          lastBroadcastPos.current = { x, y }
          publishMove(x, y)
        }
      }

      // ---- Coin toplama + çalma: iyimser görsel güncelleme + sunucu RPC ----
      if (now - lastActionAt >= ACTION_MS && !actionInFlight) {
        lastActionAt = now
        const { x, y } = localPosition.current
        const meId = meRef.current
        const nearbyCoins = stateRef.current.coins.filter(
          (c) => !c.collectedBy && Math.hypot(x - c.x, y - c.y) < COLLECT_RADIUS,
        )
        const nearOpponent = stateRef.current.players.some(
          (pl) => pl.id !== meId && Math.hypot(x - pl.x, y - pl.y) < STEAL_RADIUS,
        )

        if (nearbyCoins.length || nearOpponent) {
          actionInFlight = true

          if (nearbyCoins.length) {
            const collectedIds = new Set(nearbyCoins.map((c) => c.id))
            const coinScore = nearbyCoins.reduce(
              (sum, coin) => sum + getCoinValue(coin.type, stateRef.current.chaosEvent?.id),
              0,
            )
            setState((prev) => {
              if (prev.phase !== 'battle') return prev
              const coins = prev.coins.map((c) =>
                collectedIds.has(c.id) ? { ...c, collectedBy: meId } : c,
              )
              const players = prev.players.map((p) =>
                p.id === meId
                  ? {
                      ...p,
                      coins: p.coins + nearbyCoins.length,
                      score: p.score + coinScore,
                    }
                  : p,
              )
              return { ...prev, coins, players }
            })
            channelRef.current?.send({
              type: 'broadcast',
              event: 'collect',
              payload: { ids: nearbyCoins.map((c) => c.id), by: meId },
            })
          }

          let didSteal = false
          if (nearOpponent && now - lastStealAt >= STEAL_COOLDOWN_MS) {
            lastStealAt = now
            didSteal = true
            setState((prev) => {
              if (prev.phase !== 'battle') return prev
              const players = prev.players.map((p) =>
                p.id === meId
                  ? {
                      ...p,
                      stolen: Math.min(STEAL_TARGET, p.stolen + 1),
                      score: p.score + 20,
                    }
                  : p,
              )
              return { ...prev, players }
            })
            channelRef.current?.send({ type: 'broadcast', event: 'steal', payload: { by: meId } })
          }

          const rpcs: Promise<unknown>[] = []
          if (supabase) {
            for (const coin of nearbyCoins) {
              rpcs.push(
                supabase.rpc('duo_collect', {
                  p_code: codeRef.current,
                  p_token: getToken(),
                  p_coin_id: coin.id,
                }),
              )
            }
            if (didSteal) {
              rpcs.push(
                supabase.rpc('duo_steal', { p_code: codeRef.current, p_token: getToken() }),
              )
            }
          }

          void Promise.allSettled(rpcs).finally(() => {
            actionInFlight = false
            channelRef.current?.send({ type: 'broadcast', event: 'refresh', payload: {} })
            void refreshAuthoritative()
          })
        }
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [phase, refreshAuthoritative])

  // Heartbeat: dursak bile pozisyonu düzenli yayınla
  useEffect(() => {
    if (phase !== 'battle') return
    const id = window.setInterval(() => {
      if (phaseRef.current !== 'battle') return
      const { x, y } = localPosition.current
      publishMove(x, y)
    }, HEARTBEAT_MS)
    return () => window.clearInterval(id)
  }, [phase])

  useEffect(() => {
    if (!codeRef.current || phase === 'home') return
    const interval =
      phase === 'lobby'
        ? POLL_MS.lobby
        : phase === 'countdown'
          ? POLL_MS.countdown
          : phase === 'battle'
            ? POLL_MS.battle
            : POLL_MS.other
    const id = window.setInterval(() => void refreshAuthoritative(), interval)
    return () => window.clearInterval(id)
  }, [phase, room, refreshAuthoritative])

  useEffect(() => {
    if (!['countdown', 'battle'].includes(phase)) return
    const id = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(id)
  }, [phase])

  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'battle') return
    const id = window.setInterval(() => {
      const s = stateRef.current
      const currentPhase = phaseRef.current
      if (currentPhase !== 'countdown' && currentPhase !== 'battle') return
      const deadline =
        lockedPhase.current === currentPhase && lockedDeadline.current > 0
          ? lockedDeadline.current
          : currentPhase === 'countdown'
            ? s.countdownEndsAt
            : s.endsAt
      if (!deadline || deadline <= 0) return
      if (Date.now() < deadline) return
      if (advancedForDeadline.current === deadline) return
      advancedForDeadline.current = deadline
      void advancePhaseLocally(currentPhase)
    }, PHASE_TICK_MS)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  /**
   * Faz geçişini istemcide anında göster (akıcılık için), asıl geçişi sunucu yapar.
   * Skor/kazanan burada HESAPLANMAZ; results ekranı sunucu state'i gelene kadar
   * mevcut değerleri gösterir, refresh ile sunucu değerleri üstüne yazılır.
   */
  async function advancePhaseLocally(fromPhase: Phase) {
    if (transitionInFlight.current) return
    transitionInFlight.current = true
    try {
      if (fromPhase === 'countdown') {
        const ends = Date.now() + BATTLE_MS
        lockDeadline('battle', BATTLE_MS)
        lockedDeadline.current = ends
        setState((prev) => ({ ...prev, phase: 'battle', endsAt: ends, countdownEndsAt: 0 }))
        setPhase('battle')
        phaseRef.current = 'battle'
      } else if (fromPhase === 'battle') {
        clearDeadlineLock()
        lockedPhase.current = 'results'
        setState((prev) => ({ ...prev, phase: 'results' }))
        setPhase('results')
        phaseRef.current = 'results'
      }

      if (supabase && codeRef.current) {
        const { error } = await supabase.rpc('duo_advance_phase', {
          p_code: codeRef.current,
          p_token: getToken(),
        })
        if (error && !error.message.includes('not_ready')) {
          console.warn('duo_advance_phase', error.message)
        }
        channelRef.current?.send({ type: 'broadcast', event: 'refresh', payload: {} })
        await refreshAuthoritative()
      }
    } finally {
      transitionInFlight.current = false
    }
  }

  async function subscribeToRoom(normalizedCode: string) {
    if (!supabase) return false
    channelReady.current = false
    channelRef.current?.unsubscribe()

    const channel = supabase.channel(`duo-chaos:${normalizedCode}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: meRef.current },
      },
    })

    const onMove = (msg: { payload?: unknown }) => {
      const payload = msg?.payload as { id?: string; x?: number; y?: number } | undefined
      if (!payload) return
      if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return
      ingestRemoteMove(payload.id || 'opponent', payload.x, payload.y)
    }

    channel.on('broadcast', { event: 'move' }, onMove)
    channel.on('broadcast', { event: 'pos' }, onMove)
    channel.on('broadcast', { event: 'refresh' }, () => {
      void refreshAuthoritative(normalizedCode)
    })
    channel.on('broadcast', { event: 'collect' }, ({ payload }) => {
      const data = payload as { ids?: number[]; by?: string } | undefined
      if (!data?.ids?.length) return
      const ids = new Set(data.ids)
      const by = data.by || 'opponent'
      setState((prev) => {
        if (prev.phase !== 'battle') return prev
        const coins = prev.coins.map((c) =>
          ids.has(c.id) && !c.collectedBy ? { ...c, collectedBy: by } : c,
        )
        const players =
          by === meRef.current
            ? prev.players
            : prev.players.map((p) =>
                p.id === by ? { ...p, coins: p.coins + data.ids!.length } : p,
              )
        return { ...prev, coins, players }
      })
    })
    channel.on('broadcast', { event: 'steal' }, ({ payload }) => {
      const data = payload as { by?: string } | undefined
      const by = data?.by
      if (!by || by === meRef.current) return
      setState((prev) => {
        if (prev.phase !== 'battle') return prev
        const players = prev.players.map((p) =>
          p.id === by ? { ...p, stolen: Math.min(STEAL_TARGET, p.stolen + 1) } : p,
        )
        return { ...prev, players }
      })
    })

    // Pozisyonlar için yedek yol olarak presence
    channel.on('presence', { event: 'sync' }, () => {
      const presence = channel.presenceState() as Record<
        string,
        Array<{ id?: string; x?: number; y?: number }>
      >
      for (const key of Object.keys(presence)) {
        for (const row of presence[key] || []) {
          if (typeof row.x === 'number' && typeof row.y === 'number' && row.id) {
            ingestRemoteMove(row.id, row.x, row.y)
          }
        }
      }
    })

    await new Promise<void>((resolve) => {
      void channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          channelReady.current = true
          channelRef.current = channel
          setNotice((v) => (v === 'Realtime is reconnecting. The room is still active.' ? '' : v))
          try {
            await channel.track({
              id: meRef.current,
              x: localPosition.current.x,
              y: localPosition.current.y,
            })
          } catch {
            /* presence opsiyonel */
          }
          publishMove(localPosition.current.x, localPosition.current.y)
          resolve()
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          channelReady.current = false
          setNotice('Realtime is reconnecting. The room is still active.')
          resolve()
        }
      })
    })

    channelRef.current = channel
    return true
  }

  async function connect(code: string, playerId: 'p1' | 'p2') {
    const normalizedCode = code.trim().toUpperCase()
    setRoom(normalizedCode)
    codeRef.current = normalizedCode
    setMe(playerId)
    meRef.current = playerId
    localPosition.current = { ...spawnFor(playerId) }
    remoteMap.current.clear()
    clearDeadlineLock()
    setPhase('lobby')
    getToken()

    if (!supabase) {
      setNotice('Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ANON_KEY.')
      return false
    }

    const rpc = playerId === 'p1' ? 'duo_create_room' : 'duo_join_room'
    const { error } = await supabase.rpc(rpc, {
      p_code: normalizedCode,
      p_token: getToken(),
    })
    if (error) {
      const message = error.message.toLowerCase()
      if (playerId === 'p1' && message.includes('room_exists')) return false
      if (playerId === 'p2') {
        setNotice(
          message.includes('room_full')
            ? 'That room is full.'
            : message.includes('room_not_found')
              ? 'That room has expired or does not exist.'
              : 'We could not join that room. Please use the latest invite link.',
        )
      } else {
        setNotice('Could not create that room. Please try again.')
      }
      return false
    }
    await subscribeToRoom(normalizedCode)
    await refreshAuthoritative(normalizedCode)
    return true
  }

  async function restoreRoom(normalizedCode: string, savedToken: string) {
    if (!supabase) {
      setNotice('Supabase is not configured.')
      return
    }
    tokenRef.current = savedToken
    codeRef.current = normalizedCode
    setRoom(normalizedCode)

    const { error } = await supabase.rpc('duo_public_state', {
      p_code: normalizedCode,
      p_token: savedToken,
    })
    if (error) {
      sessionStorage.removeItem(`duo-chaos-token:${normalizedCode}`)
      tokenRef.current = ''
      await joinRoom(normalizedCode)
      return
    }

    const { data: membership, error: membershipError } = await supabase.rpc('duo_join_room', {
      p_code: normalizedCode,
      p_token: savedToken,
    })
    if (membershipError) {
      sessionStorage.removeItem(`duo-chaos-token:${normalizedCode}`)
      tokenRef.current = ''
      await joinRoom(normalizedCode)
      return
    }

    const slot = Number((membership as { slot?: number })?.slot) || 1
    const playerId = (slot === 1 ? 'p1' : 'p2') as 'p1' | 'p2'
    setMe(playerId)
    meRef.current = playerId
    localPosition.current = { ...spawnFor(playerId) }
    remoteMap.current.clear()
    clearDeadlineLock()
    await subscribeToRoom(normalizedCode)
    await refreshAuthoritative(normalizedCode)
  }

  async function createRoom() {
    if (!supabase) {
      setNotice('Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ANON_KEY.')
      return
    }
    setNotice('')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()
      history.pushState({}, '', `/play/${code}`)
      if (await connect(code, 'p1')) return
    }
    history.pushState({}, '', '/')
    setNotice('Could not create a room. Please try again.')
  }

  async function joinRoom(code: string) {
    const normalizedCode = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(normalizedCode)) {
      setNotice('That room code is not valid.')
      return
    }
    history.pushState({}, '', `/play/${normalizedCode}`)
    await connect(normalizedCode, 'p2')
  }

  async function startGame() {
    if (!supabase || me !== 'p1' || state.players.length !== 2) return
    const { error } = await supabase.rpc('duo_start_round', {
      p_code: room,
      p_token: getToken(),
    })
    if (error) {
      setNotice('Only the host can start when both players are connected.')
      return
    }

    const ends = Date.now() + COUNTDOWN_MS
    lastChaosSwapAt.current = ends
    const firstEvent = nextChaosEvent()
    lockDeadline('countdown', COUNTDOWN_MS)
    lockedDeadline.current = ends
    setState((prev) => ({
      ...prev,
      phase: 'countdown',
      countdownEndsAt: ends,
      endsAt: ends + BATTLE_MS,
      chaosEvent: firstEvent,
      players: prev.players.map((p, index) => ({
        ...p,
        objective: p.objective ?? (index === 0 ? defaultObjectiveForPlayer('p1') : defaultObjectiveForPlayer('p2')),
      })),
    }))
    setPhase('countdown')
    phaseRef.current = 'countdown'

    channelRef.current?.send({ type: 'broadcast', event: 'refresh', payload: {} })
    await refreshAuthoritative()
  }

  async function rematch() {
    if (!supabase) return
    const { error } = await supabase.rpc('duo_rematch', {
      p_code: room,
      p_token: getToken(),
    })
    if (error) setNotice('Rematch is unavailable right now.')
    else {
      clearDeadlineLock()
      remoteMap.current.clear()
      localPosition.current = { ...spawnFor(meRef.current) }
      await refreshAuthoritative()
    }
  }

  async function leaveGame() {
    if (leaving) return
    setLeaving(true)
    try {
      if (supabase && room) {
        await supabase.rpc('duo_leave', { p_code: room, p_token: getToken() })
      }
    } finally {
      channelReady.current = false
      channelRef.current?.unsubscribe()
      channelRef.current = null
      sessionStorage.removeItem(`duo-chaos-token:${room}`)
      tokenRef.current = ''
      codeRef.current = ''
      remoteMap.current.clear()
      clearDeadlineLock()
      history.pushState({}, '', '/')
      setRoom('')
      setState(initialState)
      setPhase('home')
      setNotice('')
      setLeaving(false)
    }
  }

  async function copyInvite(textOverride?: string) {
    const value = textOverride ?? location.href
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value)
      else {
        const input = document.createElement('textarea')
        input.value = value
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        input.remove()
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice(
        textOverride ? 'Copy failed. Please copy the room code manually.' : 'Copy failed. Please copy the invite URL manually.',
      )
    }
  }

  const now = Date.now()
  let displayCountdown = 0
  let displayRemaining = Math.ceil(BATTLE_MS / 1000)

  if (phase === 'countdown') {
    const dl =
      lockedPhase.current === 'countdown' && lockedDeadline.current > 0
        ? lockedDeadline.current
        : state.countdownEndsAt
    displayCountdown = Math.max(1, Math.ceil((dl - now) / 1000))
    if (dl > 0 && now >= dl) displayCountdown = 1
  } else if (phase === 'battle') {
    const dl =
      lockedPhase.current === 'battle' && lockedDeadline.current > 0
        ? lockedDeadline.current
        : state.endsAt
    displayRemaining = Math.max(0, Math.ceil((dl - now) / 1000))
  }

  const self = state.players.find((p) => p.id === me)
  const opponent = state.players.find((p) => p.id !== me)

  if (phase === 'home') return <Home onCreate={createRoom} onJoin={joinRoom} />

  return (
    <main className="game-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setConfirmLeave(true)}>
          <span className="brand-mark">◆</span> DUO CHAOS
        </button>
        <div className="topbar-actions">
          <button
            className="sound-toggle"
            onClick={() => setSoundOn((v) => !v)}
            aria-label={soundOn ? 'Mute game sounds' : 'Enable game sounds'}
          >
            {soundOn ? 'SOUND ON' : 'SOUND OFF'}
          </button>
          <div className="room-pill">
            <span>ROOM</span>
            <span className="room-code">{room}</span>
            <button onClick={() => copyInvite(room)} aria-label="Copy room code">
              {copied ? <Check /> : <Copy />}
            </button>
          </div>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      {phase === 'lobby' && (
        <Lobby
          state={state}
          isHost={me === 'p1'}
          onStart={startGame}
          onCopy={copyInvite}
          copied={copied}
        />
      )}

      {(phase === 'countdown' || phase === 'battle') && (
        <Battle
          state={state}
          self={self}
          opponent={opponent}
          remaining={displayRemaining}
          countdown={displayCountdown}
          phase={phase}
          onMoveInput={(x, y) => {
            moveInput.current = { x, y }
          }}
        />
      )}

      {(phase === 'results' || phase === 'matchover') && (
        <Results state={state} me={me} onRematch={rematch} onLeave={() => setConfirmLeave(true)} />
      )}

      {(phase === 'lobby' || phase === 'countdown' || phase === 'battle') && (
        <button
          className="text-button leave-game"
          onClick={() => setConfirmLeave(true)}
          disabled={leaving}
        >
          {leaving ? 'LEAVING…' : 'LEAVE GAME'}
        </button>
      )}

      {confirmLeave && (
        <div className="confirm-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-title"
          >
            <p className="eyebrow">EXIT DUO CHAOS?</p>
            <h2 id="leave-title">Are you sure you want to leave the game?</h2>
            <p>Your room will stay open for the other player, but this match will end for you.</p>
            <div className="confirm-actions">
              <button className="secondary" onClick={() => setConfirmLeave(false)}>
                CANCEL
              </button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmLeave(false)
                  void leaveGame()
                }}
              >
                LEAVE GAME
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

function Home({
  onCreate,
  onJoin,
}: {
  onCreate: () => void
  onJoin: (code: string) => void
}) {
  const [code, setCode] = useState('')
  return (
    <main className="home">
      <div className="home-content">
        <div className="eyebrow">
          <Zap /> REAL-TIME PARTY GAME
        </div>
        <h1>
          DUO
          <br />
          <em>CHAOS</em>
        </h1>
        <p className="tagline">
          Get a secret mission.
          <br />
          Outsmart your friend.
        </p>
        <div className="home-actions">
          <button className="primary" onClick={onCreate}>
            CREATE GAME <ArrowLeft className="flip" />
          </button>
          <div className="join-row">
            <input
              aria-label="Room code"
              maxLength={6}
              placeholder="ENTER ROOM CODE"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.length === 6) onJoin(code)
              }}
            />
            <button className="secondary" disabled={code.length !== 6} onClick={() => onJoin(code)}>
              JOIN <Link2 />
            </button>
          </div>
        </div>
        <div className="steps">
          {['Create a game', 'Send the link', 'Get a secret mission', 'Beat them'].map((x, i) => (
            <div key={x}>
              <b>0{i + 1}</b>
              <span>{x}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="home-doodle">
        <span className="coin coin-a">$</span>
        <span className="coin coin-b">$</span>
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <div className="mini-arena">
          <div className="mini-player pink" />
          <div className="mini-player green" />
          <div className="mini-coin">$</div>
        </div>
      </div>
    </main>
  )
}

function Lobby({
  state,
  isHost,
  onStart,
  onCopy,
  copied,
}: {
  state: State
  isHost: boolean
  onStart: () => void
  onCopy: (value?: string) => void
  copied: boolean
}) {
  const full = state.players.length === 2
  return (
    <section className="panel lobby">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">COIN CHAOS / LOBBY</p>
          <h2>Bring the chaos.</h2>
        </div>
        <Users className="heading-icon" />
      </div>
      <div className="players">
        {[0, 1].map((i) => (
          <div className={`player-card ${state.players[i] ? 'connected' : ''}`} key={i}>
            <div className={`avatar ${i ? 'green' : 'pink'}`}>
              {state.players[i] ? (i ? '2' : '1') : '?'}
            </div>
            <div>
              <strong>{state.players[i]?.name || `PLAYER ${i + 1}`}</strong>
              <small>{state.players[i] ? 'CONNECTED' : 'WAITING FOR PLAYER...'}</small>
            </div>
            <span className="status-dot" />
          </div>
        ))}
      </div>
      <div className="invite">
        <div>
          <small>INVITE YOUR FRIEND</small>
          <strong>{typeof window !== 'undefined' ? location.href : ''}</strong>
        </div>
        <button onClick={() => onCopy(location.href)}>
          {copied ? <Check /> : <Copy />} {copied ? 'COPIED' : 'COPY INVITE LINK'}
        </button>
      </div>
      <button className="primary wide" disabled={!full || !isHost} onClick={onStart}>
        {!isHost ? 'WAITING FOR HOST' : full ? 'START GAME' : 'WAITING FOR PLAYER 2'} <Sparkles />
      </button>
      <p className="lobby-note">Each player gets a different secret mission.</p>
    </section>
  )
}

/** Dokunmatik cihazlar için sanal joystick */
function VirtualJoystick({
  disabled,
  onChange,
}: {
  disabled?: boolean
  onChange: (x: number, y: number) => void
}) {
  const baseRef = useRef<HTMLDivElement>(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const [visible, setVisible] = useState(false)
  const [origin, setOrigin] = useState({ x: 18, y: 18 })
  const active = useRef(false)
  const radius = 28

  const updateFromEvent = (clientX: number, clientY: number) => {
    const el = baseRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let dx = clientX - (rect.left + rect.width / 2)
    let dy = clientY - (rect.top + rect.height / 2)
    const dist = Math.hypot(dx, dy)
    if (dist > radius) {
      dx = (dx / dist) * radius
      dy = (dy / dist) * radius
    }
    setKnob({ x: dx, y: dy })

    const nx = dx / radius
    const ny = dy / radius
    const mag = Math.hypot(nx, ny)
    if (mag < 0.12) {
      onChange(0, 0)
    } else {
      const scaled = Math.min(1, (mag - 0.12) / 0.88)
      onChange((nx / mag) * scaled, (ny / mag) * scaled)
    }
  }

  const end = () => {
    active.current = false
    setVisible(false)
    setKnob({ x: 0, y: 0 })
    onChange(0, 0)
  }

  return (
    <div
      className="joystick-zone"
      ref={baseRef}
      style={{
        opacity: disabled || !visible ? 0 : 1,
        pointerEvents: disabled || !visible ? 'none' : 'auto',
        left: `${origin.x}px`,
        top: `${origin.y}px`,
      }}
      onPointerDown={(e) => {
        if (disabled) return
        e.preventDefault()
        e.stopPropagation()
        active.current = true
        setVisible(true)
        const nextX = Math.min(window.innerWidth - 84, Math.max(12, e.clientX - 38))
        const nextY = Math.min(window.innerHeight - 84, Math.max(12, e.clientY - 38))
        setOrigin({ x: nextX, y: nextY })
        e.currentTarget.setPointerCapture(e.pointerId)
        updateFromEvent(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => {
        if (!active.current) return
        e.preventDefault()
        updateFromEvent(e.clientX, e.clientY)
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="joystick-hint">MOVE</span>
      <div className="joystick-base" />
      <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  )
}

function Battle({
  state,
  self,
  opponent,
  remaining,
  countdown,
  phase,
  onMoveInput,
}: {
  state: State
  self?: Player
  opponent?: Player
  remaining: number
  countdown: number
  phase: Phase
  onMoveInput: (x: number, y: number) => void
}) {
  const objective = objectiveOf(self)
  const isCountdown = phase === 'countdown'

  return (
    <section className="battle-wrap">
      <div className="scorebar">
        <div className="score">
          <span className="dot pink-bg" />
          YOU <b>{self?.score || 0}</b>
        </div>
        <div className={`timer ${!isCountdown && remaining < 10 ? 'urgent' : ''}`}>
          {isCountdown ? countdown : `0:${String(remaining).padStart(2, '0')}`}
        </div>
        <div className="score right">
          <b>{opponent?.score || 0}</b> THEM <span className="dot green-bg" />
        </div>
      </div>
      <div className="mission-strip">
        <span className="mission-label"><LockKeyhole /> SECRET MISSION</span>
        <strong>{objective?.shortLabel || missionLabel(objective)}</strong>
        <small>{self ? `${progressOf(self)} / ${targetOf(objective)}` : `0 / ${targetOf(objective)}`}</small>
      </div>
      {state.chaosEvent && (
        <div className="mission-strip" style={{ marginTop: 8, background: '#fff4cc', borderColor: '#f0b63c' }}>
          <Zap /> <span>CHAOS EVENT</span>
          <strong>{state.chaosEvent.name}</strong>
          <small>{state.chaosEvent.boost}</small>
        </div>
      )}
      <div className="arena">
        <div className="boundary" />
        {state.coins
          .filter((c) => !c.collectedBy)
          .map((c) => {
            const coinColors: Record<string, string> = {
              gold: '#ffd166',
              blue: '#67d4ff',
              red: '#ff7a7a',
              emerald: '#58d6a6',
            }
            return (
              <span
                key={c.id}
                className="arena-coin"
                style={{
                  left: `${c.x}%`,
                  top: `${c.y}%`,
                  background: coinColors[c.type] || '#ffd166',
                  borderColor: '#17151d',
                }}
              >
                {c.type === 'gold' ? '$' : c.type === 'blue' ? 'B' : c.type === 'red' ? 'R' : 'E'}
              </span>
            )
          })}
        {state.players.map((p) => (
          <div
            key={p.id}
            className={`arena-player ${p.id === 'p1' ? 'pink' : 'green'} ${
              p.id === self?.id ? 'me' : ''
            }`}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
          >
            <span>{p.id === self?.id ? 'YOU' : 'THEM'}</span>
          </div>
        ))}
        <div className="obstacle one" />
        <div className="obstacle two" />
        {isCountdown && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              background: 'rgb(25 20 35 / 35%)',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                fontSize: 'clamp(64px, 18vw, 120px)',
                fontWeight: 950,
                letterSpacing: '-0.08em',
                color: 'var(--ink)',
                textShadow: '6px 6px 0 var(--yellow)',
              }}
            >
              {countdown}
            </span>
          </div>
        )}
        <VirtualJoystick disabled={isCountdown} onChange={onMoveInput} />
      </div>
      <div className="controls-hint">
        <span>MOVE</span>
        <kbd>W</kbd>
        <kbd>A</kbd>
        <kbd>S</kbd>
        <kbd>D</kbd>
        <span className="touch-hint">
          {isCountdown ? 'get ready…' : 'joystick (mobile) or WASD'}
        </span>
      </div>
    </section>
  )
}

function Results({
  state,
  me,
  onRematch,
  onLeave,
}: {
  state: State
  me: string
  onRematch: () => void
  onLeave: () => void
}) {
  // Kazanan ve skorlar sunucudan gelir; burada sadece gösterilir.
  const winner = state.players.find((p) => p.id === state.winner)
  const done = state.players.map(missionDoneForDisplay)
  const bothDone = state.players.length >= 2 && done.every(Boolean)
  const bothFailed = state.players.length >= 2 && done.every((d) => !d)

  let headline = 'Total chaos.'
  if (winner) headline = `${winner.name || (winner.id === me ? 'You' : 'Them')} takes it.`
  else if (bothDone) headline = 'Both missions complete!'
  else if (bothFailed) headline = 'Nobody finished the mission.'

  return (
    <section className="panel results">
      <div className="trophy">
        <Trophy />
      </div>
      <p className="eyebrow">ROUND {state.round} COMPLETE</p>
      <h2>{headline}</h2>
      <div className="reveal">
        {state.players.map((p) => {
          const objective = objectiveOf(p)
          const progress = progressOf(p)
          const target = targetOf(objective)
          const ok = missionDoneForDisplay(p)
          return (
            <div className="result-row" key={p.id}>
              <div className={`avatar ${p.id === 'p1' ? 'pink' : 'green'}`}>
                {p.id === me ? 'YOU' : 'THEM'}
              </div>
              <div>
                <strong>{missionLabel(objective)}</strong>
                <small>
                  {objective?.kind === 'steal'
                    ? `${progress} / ${target} stolen`
                    : `${progress} / ${target} resources collected`}
                </small>
              </div>
              <b style={{ color: ok ? 'var(--mint)' : undefined }}>{ok ? 'COMPLETE' : 'FAILED'}</b>
            </div>
          )
        })}
      </div>
      <div className="score-summary">
        {state.players.map((p) => (
          <div key={p.id}>
            <small>{p.id === me ? 'YOU' : 'THEM'}</small>
            <strong>{p.score || 0}</strong>
          </div>
        ))}
      </div>
      <button className="primary wide" onClick={onRematch}>
        {state.players.find((p) => p.id === me)?.rematch ? 'WAITING FOR OPPONENT' : 'REMATCH'}{' '}
        <Zap />
      </button>
      <button className="text-button" onClick={onLeave}>
        LEAVE GAME
      </button>
    </section>
  )
}
