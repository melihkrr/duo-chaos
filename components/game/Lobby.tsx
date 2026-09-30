'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import type { Player } from '../../lib/types'

type Props = {
  code: string
  players: Player[]
  isHost: boolean
  opponentPresent: boolean
  onCopy: () => void
  onStart: () => void
  onRename: (name: string) => void
  busy?: boolean
}

const NAME_MAX = 16

export function Lobby({
  code,
  players,
  isHost,
  opponentPresent,
  onCopy,
  onStart,
  onRename,
  busy,
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
          const filled = Boolean(player && (index === 0 || opponentPresent))
          const isMe = index === 0
          return (
            <div key={index} className={['seat', filled ? 'filled' : 'empty'].join(' ')}>
              <span className="seat-avatar" aria-hidden>
                {filled ? (index === 0 ? '🐰' : '🐻') : '❓'}
              </span>
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
          <Button onClick={onStart} disabled={!opponentPresent || busy}>
            {opponentPresent ? 'Start match' : 'Waiting for rival…'}
          </Button>
        ) : (
          <p className="muted">Waiting for the host to start…</p>
        )}
      </div>
    </Panel>
  )
}
