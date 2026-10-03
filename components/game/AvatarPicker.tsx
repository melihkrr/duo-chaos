'use client'

import { useState } from 'react'
import { AVATARS, avatarImage } from '../../lib/config'
import { Modal } from '../ui/Modal'
import type { AvatarId } from '../../lib/types'
import { useI18n } from '../../lib/i18n'

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
  /**
   * Popup arka planı:
   *   - `dim` (varsayılan): koyu + blur'lu (lobi/oyun içi).
   *   - `light`: neredeyse şeffaf (ana sayfa) — sayfa kararmaz.
   */
  backdrop?: 'dim' | 'light'
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
  backdrop = 'dim',
}: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const image = avatarImage(avatar)

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
        aria-label={t(label)}
        title={t(label)}
      >
        <img className="avatar-trigger-glyph" src={image} alt="" aria-hidden draggable={false} />
        <span className="avatar-trigger-badge" aria-hidden>
          ✏️
        </span>
      </button>

      <Modal
        open={open}
        title={t('Choose your animal')}
        subtitle={t('Your rival sees this avatar in the arena.')}
        onClose={() => setOpen(false)}
        backdrop={backdrop}
      >
        <div className="avatar-grid" role="radiogroup" aria-label={t('Choose your animal avatar')}>
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
                title={locked ? t('Unlocks at level {level}', { level: option.minLevel }) : t(option.label)}
                onClick={() => choose(option.id)}
              >
                <img className="avatar-glyph" src={option.image} alt="" aria-hidden draggable={false} />
                <small>{t(option.label)}</small>
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
