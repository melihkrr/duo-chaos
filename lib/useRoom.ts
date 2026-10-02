'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSupabase, hasSupabase, rpc } from './supabase'
import { computeBackoffDelay, DEFAULT_RETRY_POLICY } from './retry'

/**
 * Oda durumu.
 *
 *   * `idle`       — oda yok.
 *   * `connecting` — ilk bağlantı kuruluyor.
 *   * `live`       — kanal abone ve sağlıklı.
 *   * `recovering` — kanal koptu, OTOMATİK yeniden bağlanma sürüyor. Kullanıcıya
 *                    "Reconnecting…" gösterilir ama oyun durdurulmaz; yerel
 *                    hareket devam eder ve bağlantı gelince uzlaştırma yapılır.
 *   * `error`      — kalıcı hata (yeniden bağlanma denemeleri tükendi).
 */
export type RoomStatus = 'idle' | 'connecting' | 'live' | 'recovering' | 'error'

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
  /**
   * KANAL YENİDEN BAĞLANDIĞINDA çağrılacak işleyiciyi kaydeder.
   *
   * Kök sorun: Realtime kanalı koptuğunda (CHANNEL_ERROR/TIMED_OUT) eski kod
   * yalnızca `status='error'` yazıp duruyordu; hiçbir yeniden bağlanma veya
   * uzlaştırma yapılmıyordu. İstemci bir sonraki rastgele Realtime olayına
   * bağımlı kalıyordu → "rakip dondu / skor güncellenmedi" hataları.
   *
   * Çözüm: Kanal otomatik yeniden abone olur; HER başarılı (yeniden) abonelikte
   * bu işleyiciler çağrılır. `useDuoChaos` burada `duo_public_state` çekip
   * otoriter durumu uzlaştırır. Böylece kopma sonrası durum KENDİLİĞİNDEN
   * yakınsar; rastgele bir olaya bağımlı değildir.
   */
  onReconnect: (handler: () => void) => () => void
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
  // HİDRASYON GÜVENLİĞİ: `readName()` localStorage okur; sunucuda boş döner.
  // İlk render'da daima boş başlarız (sunucuyla birebir aynı) ve gerçek adı
  // yalnızca mount sonrası yükleriz. Aksi halde isim input'u sunucu/istemci
  // arasında farklı olur ve React #418 (metin uyuşmazlığı) oluşur.
  const [name, setNameState] = useState<string>('')
  const [status, setStatus] = useState<RoomStatus>('idle')
  const [opponentPresent, setOpponentPresent] = useState(false)
  const [presenceReady, setPresenceReady] = useState(false)
  const hydratedRef = useRef(false)

  const channelRef = useRef<ReturnType<NonNullable<ReturnType<typeof getSupabase>>['channel']> | null>(null)
  const handlers = useRef<Map<string, Set<(payload: unknown) => void>>>(new Map())
  const codeRef = useRef<string | null>(null)
  const nameRef = useRef<string>(name)
  // `disconnect` boş bağımlılıkla memoize edildiği için güncel slot'u bir
  // ref üzerinden okuruz (leave broadcast'inde `by` alanı için gerekli).
  const playerIdRef = useRef<'p1' | 'p2'>(playerId)

  // YENİDEN BAĞLANMA ALTYAPISI.
  //
  // Kanal koptuğunda (CHANNEL_ERROR/TIMED_OUT) otomatik yeniden abone oluruz.
  // `reconnectHandlers` — başarılı her (yeniden) abonelikte çağrılan uzlaştırma
  // işleyicileri (bkz. `onReconnect`). `reconnectTimer` — bekleyen yeniden
  // bağlanma zamanlayıcısı. `reconnectAttempt` — üstel geri çekilme sayacı.
  // `intentionalCloseRef` — `disconnect()` çağrıldığında yeniden bağlanmayı
  // DURDURUR (kasıtlı çıkışta sonsuz yeniden bağlanma olmaz).
  const reconnectHandlers = useRef<Set<() => void>>(new Set())
  const reconnectTimer = useRef<number>(0)
  const reconnectAttempt = useRef(0)
  const intentionalCloseRef = useRef(false)
  // Yeniden bağlanma parametrelerini (kod/slot/token/ad) saklarız; kanal
  // koptuğunda aynı parametrelerle yeniden abone oluruz.
  const connectParamsRef = useRef<{
    code: string
    playerId: 'p1' | 'p2'
    token?: string
    name?: string
  } | null>(null)

  useEffect(() => {
    codeRef.current = code
  }, [code])

  useEffect(() => {
    nameRef.current = name
  }, [name])

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  // HİDRASYON: kayıtlı adı YALNIZCA mount sonrası yükleriz (bkz. yukarıdaki
  // `name` state açıklaması). İlk render sunucuyla aynı (boş) kaldığı için
  // hydration uyuşur.
  //
  // NOT: setState'i mikro-görev (setTimeout 0) içinde yaparız; efekt
  // gövdesinde senkron setState lint kuralı (`react-hooks/set-state-in-effect`)
  // tarafından yasaklanmıştır.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const id = window.setTimeout(() => {
      const saved = readName()
      if (saved) setNameState(saved)
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  const disconnect = useCallback(async () => {
    // Kasıtlı kapanış: yeniden bağlanma döngüsünü DURDUR. Aksi halde
    // `leaveGame` sonrası kanal koptu sanılıp sonsuz yeniden bağlanma olurdu.
    intentionalCloseRef.current = true
    if (reconnectTimer.current) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = 0
    }
    reconnectAttempt.current = 0
    connectParamsRef.current = null
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

  /**
   * Kanalı açar ve abone olur. `isReconnect` true ise bu bir OTOMATİK yeniden
   * bağlanma denemesidir: başarıda uzlaştırma işleyicileri çağrılır ve durum
   * `live`'a döner; başarısızlıkta üstel geri çekilmeli olarak yeniden denenir.
   *
   * Kök sorun: Eski kod kopmada yalnızca `status='error'` yazıp duruyordu.
   * Artık kanal kendini otomatik toparlar; kullanıcı sayfayı YENİLEMEK zorunda
   * kalmaz.
   */
  // `openChannel` KENDİ KENDİNİ yeniden çağırabilmelidir (kopmada zamanlayıcı
  // içinden). React Compiler kuralı (`react-hooks/immutability`) bir hook
  // dönüşünü ref'e atamayı yasakladığı için, uygulamayı `useCallback` yerine
  // bir ref içinde tutarız. Fonksiyon yalnızca kararlı ref'lere/setter'lara
  // dokunur; bu yüzden kimliğinin sabit olması güvenlidir.
  const openChannelRef = useRef<
    | ((params: { code: string; playerId: 'p1' | 'p2'; token?: string; name?: string }, isReconnect: boolean) => Promise<void>)
    | null
  >(null)

  const openChannel = useCallback(
    async (params: { code: string; playerId: 'p1' | 'p2'; token?: string; name?: string }, isReconnect: boolean) => {
      const supabase = getSupabase()
      if (!supabase) {
        setStatus('live')
        return
      }
      const { code: normalized, playerId: slot, name: resolvedName } = params

      if (!isReconnect) setStatus('connecting')
      // Yeni kanal kurulurken presence bilgisi SIFIRLANIR. İlk `presence sync`
      // gelene kadar `presenceReady === false` kalır; bu sayede "henüz
      // bilmiyoruz" durumu "rakip yok" sanılmaz.
      setPresenceReady(false)
      setOpponentPresent(false)
      if (channelRef.current) await supabase.removeChannel(channelRef.current)

      const channel = supabase.channel(`duo-room-${normalized}`, {
        config: { presence: { key: slot }, broadcast: { self: false } },
      })

      channel.on('broadcast', { event: '*' }, ({ event, payload }) => {
        const set = handlers.current.get(event)
        if (!set) return
        set.forEach((handler) => handler(payload))
      })

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const keys = Object.keys(state)
        setOpponentPresent(keys.some((key) => key !== slot))
        // İlk senkron tamamlandı: artık `opponentPresent` GÜVENİLİR.
        setPresenceReady(true)
      })

      await new Promise<void>((resolve) => {
        void channel.subscribe((next) => {
          if (next === 'SUBSCRIBED') {
            void channel.track({ player: slot, at: Date.now() })
            // Kendi adımızı hemen yayınla; rakip kanala bağlandığında adımızı
            // görsün (yalnızca yeniden adlandırmayı beklemesin).
            if (resolvedName) {
              void channel.send({
                type: 'broadcast',
                event: 'name',
                payload: { by: slot, name: resolvedName },
              })
            }
            channelRef.current = channel
            reconnectAttempt.current = 0
            setStatus('live')
            // UZLAŞTIRMA: (Yeniden) bağlandığımızda otoriter durumu çek.
            // Böylece kopma sırasında kaçan olaylar telafi edilir ve iki
            // istemci yakınsar — rastgele bir sonraki olaya bağımlı değiliz.
            reconnectHandlers.current.forEach((handler) => {
              try {
                handler()
              } catch {
                /* uzlaştırma hatası bağlantıyı etkilemez */
              }
            })
            resolve()
          } else if (next === 'CHANNEL_ERROR' || next === 'TIMED_OUT') {
            // KOPMA: otomatik yeniden bağlanma planla (kasıtlı kapanış değilse).
            if (intentionalCloseRef.current) {
              setStatus('idle')
              resolve()
              return
            }
            setStatus('recovering')
            const attempt = reconnectAttempt.current + 1
            reconnectAttempt.current = attempt
            const delay = computeBackoffDelay(attempt, DEFAULT_RETRY_POLICY)
            if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
            reconnectTimer.current = window.setTimeout(() => {
              reconnectTimer.current = 0
              if (intentionalCloseRef.current) return
              const current = connectParamsRef.current
              if (!current) return
              void openChannelRef.current?.(current, true)
            }, delay)
            resolve()
          }
        })
      })
    },
    [],
  )

  // Uygulamayı ref'e bağla (yalnızca bir kez; kimlik sabittir).
  useEffect(() => {
    openChannelRef.current = openChannel
  }, [openChannel])

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
      // Yeni bağlantı: kasıtlı-kapanış bayrağını temizle ve parametreleri sakla
      // ki kopmada aynı parametrelerle otomatik yeniden bağlanabilelim.
      intentionalCloseRef.current = false
      reconnectAttempt.current = 0
      const params = { code: normalized, playerId: nextPlayer, token: nextToken, name: resolvedName }
      connectParamsRef.current = params
      await openChannel(params, false)
    },
    [openChannel],
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

  /**
   * Kanal (yeniden) abone olduğunda çağrılacak uzlaştırma işleyicisini kaydeder.
   * `useDuoChaos` burada `duo_public_state` çekip otoriter durumu uygular.
   */
  const onReconnect = useCallback((handler: () => void) => {
    reconnectHandlers.current.add(handler)
    return () => {
      reconnectHandlers.current.delete(handler)
    }
  }, [])

  useEffect(
    () => () => {
      void disconnect()
    },
    [disconnect],
  )

  // KRİTİK: Dönüş değeri MEMOIZE edilir.
  //
  // Kök sorun: Bu nesne her render'da YENİ bir kimlik taşıyordu. `useDuoChaos`
  // içindeki birçok effect/callback `room`'u bağımlılık olarak listeliyor
  // (duo_tick interval'i, trail heartbeat, next-ready/rematch heartbeat,
  // realtime işleyici aboneliği, publishMove...). `room` her render'da
  // değiştiği için bu effect'ler HER render'da sökülüp yeniden kuruluyor ve
  // interval'ler 1 sn / 1.5 sn / 3 sn'ye ulaşmadan sıfırlanıyordu → heartbeat
  // HİÇ ateşlenmiyordu. Bu da iki kritik hataya yol açıyordu:
  //   1) Rakip hareketi laglı/donuk görünüyordu (move broadcast/heartbeat
  //      kararsız).
  //   2) İki oyuncu da "Next Round"a bastığı halde el sıkışma tamamlanmıyor,
  //      her iki istemci de "Waiting for your rival to accept…" ekranında
  //      takılı kalıyordu.
  //
  // Çözüm: Nesneyi `useMemo` ile sararız. Tüm alanlar ya kararlı (useCallback
  // ile memoize edilmiş fonksiyonlar) ya da ilkel değerlerdir; bu yüzden
  // kimlik yalnızca GERÇEK bir değer değiştiğinde (code/playerId/token/name/
  // status/opponentPresent/presenceReady) değişir. Böylece effect'ler kararlı
  // kalır ve interval'ler gerçekten periyodik çalışır.
  return useMemo<RoomApi>(
    () => ({
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
      onReconnect,
    }),
    [
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
      onReconnect,
    ],
  )
}
