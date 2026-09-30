'use client'

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
  onLeave: () => void
  busy?: boolean
}

export function Lobby({
  code,
  players,
  isHost,
  opponentPresent,
  onCopy,
  onStart,
  onLeave,
  busy,
}: Props) {
  return (
    <Panel
      title="Lobby"
      subtitle={`Room ${code}`}
      actions={
        <>
          <Button variant="soft" onClick={onCopy}>
            Copy invite
          </Button>
          <Button variant="ghost" onClick={onLeave}>
            Leave
          </Button>
        </>
      }
      className="lobby"
    >
      <div className="seats">
        {[0, 1].map((index) => {
          const player = players[index]
          const filled = Boolean(player && (index === 0 || opponentPresent))
          return (
            <div key={index} className={['seat', filled ? 'filled' : 'empty'].join(' ')}>
              <span className="seat-avatar" aria-hidden>
                {filled ? (index === 0 ? '🐰' : '🐻') : '❓'}
              </span>
              <div className="seat-info">
                <strong>{filled ? player?.name ?? 'Player' : 'Waiting…'}</strong>
                <small className="muted">{index === 0 ? 'You' : 'Rival'}</small>
              </div>
              <span className="seat-dot" />
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
