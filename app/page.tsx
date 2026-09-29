'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { ArrowLeft, Check, Copy, Link2, LockKeyhole, Sparkles, Trophy, Users, Zap } from 'lucide-react'

type Phase = 'home' | 'lobby' | 'countdown' | 'battle' | 'results' | 'matchover'
type Player = {
  id: string
  name: string
  x: number
  y: number
  coins: number
  stolen: number
  score: number
  objective: 'collect' | 'steal' | null
  rematch: boolean
}
type Coin = { id: number; x: number; y: number; collectedBy?: string }
type State = {
  phase: Phase
  players: Player[]
  coins: Coin[]
  endsAt: number
  countdownEndsAt: number
  round: number
  winner?: string
}

const BATTLE_MS = 30_000
const COUNTDOWN_MS = 3_000
const MOVE_SPEED = 32 // % of arena per second
const MOVE_SEND_MS = 33 // ~30 Hz position broadcast
const ACTION_MS = 140
const RECONCILE_MS = 800

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null

const spawnCoins = (): Coin[] =>
  Array.from({ length: 14 }, (_, i) => ({
    id: i,
    x: 8 + ((i * 31) % 84),
    y: 12 + ((i * 47) % 76),
  }))

const initialState: State = {
  phase: 'lobby',
  players: [],
  coins: spawnCoins(),
  endsAt: 0,
  countdownEndsAt: 0,
  round: 1,
}

/** Convert server timestamps that may be seconds, ms, or already expired. */
function normalizeDeadline(raw: unknown, now: number, durationMs: number, phaseActive: boolean): number {
  let t = Number(raw)
  if (!Number.isFinite(t) || t <= 0) {
    return phaseActive ? now + durationMs : 0
  }
  // Seconds since epoch (10 digits) → ms
  if (t > 1e9 && t < 1e12) t = t * 1000
  // Relative remaining seconds (e.g. 30)
  if (t > 0 && t <= 120) t = now + t * 1000
  // Already expired while we just entered the phase → give a full duration
  if (phaseActive && t <= now + 500) {
    return now + durationMs
  }
  return t
}

function mapPlayerId(rawId: string, meId: string): string {
  if (rawId === 'me' || rawId === meId) return meId
  if (rawId === 'opponent' || rawId === 'other' || rawId === 'them') {
    return meId === 'p1' ? 'p2' : 'p1'
  }
  if (rawId === 'p1' || rawId === 'p2') return rawId
  // Unknown id: treat as opponent if it is not me
  return meId === 'p1' ? 'p2' : 'p1'
}

