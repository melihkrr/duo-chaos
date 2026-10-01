'use client'

import { useState } from 'react'
import { AVATARS, avatarGlyph } from '../../lib/config'
import { Modal } from '../ui/Modal'
import type { AvatarId } from '../../lib/types'

type Props = {
  /** Şu an seçili avatar. */
  avatar: AvatarId
  /** Oyuncunun seviyesi — kilit hesabı için. */
  level: number
  /** Yeni avatar seçildiğinde çağrılır. */
  onSelect: (id: AvatarId) => void
  /**
   * Tetikleyici yerleşimi:
   *   - `inline` (varsayılan): yuvarlak avatar butonu; isim alanının yanında durur.
   *   - `seat`: lobi koltuğu için daha küçük yuvarlak buton.
   */
  variant?: 'inline' | 'seat'
  /** Erişilebilirlik etiketi (ör. "Change your animal"). */
  label?: string
  /** Tetikleyiciye ek sınıf. */
  className?: string
}

/**
 * Hayvan avatarı seçimi — POPUP deseni.
 *
 * KÖK TASARIM: Eskiden avatar ızgarası (12 hücre) doğrudan ana sayfada ve
 * lobide açık duruyordu; bu hem yer kaplıyor hem de isim alanıyla görsel
 * olarak yarışıyordu. Artık:
 *   - Tetikleyici, seçili hayvanı gösteren YUVARLAK bir butondur.
 *   - Butona (veya resme) tıklanınca erişilebilir bir MODAL açılır ve
 *     kullanıcı hayvanını oradan seçer.
 *   - Seçim yapılınca popup kapanır; kilitli seçenekler tıklanamaz ve
 *     kaçıncı seviyede açılacağı tooltip'te gösterilir.
 *
 * Bu, isim düzenleme deneyimiyle (kalem ikonu → düzenle) tutarlıdır.
 */
export function AvatarPicker({
  avatar,
  level,
  onSelect,
  variant = 'inline',
  label = 'Change your animal',
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  const glyph = avatarGlyph(avatar)

  const choose = (id: AvatarId) => {
    onSelect(id)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        className={['avatar-trigger', variant === 'seat' ? 'avatar-trigger-seat' : '', className]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
      >
        <span className="avatar-trigger-glyph" aria-hidden>
          {glyph}
        </span>
        <span className="avatar-trigger-badge" aria-hidden>
          ✏️
        </span>
      </button>

      <Modal
        open={open}
        title="Choose your animal"
        subtitle="Your rival sees this avatar in the arena."
        onClose={() => setOpen(false)}
      >
        <div className="avatar-grid" role="radiogroup" aria-label="Choose your animal avatar">
          {AVATARS.map((option) => {
            const locked = level < option.minLevel
            const active = avatar === option.id
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={['avatar-chip', active ? 'active' : '', locked ? 'locked' : '']
                  .filter(Boolean)
                  .join(' ')}
                disabled={locked}
                title={locked ? `Unlocks at level ${option.minLevel}` : option.label}
                onClick={() => choose(option.id)}
              >
                <span className="avatar-glyph" aria-hidden>
                  {option.glyph}
                </span>
                <small>{option.label}</small>
                {locked ? (
                  <span className="avatar-lock" aria-hidden>
                    🔒
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </Modal>
    </>
  )
}
