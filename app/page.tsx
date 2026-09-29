'use client'

import { useEffect, useRef, useState } from 'react'
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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null

const spawnCoins = () =>
  Array.from({ length: 14 }, (_, i) => ({
    id: i,
    x: 8 + ((i * 31) % 84),
    y: 12 + ((i * 47) % 76),
  }))

const newPlayer = (id: string, name: string, objective: 'collect' | 'steal'): Player => ({
  id,
  name,
  x: id === 'p1' ? 18 : 82,
  y: 50,
  coins: 0,
  stolen: 0,
  score: 0,
  objective,
  rematch: false,
})

const initialState: State = {
  phase: 'lobby',
  players: [],
  coins: spawnCoins(),
  endsAt: 0,
  countdownEndsAt: 0,
  round: 1,
}

/** Map server player ids to local p1/p2 and keep optimistic local position for the current player. */
function normalizePlayers(
  rawPlayers: Player[] | undefined,
  meId: string,
  phase: Phase,
  localPos: { x: number; y: number },
): Player[] {
  const list = rawPlayers || []
  return list.map((player) => {
    let mappedId = player.id
    if (player.id === 'me') mappedId = meId
    else if (player.id === 'opponent' || player.id === 'other' || player.id === 'them') {
      mappedId = meId === 'p1' ? 'p2' : 'p1'
    }
    // If server already sent p1/p2, keep as-is
    const isMe = mappedId === meId || player.id === 'me'
    return {
      ...player,
      id: mappedId,
      ...(isMe && phase === 'battle' ? { x: localPos.x, y: localPos.y } : {}),
    }
  })
}