function normalizePlayers(
  rawPlayers: Player[] | undefined,
  meId: string,
  phase: Phase,
  localPos: { x: number; y: number },
  remotePos: { x: number; y: number; at: number } | null,
): Player[] {
  const list = rawPlayers || []
  return list.map((player) => {
    const mappedId = mapPlayerId(String(player.id), meId)
    const isMe = mappedId === meId
    const base = { ...player, id: mappedId }

    if (isMe && phase === 'battle') {
      return { ...base, x: localPos.x, y: localPos.y }
    }
    // Prefer recent realtime broadcast for opponent over stale RPC snapshot
    if (!isMe && remotePos && phase === 'battle' && Date.now() - remotePos.at < 1500) {
      return { ...base, x: remotePos.x, y: remotePos.y }
    }
    return base
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
  const stateRef = useRef(state)
  const meRef = useRef(me)
  const phaseRef = useRef(phase)
  const keys = useRef(new Set<string>())
  const touchVector = useRef({ x: 0, y: 0 })
  const tokenRef = useRef('')
  const codeRef = useRef('')
  const refreshInFlight = useRef(false)
  const refreshFailures = useRef(0)
  const fallbackDeadline = useRef(0)
  const localPosition = useRef({ x: 18, y: 50 })
  const remotePosition = useRef<{ x: number; y: number; at: number } | null>(null)
  const transitionInFlight = useRef(false)
  const finishedForDeadline = useRef(0)
  const battleEnteredAt = useRef(0)

  function getToken() {
    const storageKey = `duo-chaos-token:${codeRef.current}`
    if (!tokenRef.current) {
      tokenRef.current = sessionStorage.getItem(storageKey) || crypto.randomUUID()
    }
    sessionStorage.setItem(storageKey, tokenRef.current)
    return tokenRef.current
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
        if (msg.includes('room_not_found')) {
          setNotice('That room has expired or does not exist.')
        } else if (msg.includes('not_a_player')) {
          setNotice('This browser is not registered in that room. Reopen the invite link.')
        } else if (refreshFailures.current >= 3) {
          setNotice('Connection interrupted. Retrying automatically…')
        }
        return
      }
      refreshFailures.current = 0
      const raw = data as State & { players?: Player[] }
      const normalizedPhase = (raw.phase || 'lobby') as Phase
      const now = Date.now()

      const endsAt = normalizeDeadline(
        raw.endsAt,
        now,
        BATTLE_MS,
        normalizedPhase === 'battle',
      )
      const countdownEndsAt = normalizeDeadline(
        raw.countdownEndsAt,
        now,
        COUNTDOWN_MS,
        normalizedPhase === 'countdown',
      )

      const next: State = {
        ...raw,
        phase: normalizedPhase,
        endsAt,
        countdownEndsAt,
        coins: Array.isArray(raw.coins) ? raw.coins : spawnCoins(),
        players: normalizePlayers(
          raw.players,
          meRef.current,
          normalizedPhase,
          localPosition.current,
          remotePosition.current,
        ),
      }

      // Reset client fallback when phase actually changes
      if (next.phase !== phaseRef.current) {
        fallbackDeadline.current = 0
        finishedForDeadline.current = 0
        if (next.phase === 'battle') {
          battleEnteredAt.current = now
          // Ensure we have a usable deadline even if server sent garbage
          if (!next.endsAt || next.endsAt <= now) {
            next.endsAt = now + BATTLE_MS
          }
          fallbackDeadline.current = next.endsAt
        } else if (next.phase === 'countdown') {
          if (!next.countdownEndsAt || next.countdownEndsAt <= now) {
            next.countdownEndsAt = now + COUNTDOWN_MS
          }
          fallbackDeadline.current = next.countdownEndsAt
        }
      }

      setState(next)
      setPhase(next.phase)
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

  // Keyboard + deep link
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
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.key.toLowerCase())
    }
    const blur = () => keys.current.clear()
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

  // Movement + collect/steal loop
  useEffect(() => {
    if (phase !== 'battle') return

    let rafId = 0
    let lastSentAt = 0
    let lastActionAt = 0
    let lastFrameTime = performance.now()
    let actionInFlight = false

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick)

      if (phaseRef.current !== 'battle') return

      const dt = Math.min(0.05, (now - lastFrameTime) / 1000)
      lastFrameTime = now

      const pressedUp = keys.current.has('w') || keys.current.has('arrowup')
      const pressedDown = keys.current.has('s') || keys.current.has('arrowdown')
      const pressedLeft = keys.current.has('a') || keys.current.has('arrowleft')
      const pressedRight = keys.current.has('d') || keys.current.has('arrowright')
      const touch = touchVector.current

      const dx = (pressedRight ? 1 : 0) - (pressedLeft ? 1 : 0) + touch.x
      const dy = (pressedDown ? 1 : 0) - (pressedUp ? 1 : 0) + touch.y

      if (dx !== 0 || dy !== 0) {
        const length = Math.hypot(dx, dy) || 1
        const step = MOVE_SPEED * dt
        const x = Math.max(5, Math.min(95, localPosition.current.x + (dx / length) * step))
        const y = Math.max(7, Math.min(93, localPosition.current.y + (dy / length) * step))
        localPosition.current = { x, y }

        // Smooth local render every frame
        setState((prev) => {
          if (prev.phase !== 'battle') return prev
          let changed = false
          const players = prev.players.map((item) => {
            if (item.id !== meRef.current) return item
            if (item.x === x && item.y === y) return item
            changed = true
            return { ...item, x, y }
          })
          return changed ? { ...prev, players } : prev
        })

        // Network: broadcast (fast peer visibility) + RPC (authoritative)
        if (now - lastSentAt >= MOVE_SEND_MS) {
          lastSentAt = now
          const payload = { id: meRef.current, x, y, t: Date.now() }
          channelRef.current?.send({ type: 'broadcast', event: 'move', payload })
          if (supabase) {
            void supabase.rpc('duo_move', {
              p_code: codeRef.current,
              p_token: getToken(),
              p_x: x,
              p_y: y,
            })
          }
        }
      }

      // Collect / steal
      if (supabase && now - lastActionAt >= ACTION_MS && !actionInFlight) {
        lastActionAt = now
        const { x, y } = localPosition.current
        const nearbyCoins = stateRef.current.coins.filter(
          (c) => !c.collectedBy && Math.hypot(x - c.x, y - c.y) < 10,
        )
        const nearOpponent = stateRef.current.players.some(
          (p) => p.id !== meRef.current && Math.hypot(x - p.x, y - p.y) < 9,
        )
        if (nearbyCoins.length || nearOpponent) {
          actionInFlight = true
          void Promise.allSettled([
            ...nearbyCoins.map((coin) =>
              supabase.rpc('duo_collect', {
                p_code: codeRef.current,
                p_token: getToken(),
                p_coin_id: coin.id,
              }),
            ),
            supabase.rpc('duo_steal', {
              p_code: codeRef.current,
              p_token: getToken(),
            }),
          ]).finally(() => {
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

  // Single reconcile interval (no double polling)
  useEffect(() => {
    if (!codeRef.current || phase === 'home') return
    const interval =
      phase === 'lobby'
        ? 600
        : phase === 'countdown'
          ? 400
          : phase === 'battle'
            ? RECONCILE_MS
            : 1200
    const id = window.setInterval(() => void refreshAuthoritative(), interval)
    return () => window.clearInterval(id)
  }, [phase, room, refreshAuthoritative])

  // UI clock tick
  useEffect(() => {
    if (!['countdown', 'battle'].includes(phase)) return
    const id = window.setInterval(() => setClock(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [phase])

  // Phase deadline → advance (guarded so it only fires once per deadline)
  useEffect(() => {
    if (!['countdown', 'battle'].includes(phase)) {
      fallbackDeadline.current = 0
      finishedForDeadline.current = 0
      return
    }

    if (!fallbackDeadline.current) {
      const base = phase === 'countdown' ? COUNTDOWN_MS : BATTLE_MS
      fallbackDeadline.current = Date.now() + base
    }

    const id = window.setInterval(() => {
      const s = stateRef.current
      if (s.phase !== 'countdown' && s.phase !== 'battle') return

      const deadline =
        s.phase === 'countdown'
          ? s.countdownEndsAt || fallbackDeadline.current
          : s.endsAt || fallbackDeadline.current

      if (deadline <= 0) return
      // Don't end battle in the first 1.5s after entering (protects against bad server times)
      if (s.phase === 'battle' && Date.now() - battleEnteredAt.current < 1500) return

      if (Date.now() >= deadline && finishedForDeadline.current !== deadline) {
        finishedForDeadline.current = deadline
        void finishRound()
      }
    }, 100)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  async function subscribeToRoom(normalizedCode: string) {
    if (!supabase) return false
    channelRef.current?.unsubscribe()
    const channel = supabase.channel(`duo-chaos:${normalizedCode}`, {
      config: { broadcast: { self: false } },
    })

    channel.on('broadcast', { event: 'refresh' }, () => {
      void refreshAuthoritative(normalizedCode)
    })

    channel.on('broadcast', { event: 'move' }, ({ payload }) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { id?: string; x?: number; y?: number; t?: number }
      if (p.id === meRef.current) return
      if (typeof p.x !== 'number' || typeof p.y !== 'number') return

      remotePosition.current = { x: p.x, y: p.y, at: Date.now() }

      setState((prev) => {
        if (prev.phase !== 'battle') return prev
        const oppId = meRef.current === 'p1' ? 'p2' : 'p1'
        let changed = false
        const players = prev.players.map((item) => {
          if (item.id !== oppId && item.id !== p.id) return item
          if (item.x === p.x && item.y === p.y) return item
          changed = true
          return { ...item, x: p.x!, y: p.y! }
        })
        return changed ? { ...prev, players } : prev
      })
    })

    await channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setNotice((v) => (v === 'Realtime is reconnecting. The room is still active.' ? '' : v))
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setNotice('Realtime is reconnecting. The room is still active.')
      }
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
    localPosition.current = playerId === 'p1' ? { x: 18, y: 50 } : { x: 82, y: 50 }
    remotePosition.current = null
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
    const playerId = slot === 1 ? 'p1' : 'p2'
    setMe(playerId)
    meRef.current = playerId
    localPosition.current = playerId === 'p1' ? { x: 18, y: 50 } : { x: 82, y: 50 }
    remotePosition.current = null
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
    // Seed local deadlines immediately so timer never shows 0:00
    const now = Date.now()
    battleEnteredAt.current = 0
    finishedForDeadline.current = 0
    fallbackDeadline.current = now + COUNTDOWN_MS
    setState((prev) => ({
      ...prev,
      phase: 'countdown',
      countdownEndsAt: now + COUNTDOWN_MS,
      endsAt: now + COUNTDOWN_MS + BATTLE_MS,
    }))
    setPhase('countdown')
    await refreshAuthoritative()
  }

  async function finishRound() {
    if (!supabase || !room || transitionInFlight.current) return
    transitionInFlight.current = true
    try {
      const { error } = await supabase.rpc('duo_advance_phase', {
        p_code: room,
        p_token: getToken(),
      })
      if (error && !error.message.includes('not_ready')) {
        setNotice('The round could not advance. Reconnecting…')
      }
      await refreshAuthoritative()
    } finally {
      transitionInFlight.current = false
    }
  }

  async function rematch() {
    if (!supabase) return
    const { error } = await supabase.rpc('duo_rematch', {
      p_code: room,
      p_token: getToken(),
    })
    if (error) setNotice('Rematch is unavailable right now.')
    else {
      finishedForDeadline.current = 0
      fallbackDeadline.current = 0
      remotePosition.current = null
      localPosition.current = meRef.current === 'p1' ? { x: 18, y: 50 } : { x: 82, y: 50 }
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
      channelRef.current?.unsubscribe()
      channelRef.current = null
      sessionStorage.removeItem(`duo-chaos-token:${room}`)
      tokenRef.current = ''
      codeRef.current = ''
      remotePosition.current = null
      history.pushState({}, '', '/')
      setRoom('')
      setState(initialState)
      setPhase('home')
      setNotice('')
      setLeaving(false)
    }
  }

  async function copyInvite() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(location.href)
      else {
        const input = document.createElement('textarea')
        input.value = location.href
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        input.remove()
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice('Copy failed. Please copy the invite URL manually.')
    }
  }

  // ---- Derived timer values (never stuck at 0 on phase entry) ----
  const now = Date.now()
  let battleDeadline = state.endsAt || 0
  let countdownDeadline = state.countdownEndsAt || 0
  if (phase === 'battle') {
    if (!battleDeadline || battleDeadline <= now) {
      battleDeadline = fallbackDeadline.current || battleEnteredAt.current + BATTLE_MS || now + BATTLE_MS
    }
  }
  if (phase === 'countdown') {
    if (!countdownDeadline || countdownDeadline <= now) {
      countdownDeadline = fallbackDeadline.current || now + COUNTDOWN_MS
    }
  }

  const remaining =
    phase === 'battle' ? Math.max(0, Math.ceil((battleDeadline - now) / 1000)) : 30
  const countdown =
    phase === 'countdown' ? Math.max(1, Math.ceil((countdownDeadline - now) / 1000)) : 0

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
            <span>ROOM</span> {room}
            <button onClick={copyInvite} aria-label="Copy invite link">
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
          remaining={remaining}
          countdown={countdown}
          onTouchVector={(x, y) => {
            touchVector.current = { x, y }
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
  onCopy: () => void
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
        <button onClick={onCopy}>
          {copied ? <Check /> : <Copy />} {copied ? 'COPIED' : 'COPY INVITE LINK'}
        </button>
      </div>
      <button className="primary wide" disabled={!full || !isHost} onClick={onStart}>
        {!isHost ? 'WAITING FOR HOST' : full ? 'START GAME' : 'WAITING FOR PLAYER 2'} <Sparkles />
      </button>
      <p className="lobby-note">Each player gets a different secret mission. Keep yours hidden.</p>
    </section>
  )
}

function Battle({
  state,
  self,
  opponent,
  remaining,
  countdown,
  onTouchVector,
}: {
  state: State
  self?: Player
  opponent?: Player
  remaining: number
  countdown: number
  onTouchVector: (x: number, y: number) => void
}) {
  const objective = self?.objective || (self?.id === 'p1' ? 'collect' : 'steal')

  return (
    <section className="battle-wrap">
      <div className="scorebar">
        <div className="score">
          <span className="dot pink-bg" />
          YOU <b>{self?.score || 0}</b>
        </div>
        <div className={`timer ${!countdown && remaining < 10 ? 'urgent' : ''}`}>
          {countdown ? countdown : `0:${String(remaining).padStart(2, '0')}`}
        </div>
        <div className="score right">
          <b>{opponent?.score || 0}</b> THEM <span className="dot green-bg" />
        </div>
      </div>
      <div className="mission-strip">
        <LockKeyhole /> <span>SECRET MISSION</span>
        <strong>{objective === 'collect' ? 'Collect 7 coins' : 'Steal 3 coins'}</strong>
        <small>
          {objective === 'collect' ? `${self?.coins || 0} / 7` : `${self?.stolen || 0} / 3`}
        </small>
      </div>
      <div
        className="arena"
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          const r = e.currentTarget.getBoundingClientRect()
          onTouchVector(
            Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2))),
            Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2))),
          )
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return
          const r = e.currentTarget.getBoundingClientRect()
          onTouchVector(
            Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2))),
            Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2))),
          )
        }}
        onPointerUp={() => onTouchVector(0, 0)}
        onPointerCancel={() => onTouchVector(0, 0)}
      >
        <div className="boundary" />
        {state.coins
          .filter((c) => !c.collectedBy)
          .map((c) => (
            <span key={c.id} className="arena-coin" style={{ left: `${c.x}%`, top: `${c.y}%` }}>
              $
            </span>
          ))}
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
      </div>
      <div className="controls-hint">
        <span>MOVE</span>
        <kbd>W</kbd>
        <kbd>A</kbd>
        <kbd>S</kbd>
        <kbd>D</kbd>
        <span className="touch-hint">or use touch controls</span>
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
  const winner = state.players.find((p) => p.id === state.winner)
  return (
    <section className="panel results">
      <div className="trophy">
        <Trophy />
      </div>
      <p className="eyebrow">ROUND {state.round} COMPLETE</p>
      <h2>{winner ? `${winner.name} takes it.` : 'Total chaos.'}</h2>
      <div className="reveal">
        {state.players.map((p) => (
          <div className="result-row" key={p.id}>
            <div className={`avatar ${p.id === 'p1' ? 'pink' : 'green'}`}>
              {p.id === me ? 'YOU' : 'THEM'}
            </div>
            <div>
              <strong>{p.objective === 'collect' ? 'Collect 7 coins' : 'Steal 3 coins'}</strong>
              <small>
                {p.objective === 'collect'
                  ? `${p.coins} / 7 coins collected`
                  : `${p.stolen} / 3 coins stolen`}
              </small>
            </div>
            <b>
              {(p.objective === 'collect' ? p.coins >= 7 : p.stolen >= 3) ? 'COMPLETE' : 'FAILED'}
            </b>
          </div>
        ))}
      </div>
      <div className="score-summary">
        {state.players.map((p) => (
          <div key={p.id}>
            <small>{p.name}</small>
            <strong>{p.score}</strong>
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
