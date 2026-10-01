'use client'

import { AVATARS } from '../../lib/config'
import type { AvatarId } from '../../lib/types'

type Props = {
  /** Şu an seçili avatar. */
  avatar: AvatarId
  /** Oyuncunun seviyesi — kilit hesabı için. */
  level: number
  /** Yeni avatar seçildiğinde çağrılır. */
  onSelect: (id: AvatarId) => void
  /** Kompakt görünüm (lobi içi). */
  compact?: boolean
}

/**
 * Hayvan avatarı seçimi. Seviye kilidi uygulanır; kilitli seçenekler
 * tıklanamaz ve kaçıncı seviyede açılacağı tooltip'te gösterilir.
 */
export function AvatarPicker({ avatar, level, onSelect, compact = false }: Props) {
  return (
    <div className={['avatar-picker', compact ? 'avatar-picker-compact' : ''].filter(Boolean).join(' ')}>
      <div className="avatar-picker-head">
        <span className="cosmetics-label">Your animal</span>
        <small className="muted">Your rival sees this avatar.</small>
      </div>
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
              className={['avatar-chip', active ? 'active' : '', locked ? 'locked' : ''].filter(Boolean).join(' ')}
              disabled={locked}
              title={locked ? `Unlocks at level ${option.minLevel}` : option.label}
              onClick={() => onSelect(option.id)}
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
    </div>
  )
}
