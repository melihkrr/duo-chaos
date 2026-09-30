'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { isMuted, toggleMuted, unlockAudio } from '../../lib/sound'
import type { RoomStatus } from '../../lib/useRoom'

type Props = {
  code: string | null
  status: RoomStatus
  online: boolean
  onLeave: () => void
}

const STATUS_LABEL: Record<RoomStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  live: 'Live',
  error: 'Offline',
}

export function TopBar({ code, status, online, onLeave }: Props) {
  const [muted, setMuted] = useState(() => isMuted())

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">DC</span>
        <strong>DUO CHAOS</strong>
      </div>

      <div className="topbar-meta">
        {code && <span className="room-code">Room {code}</span>}
        <span className={`conn conn-${status}`}>{STATUS_LABEL[status]}</span>
        <span className={`conn ${online ? 'conn-live' : 'conn-idle'}`}>
          {online ? 'Cloud' : 'Local'}
        </span>
      </div>

      <div className="topbar-actions">
        <Button
          variant="ghost"
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
