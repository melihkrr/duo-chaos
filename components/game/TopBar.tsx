'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { isMuted, toggleMuted, unlockAudio } from '../../lib/sound'

type Props = {
  code: string | null
  onLeave: () => void
}

/**
 * Üst çubuk. Yalnızca oda kodu (varsa) gösterilir; bağlantı durumu ve
 * bulut/yerel etiketleri kaldırıldı. Oda varken çubuk üstte SABİT (sticky)
 * kalır ve dar ekranlarda düzgün sarar.
 */
export function TopBar({ code, onLeave }: Props) {
  const [muted, setMuted] = useState(() => isMuted())

  return (
    <header className={['topbar', code ? 'topbar-sticky' : ''].filter(Boolean).join(' ')}>
      {/* Marka solda, aksiyonlar (ses/leave) sağda; oda kodu ortada. Üçü aynı
          satıra sığdığında tek satırda kalır. Sığmadığında oda kodu alt
          satıra iner ve ortalanır; marka ile aksiyonlar üstte kalır. */}
      <div className="brand">
        <span className="brand-mark">DC</span>
        <strong>DUO CHAOS</strong>
      </div>

      {code && (
        <div className="topbar-meta">
          <span className="room-code">Room {code}</span>
        </div>
      )}

      <div className="topbar-actions">
        <Button
          variant="ghost"
          className="icon-btn"
          onClick={() => {
            unlockAudio()
            setMuted(toggleMuted())
          }}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🔊'}
        </Button>
        {code && (
          <Button variant="ghost" onClick={onLeave}>
            Leave
          </Button>
        )}
      </div>
    </header>
  )
}
