'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { AvatarPicker } from './AvatarPicker'
import { avatarGlyph } from '../../lib/config'
import type { AvatarId, Player } from '../../lib/types'

type Props = {
  code: string
  players: Player[]
  isHost: boolean
  opponentPresent: boolean
  /** Sunucudaki gerçek oyuncu sayısı 2 mi? Presence'a güvenmek yanlış pozitif üretiyordu. */
  ready: boolean
  onCopy: () => void
  onStart: () => void
  onRename: (name: string) => void
  /** Oyuncunun seçili avatarı (kendi koltuğu). */
  avatar: AvatarId
  /** Oyuncunun seviyesi — avatar kilidi için. */
  level: number
  /** Yeni avatar seçildiğinde çağrılır. */
  onSelectAvatar: (id: AvatarId) => void
  busy?: boolean
  error?: string | null
}

const NAME_MAX = 16

export function Lobby({
  code,
  players,
  isHost,
  opponentPresent,
  ready,
  onCopy,
  onStart,
  onRename,
  avatar,
  level,
  onSelectAvatar,
  busy,
  error,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(players[0]?.name ?? '')

  const commit = () => {
    const trimmed = draft.trim().slice(0, NAME_MAX)
    if (trimmed.length >= 2) onRename(trimmed)
    setEditing(false)
  }

  return (
    <Panel
      title="Lobby"
      subtitle={`Room ${code}`}
      actions={
        <Button variant="soft" onClick={onCopy}>
          Copy invite
        </Button>
      }
      className="lobby"
    >
      <div className="seats">
        {[0, 1].map((index) => {
          const player = players[index]
          // Rakip koltuğu yalnızca sunucuda gerçekten bir satır varsa dolu
          // sayılır; presence tek başına yeterli değil.
          const filled = Boolean(player && (index === 0 || ready))
          const isMe = index === 0
          return (
            <div key={index} className={['seat', filled ? 'filled' : 'empty'].join(' ')}>
              {isMe ? (
                // Kendi koltuğumda avatar, ismin YANINDA düzenlenebilir bir
                // butondur: tıklayınca popup açılır ve hayvanı oradan seçerim.
                <AvatarPicker
                  avatar={avatar}
                  level={level}
                  onSelect={onSelectAvatar}
                  variant="seat"
                  label="Change your animal"
                />
              ) : (
                <span className="seat-avatar" aria-hidden>
                  {filled ? avatarGlyph(player?.avatar, 'bear') : '❓'}
                </span>
              )}
              <div className="seat-info">
                {isMe && editing ? (
                  <input
                    className="name-input name-input-sm"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value.slice(0, NAME_MAX))}
                    onBlur={commit}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commit()
                      if (event.key === 'Escape') setEditing(false)
                    }}
                    maxLength={NAME_MAX}
                    autoFocus
                    aria-label="Your display name"
                  />
                ) : (
                  <strong>{filled ? player?.name ?? 'Player' : 'Waiting…'}</strong>
                )}
                <small className="muted">{isMe ? 'You' : 'Rival'}</small>
              </div>
              {isMe && !editing ? (
                <button
                  type="button"
                  className="seat-edit"
                  onClick={() => {
                    setDraft(player?.name ?? '')
                    setEditing(true)
                  }}
                  aria-label="Edit your name"
                >
                  ✏️
                </button>
              ) : (
                <span className="seat-dot" />
              )}
            </div>
          )
        })}
      </div>

      <div className="lobby-foot">
        {isHost ? (
          <Button onClick={onStart} disabled={!ready || busy}>
            {ready ? 'Start match' : 'Waiting for rival…'}
          </Button>
        ) : (
          <p className="muted">Waiting for the host to start…</p>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Panel>
  )
}
