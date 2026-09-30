'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SCOUT_CHARGES, SCOUT_COOLDOWN_MS, SCOUT_HINT_TTL_MS } from './config'
import { hasSupabase, rpc } from './supabase'
import type { ScoutHint } from './types'

export type ScoutApi = {
  charges: number
  cooldownLeft: number
  hint: ScoutHint | null
  hintLeft: number
  canScout: boolean
  scout: () => Promise<void>
  /** Sunucu snapshot'ından gelen değerleri uygular. */
  sync: (input: { charges?: number; usedAt?: number; hint?: ScoutHint | null }) => void
  reset: () => void
}

/**
 * Guess/Read mekaniği: rakibin gizli görevi hakkında kısmi ipucu alır.
 * Sunucu otoritesi; client sadece cooldown/TTL sayacını yönetir.
 */
export const useScout = (code: string | null, playerId: 'p1' | 'p2', token: string | null = null): ScoutApi => {
  const [charges, setCharges] = useState(SCOUT_CHARGES)
  const [usedAt, setUsedAt] = useState(0)
  const [hint, setHint] = useState<ScoutHint | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)

  // Sayaç yalnızca aktif bir cooldown veya ipucu TTL'i varken çalışır.
  // Boştayken (home/lobby) hiç render tetiklenmez.
  const cooldownActive = usedAt > 0 && now - usedAt < SCOUT_COOLDOWN_MS
  const hintActive = hint !== null && now - hint.at < SCOUT_HINT_TTL_MS
  const ticking = cooldownActive || hintActive

  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [ticking])

  const cooldownLeft = Math.max(0, SCOUT_COOLDOWN_MS - (now - usedAt))
  const rawHintLeft = hint ? Math.max(0, SCOUT_HINT_TTL_MS - (now - hint.at)) : 0
  // TTL dolduysa efekt içinde setState yapmak yerine türetilmiş değer kullan.
  const liveHint = rawHintLeft > 0 ? hint : null
  const hintLeft = liveHint ? rawHintLeft : 0

  const canScout = charges > 0 && cooldownLeft <= 0 && !pending

  const sync = useCallback(
    (input: { charges?: number; usedAt?: number; hint?: ScoutHint | null }) => {
      if (typeof input.charges === 'number') setCharges(input.charges)
      if (typeof input.usedAt === 'number') setUsedAt(input.usedAt)
      if (input.hint !== undefined) setHint(input.hint)
    },
    [],
  )

  const reset = useCallback(() => {
    setCharges(SCOUT_CHARGES)
    setUsedAt(0)
    setHint(null)
    pendingRef.current = false
    setPending(false)
  }, [])

  const scout = useCallback(async () => {
    if (!code || pendingRef.current) return
    if (charges <= 0 || cooldownLeft > 0) return
    pendingRef.current = true
    setPending(true)
    const at = Date.now()
    // İyimser güncelleme: hak düş, cooldown başlat.
    setCharges((prev) => Math.max(0, prev - 1))
    setUsedAt(at)
    try {
      if (hasSupabase) {
        const data = await rpc<{ charges?: number; hint?: ScoutHint }>('duo_scout', {
          p_code: code,
          p_token: token,
        })
        if (data) {
          if (typeof data.charges === 'number') setCharges(data.charges)
          if (data.hint) setHint({ ...data.hint, at: data.hint.at ?? at })
        }
      } else {
        // Offline: yerel sahte ipucu üret.
        setHint({ kind: 'collect', coinType: 'gold', target: 3, at })
      }
    } catch {
      // Hata: hakkı geri ver.
      setCharges((prev) => Math.min(SCOUT_CHARGES, prev + 1))
      setUsedAt(0)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [charges, code, cooldownLeft, token])

  return { charges, cooldownLeft, hint: liveHint, hintLeft, canScout, scout, sync, reset }
}
