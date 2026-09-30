'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

  const setEmote = useCallback(
    (id: EmoteId) => {
      setEmoteState(id)
      onPersist?.({ emote: id })
    },
    [onPersist],
  )

  const setTrail = useCallback(
    (id: TrailId) => {
      setTrailState(id)
      onPersist?.({ trail: id })
      // Rakibe de bildir; o da bizim izimizi görsün.
      onBroadcastTrail?.(id)
    },
    [onBroadcastTrail, onPersist],
  )

  const triggerEmote = useCallback(
    (id?: EmoteId) => {
      const chosen = id ?? emote
      flash(chosen)
      onBroadcast?.(chosen)
    },
    [emote, flash, onBroadcast],
  )

  const showRemoteEmote = useCallback(
    (id: EmoteId) => {
      flash(id)
    },
    [flash],
  )

  return {
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
  }
}
