'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSupabase, hasSupabase, rpc } from './supabase'

export type RoomStatus = 'idle' | 'connecting' | 'live' | 'error'

export type RoomApi = {
  code: string | null
  playerId: 'p1' | 'p2'
  token: string | null
  status: RoomStatus
  opponentPresent: boolean
  /** Odaya bağlanır ve realtime kanalı açar. */
  connect: (code: string, playerId: 'p1' | 'p2', token?: string) => Promise<void>
  /** Bağlantıyı kapatır. */
  disconnect: () => Promise<void>
  /** Broadcast olayı yayınlar. */
  broadcast: (event: string, payload: unknown) => void
  /** Sunucu RPC'sini çağırır (kod enjekte edilir). */
  call: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T | null>
  /** Gelen broadcast olaylarını dinler. */
  on: (event: string, handler: (payload: unknown) => void) => () => void
}

const TOKEN_KEY = 'duo-chaos:token'

export const saveToken = (code: string, token: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${TOKEN_KEY}:${code}`, token)
  } catch {
    /* yoksay */
  }
}

export const readToken = (code: string): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(`${TOKEN_KEY}:${code}`)
  } catch {
    return null
  }
}

/**
 * Oda yaşam döngüsü + realtime kanal yönetimi.
 * Tüm oyun RPC'leri bu hook üzerinden `code` enjekte edilerek çağrılır.
 */
export const useRoom = (): RoomApi => {
  const [code, setCode] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<'p1' | 'p2'>('p1')
  const [token, setToken] = useState<string | null>(null)
  const [status, setStatus] = useState<RoomStatus>('idle')
  const [opponentPresent, setOpponentPresent] = useState(false)

  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getSupabase>>['channel']> | null>(null)
  const handlers = useRef<Map<string, Set<(payload: unknown) => void>>>(new Map())
  const codeRef = useRef<string | null>(null)

  useEffect(() => {
    codeRef.current = code
  }, [code])

  const disconnect = useCallback(async () => {
    const supabase = getSupabase()
    if (supabase && channelRef.current) {
      await supabase.removeChannel(channelRef.current)
    }
    channelRef.current = null
    handlers.current.clear()
    setOpponentPresent(false)
    setStatus('idle')
  }, [])

  const connect = useCallback(
    async (nextCode: string, nextPlayer: 'p1' | 'p2', nextToken?: string) => {
      const normalized = nextCode.trim().toUpperCase()
      setCode(normalized)
      setPlayerId(nextPlayer)
      setToken(nextToken ?? null)
      codeRef.current = normalized

      const supabase = getSupabase()
      if (!supabase) {
        // Offline mod: kanal yok, oyun yerel çalışır.
        setStatus('live')
        return
      }

      setStatus('connecting')
      if (channelRef.current) await supabase.removeChannel(channelRef.current)

      const channel = supabase.channel(`duo-room-${normalized}`, {
        config: { presence: { key: nextPlayer }, broadcast: { self: false } },
      })

      channel.on('broadcast', { event: '*' }, ({ event, payload }) => {
        const set = handlers.current.get(event)
        if (!set) return
        set.forEach((handler) => handler(payload))
      })

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const keys = Object.keys(state)
        setOpponentPresent(keys.some((key) => key !== nextPlayer))
      })

      await new Promise<void>((resolve) => {
        void channel.subscribe((next) => {
          if (next === 'SUBSCRIBED') {
            void channel.track({ player: nextPlayer, at: Date.now() })
            setStatus('live')
            resolve()
          } else if (next === 'CHANNEL_ERROR' || next === 'TIMED_OUT') {
            setStatus('error')
            resolve()
          }
        })
      })

      channelRef.current = channel
    },
    [],
  )

  const broadcast = useCallback((event: string, payload: unknown) => {
    const channel = channelRef.current
    if (!channel) return
    void channel.send({ type: 'broadcast', event, payload })
  }, [])

  const call = useCallback(
    async <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T | null> => {
      if (!hasSupabase) return null
      const current = codeRef.current
      return rpc<T>(fn, { p_code: current, ...(args ?? {}) })
    },
    [],
  )

  const on = useCallback((event: string, handler: (payload: unknown) => void) => {
    const set = handlers.current.get(event) ?? new Set()
    set.add(handler)
    handlers.current.set(event, set)
    return () => {
      set.delete(handler)
    }
  }, [])

  useEffect(
    () => () => {
      void disconnect()
    },
    [disconnect],
  )

  return { code, playerId, token, status, opponentPresent, connect, disconnect, broadcast, call, on }
}
