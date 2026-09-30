'use client'

import { useEffect, useState } from 'react'
import { ChaosBanner } from './ChaosBanner'
import { CosmeticsPicker } from './CosmeticsPicker'
import { ScoutPanel } from './ScoutPanel'
import { VirtualJoystick } from './VirtualJoystick'
import { Button } from '../ui/Button'
import { ARENA, OBSTACLES, trailById } from '../../lib/config'
import { missionLabel, objectiveOf, progressOf } from '../../lib/display'
import type { ChaosApi } from '../../lib/useChaos'
import type { CosmeticsApi } from '../../lib/useCosmetics'
import type { ScoutApi } from '../../lib/useScout'
import type { State } from '../../lib/types'

type Props = {
  state: State
  chaos: ChaosApi
  scout: ScoutApi
  cosmetics: CosmeticsApi
  level: number
  secondsLeft: number
  onJoystick: (dx: number, dy: number) => void
  onEmote: () => void
}

const coinClass = (type: string) => `coin coin-${type}`

export function Battle({
  state,
  chaos,
  scout,
  cosmetics,
  level,
  secondsLeft,
  onJoystick,
  onEmote,
}: Props) {
  const [now, setNow] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [])

  const me = state.players[0]
  const rival = state.players[1]
  const myObjective = objectiveOf(me)
  const myProgress = me ? progressOf(me) : 0
  const rivalObjective = objectiveOf(rival)
  const rivalProgress = rival ? progressOf(rival) : 0
  const myTrail = trailById(me?.trail)

  return (
    <section className="battle-wrap">
      <header className="hud">
        <div className="hud-player">
          <div className="hud-name">
            <span className="hud-badge me" aria-hidden>
              🐰
            </span>
            <strong>{me?.name ?? 'You'}</strong>
          </div>
          <small>{missionLabel(myObjective)}</small>
          <div className="hud-bar">
            <span style={{ width: `${Math.round(myProgress * 100)}%` }} />
          </div>
        </div>
        <div className="hud-center">
          <span className="hud-round">Round {state.round}</span>
          <span className="hud-clock">{Math.max(0, secondsLeft)}s</span>
        </div>
        <div className="hud-player rival">
          <div className="hud-name">
            <strong>{rival?.name ?? 'Rival'}</strong>
            <span className="hud-badge rival" aria-hidden>
              🐻
            </span>
          </div>
          <small>{missionLabel(rivalObjective)}</small>
          <div className="hud-bar">
            <span style={{ width: `${Math.round(rivalProgress * 100)}%` }} />
          </div>
        </div>
      </header>

      <ChaosBanner chaos={chaos} />

      <div className="arena">
        {OBSTACLES.map((obstacle, index) => (
          <div
            key={index}
            className={`obstacle ${index === 0 ? 'one' : 'two'}`}
            style={{
              left: `${obstacle.cx}%`,
              top: `${obstacle.cy}%`,
              width: `${obstacle.w}%`,
              height: `${obstacle.h}%`,
              transform: `translate(-50%, -50%) rotate(${obstacle.angleDeg}deg)`,
            }}
          />
        ))}

        {state.coins
          .filter((coin) => !coin.collectedBy)
          .map((coin) => (
            <span
              key={coin.id}
              className={coinClass(coin.type)}
              style={{ left: `${coin.x}%`, top: `${coin.y}%` }}
            />
          ))}

        {state.players.map((player, index) => {
          const trail = trailById(player.trail)
          const isMe = index === 0
          return (
            <div
              key={player.id}
              className={['avatar', isMe ? 'me' : 'rival', (player.slowedUntil ?? 0) > now ? 'slowed' : ''].join(' ')}
              style={{ left: `${player.x}%`, top: `${player.y}%` }}
            >
              {trail.id !== 'none' && (
                <span className="avatar-trail" style={{ background: trail.color }} aria-hidden />
              )}
              <span className="avatar-body">
                <span className="avatar-face" aria-hidden>
                  {isMe ? '🐰' : '🐻'}
                </span>
              </span>
              <span className="avatar-name">{isMe ? 'You' : player.name}</span>
              {player.emote && <span className="avatar-emote">{player.emote}</span>}
            </div>
          )
        })}

        {cosmetics.activeGlyph && (
          <span className="emote-pop" aria-hidden>
            {cosmetics.activeGlyph}
          </span>
        )}
      </div>

      <footer className="battle-foot">
        <VirtualJoystick onChange={onJoystick} />
        <div className="battle-side">
          <ScoutPanel scout={scout} disabled={state.phase !== 'battle'} />
          <Button variant="ghost" onClick={onEmote} className="emote-btn">
            {cosmetics.activeGlyph ?? '😀'} Emote
          </Button>
          <CosmeticsPicker cosmetics={cosmetics} level={level} />
        </div>
      </footer>

      <span className="arena-bounds" data-minx={ARENA.minX} data-maxy={ARENA.maxY} hidden />
      <span className="trail-color" data-color={myTrail.color} hidden />
    </section>
  )
}
