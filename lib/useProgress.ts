'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { profileForXp, type ProfileProgress } from './config'
import { getSupabase, hasSupabase, rpc } from './supabase'
import type { AvatarId, EmoteId, Progress, TrailId } from './types'

const CLIENT_KEY = 'duo-chaos:client-id'
const LOCAL_KEY = 'duo-chaos:progress'

const readClientId = (): string => {
  if (typeof window === 'undefined') return 'local'
  try {
    const existing = window.localStorage.getItem(CLIENT_KEY)
    if (existing) return existing
    const generated =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    window.localStorage.setItem(CLIENT_KEY, generated)
    return generated
  } catch {
    return 'local'
  }
}

const readLocal = (): Progress | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY)
    return raw ? (JSON.parse(raw) as Progress) : null
  } catch {
    return null
  }
}

const writeLocal = (progress: Progress) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(progress))
  } catch {
    /* yoksay */
  }
}

const blank = (clientId: string): Progress => ({
  clientId,
  xp: 0,
  level: 1,
  title: 'Rookie',
  emote: 'wave',
  trail: 'spark',
  avatar: 'rabbit',
  wins: 0,
  matches: 0,
})

export type ProgressApi = {
  clientId: string
  progress: Progress
  profile: ProfileProgress
  online: boolean
  /** Maç sonucunu sunucuya bildirir ve XP'yi günceller. */
  award: (input: { won: boolean; rounds?: number; missions?: number }) => Promise<void>
  /** Kozmetik seçimini sunucuya kaydeder. */
  setCosmetics: (input: { emote?: EmoteId; trail?: TrailId; avatar?: AvatarId }) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * İlerleme (XP / seviye / ünvan / kozmetik) yönetimi.
 * Supabase varsa sunucu otoritesi; yoksa localStorage'a düşer.
 */
export const useProgress = (): ProgressApi => {
  // HİDRASYON GÜVENLİĞİ: `clientId` ve `progress` localStorage'dan okunur.
  // Sunucuda localStorage yoktur; bu yüzden sunucu render'ı ile istemcinin İLK
  // render'ı AYNI olmalıdır, aksi halde React #418 (metin uyuşmazlığı) oluşur.
  //
  // Çözüm: ilk render'da HER ZAMAN deterministik "boş" değerleri kullanırız
  // (sunucuyla birebir aynı). Gerçek localStorage değerlerini yalnızca mount
  // SONRASI (effect içinde) yükleriz. Böylece hydration eşleşir; ardından
  // değerler sorunsuz şekilde güncellenir.
  const [clientId, setClientId] = useState<string>('local')
  const [progress, setProgress] = useState<Progress>(() => blank('local'))
  const [online, setOnline] = useState(false)
  // localStorage okuması yalnızca bir kez, mount sonrası yapılır.
  const hydratedRef = useRef(false)

  const applyServer = useCallback((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const data = raw as Partial<Progress>
    setProgress((prev) => {
      const next: Progress = {
        ...prev,
        xp: typeof data.xp === 'number' ? data.xp : prev.xp,
        level: typeof data.level === 'number' ? data.level : prev.level,
        title: typeof data.title === 'string' ? data.title : prev.title,
        // Sunucu, seçim yapılmamışsa boş string döndürür; bunu "ayarlanmamış"
        // sayıp mevcut (varsayılan) değeri koruruz.
        emote: typeof data.emote === 'string' && data.emote ? (data.emote as EmoteId) : prev.emote,
        trail: typeof data.trail === 'string' && data.trail ? (data.trail as TrailId) : prev.trail,
        avatar:
          typeof data.avatar === 'string' && data.avatar
            ? (data.avatar as AvatarId)
            : prev.avatar,
        wins: typeof data.wins === 'number' ? data.wins : prev.wins,
        matches: typeof data.matches === 'number' ? data.matches : prev.matches,
      }
      writeLocal(next)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    if (!hasSupabase) return
    // HİDRASYON YARIŞI: `clientId` henüz localStorage'dan çözülmediyse ('local')
    // sunucudan ÇEKMEYİZ. Aksi halde bilinmeyen bir istemci için sunucu
    // varsayılan (seviye 1) döndürür ve bu yanıt, gerçek ilerleme yüklendikten
    // SONRA gelip onu EZEBİLİR ("profil seviyesi 1'de kalıyor, yenileyince
    // düzeliyor" hatası). Gerçek `clientId` çözülünce efekt yeniden çalışır.
    if (clientId === 'local') return
    try {
      const data = await rpc('duo_get_progress', { p_client_id: clientId })
      if (data) {
        applyServer(data)
        setOnline(true)
      }
    } catch {
      setOnline(false)
    }
  }, [applyServer, clientId])

  // HİDRASYON: localStorage'dan gerçek `clientId` ve `progress` değerlerini
  // YALNIZCA mount sonrası yükleriz. İlk render sunucuyla birebir aynı olduğu
  // için hydration uyuşur; ardından bu efekt gerçek değerleri uygular.
  //
  // NOT: setState'i mikro-görev (setTimeout 0) içinde yaparız; efekt
  // gövdesinde senkron setState lint kuralı (`react-hooks/set-state-in-effect`)
  // tarafından yasaklanmıştır.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const id = window.setTimeout(() => {
      const realId = readClientId()
      setClientId(realId)
      const local = readLocal()
      if (local) setProgress((prev) => ({ ...prev, ...local, clientId: realId }))
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    // Mikro-görev: efekt gövdesinde senkron setState'ten kaçın.
    const id = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(id)
  }, [refresh])

  // Realtime: başka sekmede/cihazda ilerleme değişirse yakala.
  //
  // ÖNEMLİ: Supabase `.channel(name)` AYNI isimli kanal zaten varsa onu
  // döndürür. Efekt yeniden çalıştığında (StrictMode çift çağrısı veya
  // `clientId` değişimi) temizlikteki `removeChannel` asenkron olduğundan,
  // ikinci `.channel(...)` hâlâ ABONE (subscribed) kanalı döndürebilir ve
  // ardından `.on('postgres_changes', ...)` çağrısı "cannot add
  // postgres_changes callbacks after subscribe()" hatası verir.
  //
  // Çözüm: (1) kanal adına benzersiz bir sonek ekleyerek her kurulumda YENİ
  // bir kanal oluştururuz; (2) `clientId` henüz çözülmemişken ('local')
  // abone OLMAYIZ; (3) tüm `.on(...)` kayıtları `.subscribe()`'tan ÖNCE
  // zincirlenir.
  useEffect(() => {
    if (clientId === 'local') return
    const supabase = getSupabase()
    if (!supabase) return
    const channelName = `duo-progress-${clientId}-${Math.random().toString(36).slice(2)}`
    const channel = supabase.channel(channelName)
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'duo_progression', filter: `client_id=eq.${clientId}` },
      (payload) => applyServer(payload.new),
    )
    channel.subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [applyServer, clientId])

  const award = useCallback(
    async (input: { won: boolean; rounds?: number; missions?: number }) => {
      if (!hasSupabase) {
        // Offline: yerel olarak XP ekle.
        setProgress((prev) => {
          const gained =
            (input.won ? 120 : 40) + (input.rounds ?? 0) * 25 + (input.missions ?? 0) * 60
          const next = { ...prev, xp: prev.xp + gained, wins: prev.wins + (input.won ? 1 : 0), matches: prev.matches + 1 }
          const profile = profileForXp(next.xp)
          const merged = { ...next, level: profile.level, title: profile.title }
          writeLocal(merged)
          return merged
        })
        return
      }
      try {
        // XP is computed client-side to match the server's p_xp contract.
        const gained =
          (input.won ? 120 : 40) + (input.rounds ?? 0) * 25 + (input.missions ?? 0) * 60
        const data = await rpc('duo_award_progress', {
          p_client_id: clientId,
          p_xp: gained,
        })
        if (data) applyServer(data)
        setOnline(true)
      } catch {
        setOnline(false)
      }
    },
    [applyServer, clientId],
  )

  const setCosmetics = useCallback(
    async (input: { emote?: EmoteId; trail?: TrailId; avatar?: AvatarId }) => {
      setProgress((prev) => {
        const next = { ...prev, ...input }
        writeLocal(next)
        return next
      })
      if (!hasSupabase) return
      try {
        const data = await rpc('duo_set_cosmetics', {
          p_client_id: clientId,
          p_emote: input.emote ?? null,
          p_trail: input.trail ?? null,
          p_avatar: input.avatar ?? null,
        })
        if (data) applyServer(data)
      } catch {
        /* sessizce yoksay */
      }
    },
    [applyServer, clientId],
  )

  // Dönüş nesnesini memoize ederiz. Tüm fonksiyonlar `useCallback` ile
  // kararlıdır; kimlik yalnızca gerçek değerler (progress/online) değişince
  // değişir. Böylece tüketici effect'leri gereksiz yere yeniden kurulmaz.
  return useMemo<ProgressApi>(
    () => ({
      clientId,
      progress,
      profile: profileForXp(progress.xp),
      online,
      award,
      setCosmetics,
      refresh,
    }),
    [clientId, progress, online, award, setCosmetics, refresh],
  )
}
