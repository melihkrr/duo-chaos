'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMOTES, TRAILS, emoteById, trailById } from './config'
import { playSound } from './sound'
import type { EmoteId, TrailId } from './types'

const EMOTE_MS = 1_600

export type CosmeticsApi = {
  emote: EmoteId
  trail: TrailId
  activeEmote: EmoteId | null
  activeGlyph: string | null
  emoteOptions: typeof EMOTES
  trailOptions: typeof TRAILS
  trailColor: string
  setEmote: (id: EmoteId) => void
  setTrail: (id: TrailId) => void
  /** Bir emote tetikler (yerel + yayın için callback). */
  triggerEmote: (id?: EmoteId) => void
  /** Rakibin emote'unu gösterir (yayından geldiğinde). */
  showRemoteEmote: (id: EmoteId) => void
}

/**
 * Kozmetikler: seçili emote/iz + aktif emote animasyonu.
 * Seçim sunucuya `onPersist` ile bildirilir.
 */
export const useCosmetics = (
  initial: { emote?: EmoteId; trail?: TrailId },
  onPersist?: (input: { emote?: EmoteId; trail?: TrailId }) => void,
  onBroadcast?: (id: EmoteId) => void,
  /** İz (trail) seçimi değiştiğinde rakibe yayınlamak için. */
  onBroadcastTrail?: (id: TrailId) => void,
): CosmeticsApi => {
  const [emoteOverride, setEmoteState] = useState<EmoteId | null>(null)
  const [trailOverride, setTrailState] = useState<TrailId | null>(null)
  const [activeEmote, setActiveEmote] = useState<EmoteId | null>(null)
  const timer = useRef<number | null>(null)

  // Callback'leri ref'te tutarız. `useDuoChaos` bu hook'a HER render'da yeni
  // kimlikli inline arrow fonksiyonlar geçirir (onPersist/onBroadcast/
  // onBroadcastTrail). Bunları doğrudan `useCallback` bağımlılığına koyarsak
  // `setEmote`/`setTrail`/`triggerEmote` her render'da yeni kimlik kazanır ve
  // bu da dönüş nesnesinin memoize edilmesini boşa çıkarır. Ref üzerinden
  // okumak, callback'lerin kimliğini KARARLI tutar.
  const onPersistRef = useRef(onPersist)
  const onBroadcastRef = useRef(onBroadcast)
  const onBroadcastTrailRef = useRef(onBroadcastTrail)
  useEffect(() => {
    onPersistRef.current = onPersist
    onBroadcastRef.current = onBroadcast
    onBroadcastTrailRef.current = onBroadcastTrail
  }, [onPersist, onBroadcast, onBroadcastTrail])

  // Sunucudan gelen kozmetikler varsayılan; yerel seçim onu geçersiz kılar.
  // Sunucu, seçim yapılmamışsa boş string ('') döndürür; bunu "ayarlanmamış"
  // sayıp varsayılana düşeriz (aksi halde `emoteById('')` null döner ve
  // emote glifi hiç görünmez).
  const emote = emoteOverride || initial.emote || 'wave'
  const trail = trailOverride || initial.trail || 'spark'

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  const flash = useCallback((id: EmoteId) => {
    setActiveEmote(id)
    playSound('emote')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setActiveEmote(null), EMOTE_MS)
  }, [])

  const setEmote = useCallback((id: EmoteId) => {
    setEmoteState(id)
    onPersistRef.current?.({ emote: id })
  }, [])

  const setTrail = useCallback((id: TrailId) => {
    setTrailState(id)
    onPersistRef.current?.({ trail: id })
    // Rakibe de bildir; o da bizim izimizi görsün.
    onBroadcastTrailRef.current?.(id)
  }, [])

  const triggerEmote = useCallback(
    (id?: EmoteId) => {
      const chosen = id ?? emote
      flash(chosen)
      onBroadcastRef.current?.(chosen)
    },
    [emote, flash],
  )

  const showRemoteEmote = useCallback(
    (id: EmoteId) => {
      flash(id)
    },
    [flash],
  )

  // KRİTİK: Dönüş nesnesi MEMOIZE edilir. `useDuoChaos` içindeki realtime
  // işleyici effect'i `cosmetics`'i bağımlılık olarak listeler. Nesne her
  // render'da yeni kimlik taşırsa işleyiciler HER render'da sökülüp yeniden
  // bağlanır; bu da olay kaybına ve gereksiz abonelik çalkantısına yol açar.
  // Tüm alanlar ya ilkel ya da kararlı (useCallback) fonksiyonlardır.
  return useMemo<CosmeticsApi>(
    () => ({
      emote,
      trail,
      activeEmote,
      activeGlyph: emoteById(activeEmote)?.glyph ?? null,
      emoteOptions: EMOTES,
      trailOptions: TRAILS,
      trailColor: trailById(trail).color,
      setEmote,
      setTrail,
      triggerEmote,
      showRemoteEmote,
    }),
    [emote, trail, activeEmote, setEmote, setTrail, triggerEmote, showRemoteEmote],
  )
}
