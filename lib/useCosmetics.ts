'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AVATARS, EMOTES, TRAILS, avatarById, emoteById, trailById } from './config'
import { playSound } from './sound'
import type { AvatarId, EmoteId, TrailId } from './types'

const EMOTE_MS = 1_600
/**
 * Emote SPAM KİLİDİ. Bir emote tetiklendikten sonra bu süre boyunca yeni emote
 * yayınlanmaz. Aksi halde oyuncular butona basılı tutup saniyede onlarca emote
 * yayınlayarak hem rakibin ekranını hem de Realtime kanalını boğuyordu.
 */
const EMOTE_COOLDOWN_MS = 2_500

export type CosmeticsApi = {
  emote: EmoteId
  trail: TrailId
  avatar: AvatarId
  activeEmote: EmoteId | null
  activeGlyph: string | null
  emoteOptions: typeof EMOTES
  trailOptions: typeof TRAILS
  avatarOptions: typeof AVATARS
  trailColor: string
  /** Seçili avatarın glifi (UI'da doğrudan gösterilir). */
  avatarGlyph: string
  /** Emote spam kilidi aktif mi? (buton disabled göstergesi için) */
  emoteOnCooldown: boolean
  setEmote: (id: EmoteId) => void
  setTrail: (id: TrailId) => void
  setAvatar: (id: AvatarId) => void
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
  initial: { emote?: EmoteId; trail?: TrailId; avatar?: AvatarId },
  onPersist?: (input: { emote?: EmoteId; trail?: TrailId; avatar?: AvatarId }) => void,
  onBroadcast?: (id: EmoteId) => void,
  /** İz (trail) seçimi değiştiğinde rakibe yayınlamak için. */
  onBroadcastTrail?: (id: TrailId) => void,
  /** Avatar seçimi değiştiğinde rakibe yayınlamak için. */
  onBroadcastAvatar?: (id: AvatarId) => void,
): CosmeticsApi => {
  const [emoteOverride, setEmoteState] = useState<EmoteId | null>(null)
  const [trailOverride, setTrailState] = useState<TrailId | null>(null)
  const [avatarOverride, setAvatarState] = useState<AvatarId | null>(null)
  const [activeEmote, setActiveEmote] = useState<EmoteId | null>(null)
  const [emoteOnCooldown, setEmoteOnCooldown] = useState(false)
  const timer = useRef<number | null>(null)
  // Emote spam kilidi: son tetikleme zamanı + cooldown zamanlayıcısı.
  const lastEmoteAt = useRef(0)
  const cooldownTimer = useRef<number | null>(null)

  // Callback'leri ref'te tutarız. `useDuoChaos` bu hook'a HER render'da yeni
  // kimlikli inline arrow fonksiyonlar geçirir (onPersist/onBroadcast/
  // onBroadcastTrail). Bunları doğrudan `useCallback` bağımlılığına koyarsak
  // `setEmote`/`setTrail`/`triggerEmote` her render'da yeni kimlik kazanır ve
  // bu da dönüş nesnesinin memoize edilmesini boşa çıkarır. Ref üzerinden
  // okumak, callback'lerin kimliğini KARARLI tutar.
  const onPersistRef = useRef(onPersist)
  const onBroadcastRef = useRef(onBroadcast)
  const onBroadcastTrailRef = useRef(onBroadcastTrail)
  const onBroadcastAvatarRef = useRef(onBroadcastAvatar)
  useEffect(() => {
    onPersistRef.current = onPersist
    onBroadcastRef.current = onBroadcast
    onBroadcastTrailRef.current = onBroadcastTrail
    onBroadcastAvatarRef.current = onBroadcastAvatar
  }, [onPersist, onBroadcast, onBroadcastTrail, onBroadcastAvatar])

  // Sunucudan gelen kozmetikler varsayılan; yerel seçim onu geçersiz kılar.
  // Sunucu, seçim yapılmamışsa boş string ('') döndürür; bunu "ayarlanmamış"
  // sayıp varsayılana düşeriz (aksi halde `emoteById('')` null döner ve
  // emote glifi hiç görünmez).
  const emote = emoteOverride || initial.emote || 'wave'
  const trail = trailOverride || initial.trail || 'spark'
  const avatar = avatarOverride || initial.avatar || 'rabbit'

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
      if (cooldownTimer.current) window.clearTimeout(cooldownTimer.current)
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

  const setAvatar = useCallback((id: AvatarId) => {
    setAvatarState(id)
    onPersistRef.current?.({ avatar: id })
    // Rakibe de bildir; o da bizim hayvan yüzümüzü görsün.
    onBroadcastAvatarRef.current?.(id)
  }, [])

  const triggerEmote = useCallback(
    (id?: EmoteId) => {
      // SPAM KİLİDİ: Cooldown dolmadan yeni emote tetiklenmez/yayınlanmaz.
      // Yerel görsel de tekrarlanmaz; böylece butona basılı tutmak işe yaramaz.
      const now = Date.now()
      if (now - lastEmoteAt.current < EMOTE_COOLDOWN_MS) return
      lastEmoteAt.current = now
      setEmoteOnCooldown(true)
      if (cooldownTimer.current) window.clearTimeout(cooldownTimer.current)
      cooldownTimer.current = window.setTimeout(
        () => setEmoteOnCooldown(false),
        EMOTE_COOLDOWN_MS,
      )
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
      avatar,
      activeEmote,
      activeGlyph: emoteById(activeEmote)?.glyph ?? null,
      emoteOptions: EMOTES,
      trailOptions: TRAILS,
      avatarOptions: AVATARS,
      trailColor: trailById(trail).color,
      avatarGlyph: avatarById(avatar)?.glyph ?? '🐰',
      emoteOnCooldown,
      setEmote,
      setTrail,
      setAvatar,
      triggerEmote,
      showRemoteEmote,
    }),
    [
      emote,
      trail,
      avatar,
      activeEmote,
      emoteOnCooldown,
      setEmote,
      setTrail,
      setAvatar,
      triggerEmote,
      showRemoteEmote,
    ],
  )
}
