'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { profileForXp, type ProfileProgress } from './config'
import { getSupabase, hasSupabase, rpc } from './supabase'
import type { EmoteId, Progress, TrailId } from './types'

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
  setCosmetics: (input: { emote?: EmoteId; trail?: TrailId }) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * İlerleme (XP / seviye / ünvan / kozmetik) yönetimi.
 * Supabase varsa sunucu otoritesi; yoksa localStorage'a düşer.
 */
export const useProgress = (): ProgressApi => {
  const [clientId] = useState<string>(() => readClientId())
  const [progress, setProgress] = useState<Progress>(() => readLocal() ?? blank(readClientId()))
  const [online, setOnline] = useState(false)

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
        wins: typeof data.wins === 'number' ? data.wins : prev.wins,
        matches: typeof data.matches === 'number' ? data.matches : prev.matches,
      }
      writeLocal(next)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    if (!hasSupabase) return
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

  useEffect(() => {
    // Mikro-görev: efekt gövdesinde senkron setState'ten kaçın.
    const id = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(id)
  }, [refresh])

  // Realtime: başka sekmede/cihazda ilerleme değişirse yakala.
  useEffect(() => {
    const supabase = getSupabase()
    if (!supabase) return
    const channel = supabase
      .channel(`duo-progress-${clientId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'duo_progression', filter: `client_id=eq.${clientId}` },
        (payload) => applyServer(payload.new),
      )
      .subscribe()
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
    async (input: { emote?: EmoteId; trail?: TrailId }) => {
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
