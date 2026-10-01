'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSupabase, hasSupabase, rpc } from './supabase'

export type RoomStatus = 'idle' | 'connecting' | 'live' | 'error'

export type RoomApi = {
  code: string | null
  playerId: 'p1' | 'p2'
  token: string | null
  /** Yerel oyuncunun görünen adı. */
  name: string
  status: RoomStatus
  opponentPresent: boolean
  /**
   * Presence senkronizasyonu EN AZ BİR KEZ tamamlandı mı?
   *
   * `opponentPresent === false` tek başına "rakip yok" demek DEĞİLDİR: kanal
   * yeni kurulduğunda ilk `presence sync` gelene kadar bu değer daima
   * `false`'tur. Bu bayrak, "gerçekten senkron olduk ve rakip yok" ile
   * "henüz bilmiyoruz" durumunu ayırt etmemizi sağlar. Aksi halde host, oyunu
   * başlattığı anda (misafirin presence'ı henüz oturmamışken) yanlışlıkla
   * "rakip ayrıldı" sonucuna varıyordu.
   */
  presenceReady: boolean
  /** Odaya bağlanır ve realtime kanalı açar. */
  connect: (code: string, playerId: 'p1' | 'p2', token?: string, name?: string) => Promise<void>
  /** Bağlantıyı kapatır ve oda durumunu temizler. */
  disconnect: () => Promise<void>
  /** Yerel oyuncunun adını değiştirir ve rakiplere yayınlar. */
  setName: (name: string) => void
  /** Broadcast olayı yayınlar. */
  broadcast: (event: string, payload: unknown) => void
  /** Sunucu RPC'sini çağırır (kod enjekte edilir). */
  call: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<T | null>
  /** Gelen broadcast olaylarını dinler. */
  on: (event: string, handler: (payload: unknown) => void) => () => void
}

const TOKEN_KEY = 'duo-chaos:token'
const NAME_KEY = 'duo-chaos:name'

export const saveName = (name: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(NAME_KEY, name)
  } catch {
    /* yoksay */
  }
}

export const readName = (): string => {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

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
  const [name, setNameState] = useState<string>(() => readName())
  const [status, setStatus] = useState<RoomStatus>('idle')
  const [opponentPresent, setOpponentPresent] = useState(false)
  const [presenceReady, setPresenceReady] = useState(false)

  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getSupabase>>['channel']> | null>(null)
  const handlers = useRef<Map<string, Set<(payload: unknown) => void>>>(new Map())
  const codeRef = useRef<string | null>(null)
  const nameRef = useRef<string>(name)
  // `disconnect` boş bağımlılıkla memoize edildiği için güncel slot'u bir
  // ref üzerinden okuruz (leave broadcast'inde `by` alanı için gerekli).
  const playerIdRef = useRef<'p1' | 'p2'>(playerId)

  useEffect(() => {
    codeRef.current = code
  }, [code])

  useEffect(() => {
    nameRef.current = name
  }, [name])

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  const disconnect = useCallback(async () => {
    const supabase = getSupabase()
    if (supabase && channelRef.current) {
      // Rakibe TEMİZ bir "ayrıldım" sinyali gönder. Presence düşüşü güvenilmez
      // (ağ kopması, sekme kapanması) olduğundan, kasıtlı çıkışta açık bir
      // `leave` broadcast'i yayınlarız; karşı taraf "rakip ayrıldı"yı ANINDA ve
      // kesin olarak görür. `self: false` olduğu için kendimize gitmez.
      const channel = channelRef.current
      try {
        await channel.send({
          type: 'broadcast',
          event: 'leave',
          payload: { by: playerIdRef.current },
        })
      } catch {
        /* kanal zaten kapanmış olabilir — yoksay */
      }
      await supabase.removeChannel(channel)
    }
    channelRef.current = null
    handlers.current.clear()
    // Oda durumunu tamamen temizle; aksi halde TopBar/poll eski odaya bağlı kalır.
    codeRef.current = null
    setCode(null)
    setToken(null)
    setOpponentPresent(false)
    setPresenceReady(false)
    setStatus('idle')
  }, [])

  const connect = useCallback(
    async (nextCode: string, nextPlayer: 'p1' | 'p2', nextToken?: string, nextName?: string) => {
      const normalized = nextCode.trim().toUpperCase()
      const resolvedName = (nextName ?? nameRef.current ?? '').trim()
      setCode(normalized)
      setPlayerId(nextPlayer)
      setToken(nextToken ?? null)
      if (resolvedName) {
        setNameState(resolvedName)
        nameRef.current = resolvedName
        saveName(resolvedName)
      }
      codeRef.current = normalized

      const supabase = getSupabase()
      if (!supabase) {
        // Offline mod: kanal yok, oyun yerel çalışır.
        setStatus('live')
        return
      }

      setStatus('connecting')
      // Yeni kanal kurulurken presence bilgisi SIFIRLANIR. İlk `presence sync`
      // gelene kadar `presenceReady === false` kalır; bu sayede "henüz
      // bilmiyoruz" durumu "rakip yok" sanılmaz.
      setPresenceReady(false)
      setOpponentPresent(false)
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
        // İlk senkron tamamlandı: artık `opponentPresent` GÜVENİLİR.
        setPresenceReady(true)
      })

      await new Promise<void>((resolve) => {
        void channel.subscribe((next) => {
          if (next === 'SUBSCRIBED') {
            void channel.track({ player: nextPlayer, at: Date.now() })
            // Kendi adımızı hemen yayınla; rakip kanala bağlandığında adımızı
            // görsün (yalnızca yeniden adlandırmayı beklemesin).
            if (resolvedName) {
              void channel.send({
                type: 'broadcast',
                event: 'name',
                payload: { by: nextPlayer, name: resolvedName },
              })
            }
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

  const setName = useCallback(
    (next: string) => {
      const trimmed = next.trim().slice(0, 16)
      if (!trimmed) return
      setNameState(trimmed)
      nameRef.current = trimmed
      saveName(trimmed)
      // Rakibe yeni adı bildir (kanal varsa).
      const channel = channelRef.current
      if (channel) {
        void channel.send({ type: 'broadcast', event: 'name', payload: { by: playerId, name: trimmed } })
      }
    },
    [playerId],
  )

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

  return {
    code,
    playerId,
    token,
    name,
    status,
    opponentPresent,
    presenceReady,
    connect,
    disconnect,
    setName,
    broadcast,
    call,
    on,
  }
}
