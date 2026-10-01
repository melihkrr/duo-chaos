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
      {/* ÜST SATIR: marka solda, aksiyonlar (ses/leave) sağda. Bu ikisi HER
          ZAMAN aynı satırda kalır (`.topbar-row` içinde `flex-wrap: nowrap`).
          Oda kodu ise ayrı bir kardeş öğedir: üçü birlikte sığıyorsa üst
          satırda ortada durur; sığmıyorsa `flex-basis: 100%` ile ALT satıra
          iner ve ortalanır. Böylece marka ile aksiyonlar asla ayrılmaz. */}
      <div className="topbar-row">
        <div className="brand">
          <span className="brand-mark">DC</span>
          <strong>DUO CHAOS</strong>
        </div>

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
      </div>

      {code && (
        <div className="topbar-meta">
          <span className="room-code">Room {code}</span>
        </div>
      )}
    </header>
  )
}
