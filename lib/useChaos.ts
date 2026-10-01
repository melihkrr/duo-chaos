'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CHAOS_EVENTS } from './config'
import { playSound } from './sound'
import type { ChaosEvent } from './types'

export type ChaosApi = {
  event: ChaosEvent | null
  endsAt: number
  secondsLeft: number
  /** Sunucudan gelen chaos bilgisini uygular. */
  sync: (input: { id?: string; endsAt?: number }) => void
  clear: () => void
}

const byId = (id?: string): ChaosEvent | null =>
  CHAOS_EVENTS.find((item) => item.id === id) ?? null

/**
 * Sunucu otoriteli chaos olayları.
 * Client artık olay üretmez; sadece `duo_tick`/`duo_public_state`'ten geleni gösterir.
 */
export const useChaos = (): ChaosApi => {
  const [event, setEvent] = useState<ChaosEvent | null>(null)
  const [endsAt, setEndsAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const lastId = useRef<string | null>(null)

  // Sayaç yalnızca canlı bir chaos olayı varken çalışır.
  const ticking = event !== null && endsAt > 0 && now < endsAt

  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [ticking])

  const sync = useCallback((input: { id?: string; endsAt?: number }) => {
    const next = byId(input.id)
    if (next && next.id !== lastId.current) {
      lastId.current = next.id
      playSound('chaos')
    }
    if (!next) lastId.current = null
    setEvent(next)
    if (typeof input.endsAt === 'number') setEndsAt(input.endsAt)
  }, [])

  const clear = useCallback(() => {
    lastId.current = null
    setEvent(null)
    setEndsAt(0)
  }, [])

  // Süre dolduysa efekt içinde setState yapmak yerine türetilmiş değer kullan.
  const expired = Boolean(event && endsAt > 0 && now >= endsAt)
  const liveEvent = expired ? null : event
  const secondsLeft =
    liveEvent && endsAt > 0 ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0

  // KRİTİK: Dönüş nesnesi MEMOIZE edilir. `useDuoChaos` içindeki savaş yoklama
  // effect'i `chaos`'u bağımlılık olarak listeler. Nesne her render'da yeni
  // kimlik taşırsa yoklama interval'i (1 sn) her render'da sıfırlanır ve sunucu
  // snapshot'ı HİÇ çekilemez → rakip konumu/skoru bayatlar ("hareket laglı /
  // donuk"). `sync`/`clear` zaten kararlı; kimlik yalnızca gerçek değer
  // değişiminde değişir.
  return useMemo<ChaosApi>(
    () => ({ event: liveEvent, endsAt, secondsLeft, sync, clear }),
    [liveEvent, endsAt, secondsLeft, sync, clear],
  )
}