export default function Page() {
  const [phase, setPhase] = useState<Phase>('home')
  const [room, setRoom] = useState('')
  const [copied, setCopied] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const [state, setState] = useState<State>(initialState)
  const [me, setMe] = useState('p1')
  const [notice, setNotice] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [, setClock] = useState(0)

  const channelRef = useRef<RealtimeChannel | null>(null)
  const stateRef = useRef(state)
  const meRef = useRef(me)
  const keys = useRef(new Set<string>())
  const touchVector = useRef({ x: 0, y: 0 })
  const tokenRef = useRef('')
  const codeRef = useRef('')
  const refreshInFlight = useRef(false)
  const refreshFailures = useRef(0)
  const fallbackDeadline = useRef(0)
  const localPosition = useRef({ x: 18, y: 50 })
  const phaseRef = useRef(phase)
  const transitionInFlight = useRef(false)

  function getToken() {
    const storageKey = `duo-chaos-token:${codeRef.current}`
    if (!tokenRef.current) {
      tokenRef.current = sessionStorage.getItem(storageKey) || crypto.randomUUID()
    }
    sessionStorage.setItem(storageKey, tokenRef.current)
    return tokenRef.current
  }

  async function refreshAuthoritative(code = codeRef.current) {
    if (!supabase || !code || refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const { data, error } = await supabase.rpc('duo_public_state', {
        p_code: code,
        p_token: getToken(),
      })
      if (error) {
        refreshFailures.current += 1
        if (error.message.includes('room_not_found')) {
          setNotice('That room has expired or does not exist.')
        } else if (error.message.includes('not_a_player')) {
          setNotice('This browser is not registered in that room. Reopen the invite link.')
        } else if (refreshFailures.current >= 3) {
          setNotice('Connection interrupted. Retrying automatically…')
        }
        return
      }
      refreshFailures.current = 0
      const raw = data as State & { players?: Player[] }
      const normalizedPhase = raw.phase
      const now = Date.now()
      const serverEndsAt = Number(raw.endsAt) || 0
      const serverCountdownEndsAt = Number(raw.countdownEndsAt) || 0

      // Never extend an expired server deadline on the client.
      if (normalizedPhase === 'battle' && serverEndsAt <= 0) {
        raw.endsAt = now + 30000
      }
      if (normalizedPhase === 'countdown' && serverCountdownEndsAt <= 0) {
        raw.countdownEndsAt = now + 3000
      }

      const next: State = {
        ...raw,
        players: normalizePlayers(raw.players, meRef.current, normalizedPhase, localPosition.current),
      }

      if (next.phase !== phaseRef.current) fallbackDeadline.current = 0
      setState(next)
      setPhase(next.phase)
      if (notice === 'Connection interrupted. Retrying automatically…') setNotice('')
    } finally {
      refreshInFlight.current = false
    }
  }

  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    meRef.current = me
  }, [me])
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // Keyboard listeners + deep-link restore
  useEffect(() => {
    const code = location.pathname.split('/play/')[1]?.split('?')[0]
    if (code) {
      const normalizedCode = code.toUpperCase()
      const savedToken = sessionStorage.getItem(`duo-chaos-token:${normalizedCode}`)
      if (savedToken) {
        void restoreRoom(normalizedCode, savedToken)
      } else {
        void joinRoom(normalizedCode)
      }
    }

    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        e.preventDefault()
      }
      keys.current.add(key)
    }
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.key.toLowerCase())
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      channelRef.current?.unsubscribe()
    }
  }, [])

  // Movement loop — always keeps scheduling frames while phase is battle
  useEffect(() => {
    if (phase !== 'battle') return

    let rafId = 0
    let lastSentAt = 0
    let lastActionAt = 0
    let lastFrameTime = performance.now()
    let actionInFlight = false

    // ~units per second (percentage of arena). Tuned for responsive feel.
    const SPEED = 28

    const tick = (now: number) => {
      // Keep the loop alive for the lifetime of this effect; only act while still in battle.
      rafId = requestAnimationFrame(tick)

      if (phaseRef.current !== 'battle' || stateRef.current.phase !== 'battle') return

      const dt = Math.min(0.05, (now - lastFrameTime) / 1000) // cap at 50ms
      lastFrameTime = now

      const up = keys.current.has('w') || keys.current.has('arrowup')
      const down = keys.current.has('s') || keys.current.has('arrowdown')
      const left = keys.current.has('a') || keys.current.has('arrowleft')
      const right = keys.current.has('d') || keys.current.has('arrowright')
      const touch = touchVector.current

      const dx = (right ? 1 : 0) - (left ? 1 : 0) + touch.x
      const dy = (down ? 1 : 0) - (up ? 1 : 0) + touch.y

      if (dx || dy) {
        const length = Math.hypot(dx, dy) || 1
        const step = SPEED * dt
        const x = Math.max(5, Math.min(95, localPosition.current.x + (dx / length) * step))
        const y = Math.max(7, Math.min(93, localPosition.current.y + (dy / length) * step))
        localPosition.current = { x, y }

        // Optimistic local update every frame for smooth movement
        setState((previous) => ({
          ...previous,
          players: previous.players.map((item) =>
            item.id === meRef.current ? { ...item, x, y } : item,
          ),
        }))

        // Throttle network writes
        if (now - lastSentAt >= 40) {
          lastSentAt = now
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

      // Collect / steal actions
      if (supabase && now - lastActionAt >= 140 && !actionInFlight) {
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
  }, [phase])

  // Periodic authoritative sync during battle
  useEffect(() => {
    if (phase !== 'battle') return
    const reconcile = window.setInterval(() => {
      void refreshAuthoritative()
    }, 500)
    return () => window.clearInterval(reconcile)
  }, [phase])

  // General phase sync
  useEffect(() => {
    if (!codeRef.current || phase === 'home') return
    const interval =
      phase === 'lobby' ? 500 : phase === 'countdown' ? 450 : phase === 'battle' ? 1400 : 1200
    const sync = window.setInterval(() => {
      void refreshAuthoritative()
    }, interval)
    return () => window.clearInterval(sync)
  }, [phase, room])

  // Clock for timer UI
  useEffect(() => {
    if (!['countdown', 'battle'].includes(phase)) return
    const repaint = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(repaint)
  }, [phase])

  // Client-side fallback for round end when server deadline is missing
  useEffect(() => {
    if (!['countdown', 'battle'].includes(phase)) {
      fallbackDeadline.current = 0
      return
    }
    if (!fallbackDeadline.current) {
      fallbackDeadline.current = Date.now() + (phase === 'countdown' ? 3000 : 30000)
    }
    const timer = window.setInterval(() => {
      const s = stateRef.current
      const deadline =
        s.phase === 'countdown'
          ? s.countdownEndsAt || fallbackDeadline.current
          : s.endsAt || fallbackDeadline.current
      if (deadline > 0 && Date.now() >= deadline) {
        void finishRound()
      }
    }, 100)
    return () => clearInterval(timer)
  }, [phase])

  async function connect(code: string, playerId: 'p1' | 'p2') {
    const normalizedCode = code.trim().toUpperCase()
    setRoom(normalizedCode)
    codeRef.current = normalizedCode
    setMe(playerId)
    localPosition.current = playerId === 'p1' ? { x: 18, y: 50 } : { x: 82, y: 50 }
    setPhase('lobby')
    getToken()

    if (!supabase) {
      setNotice('Supabase is not configured.')
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

  async function subscribeToRoom(normalizedCode: string) {
    if (!supabase) return false
    channelRef.current?.unsubscribe()
    const channel = supabase.channel(`duo-chaos:${normalizedCode}`)
    channel.on('broadcast', { event: 'refresh' }, () => void refreshAuthoritative(normalizedCode))
    await channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setNotice((value) =>
          value === 'Realtime is reconnecting. The room is still active.' ? '' : value,
        )
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setNotice('Realtime is reconnecting. The room is still active.')
      }
    })
    channelRef.current = channel
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

    const { data, error } = await supabase.rpc('duo_public_state', {
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
    setMe(slot === 1 ? 'p1' : 'p2')
    localPosition.current = slot === 1 ? { x: 18, y: 50 } : { x: 82, y: 50 }
    await subscribeToRoom(normalizedCode)
    await refreshAuthoritative(normalizedCode)
  }

  async function createRoom() {
    if (!supabase) {
      setNotice('Supabase is not configured.')
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
    else await refreshAuthoritative()
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

  const self = state.players.find((p) => p.id === me)
  const opponent = state.players.find((p) => p.id !== me)
  const battleDeadline = state.endsAt || (state.phase === 'battle' ? fallbackDeadline.current : 0)
  const countdownDeadline =
    state.countdownEndsAt || (state.phase === 'countdown' ? fallbackDeadline.current : 0)
  const remaining =
    phase === 'battle' ? Math.max(0, Math.ceil((battleDeadline - Date.now()) / 1000)) : 30
  const countdown =
    phase === 'countdown' ? Math.max(1, Math.ceil((countdownDeadline - Date.now()) / 1000)) : 0

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
            onClick={() => setSoundOn((value) => !value)}
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
            <p>
              Your room will stay open for the other player, but this match will end for you.
            </p>
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
            />
            <button
              className="secondary"
              disabled={code.length !== 6}
              onClick={() => onJoin(code)}
            >
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
        {!isHost ? 'WAITING FOR HOST' : full ? 'START GAME' : 'WAITING FOR PLAYER 2'}{' '}
        <Sparkles />
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
  const objective =
    self?.objective || (self?.id === 'p1' ? 'collect' : 'steal')

  return (
    <section className="battle-wrap">
      <div className="scorebar">
        <div className="score">
          <span className="dot pink-bg" />
          YOU <b>{self?.score || 0}</b>
        </div>
        <div className={`timer ${remaining < 10 ? 'urgent' : ''}`}>
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
          {objective === 'collect'
            ? `${self?.coins || 0} / 7`
            : `${self?.stolen || 0} / 3`}
        </small>
      </div>
      <div
        className="arena"
        onPointerDown={(e) => {
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
            <span
              key={c.id}
              className="arena-coin"
              style={{ left: `${c.x}%`, top: `${c.y}%` }}
            >
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
              <strong>
                {p.objective === 'collect' ? 'Collect 7 coins' : 'Steal 3 coins'}
              </strong>
              <small>
                {p.objective === 'collect'
                  ? `${p.coins} / 7 coins collected`
                  : `${p.stolen} / 3 coins stolen`}
              </small>
            </div>
            <b>
              {(p.objective === 'collect' ? p.coins >= 7 : p.stolen >= 3)
                ? 'COMPLETE'
                : 'FAILED'}
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
        {state.players.find((p) => p.id === me)?.rematch
          ? 'WAITING FOR OPPONENT'
          : 'REMATCH'}{' '}
        <Zap />
      </button>
      <button className="text-button" onClick={onLeave}>
        LEAVE GAME
      </button>
    </section>
  )
}
