'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { AvatarPicker } from './AvatarPicker'
import { avatarImage } from '../../lib/config'
import type { AvatarId, Player } from '../../lib/types'
import { useI18n } from '../../lib/i18n'

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
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(players[0]?.name ?? '')

  const commit = () => {
    const trimmed = draft.trim().slice(0, NAME_MAX)
    if (trimmed.length >= 2) onRename(trimmed)
    setEditing(false)
  }

  return (
    <Panel
      title={t('Lobby')}
      subtitle={t('Room {code}', { code })}
      actions={
        <Button variant="soft" onClick={onCopy}>
          {t('Copy invite')}
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
                  label={t('Change your animal')}
                />
              ) : filled ? (
                <img
                  className="seat-avatar"
                  src={avatarImage(player?.avatar, 'bear')}
                  alt=""
                  aria-hidden
                  draggable={false}
                />
              ) : (
                <span className="seat-avatar seat-avatar-empty" aria-hidden>
                  ❓
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
                    aria-label={t('Your display name')}
                  />
                ) : (
                  <strong>{filled ? player?.name ?? t('Player') : t('Waiting…')}</strong>
                )}
                <small className="muted">{isMe ? t('You') : t('Rival')}</small>
              </div>
              {isMe && !editing ? (
                <button
                  type="button"
                  className="seat-edit"
                  onClick={() => {
                    setDraft(player?.name ?? '')
                    setEditing(true)
                  }}
                  aria-label={t('Edit your name')}
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
            {ready ? t('Start match') : t('Waiting for rival…')}
          </Button>
        ) : (
          <p className="muted">{t('Waiting for the host to start…')}</p>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {t(error)}
          </p>
        ) : null}
      </div>
    </Panel>
  )
}
