'use client'

import type { CosmeticsApi } from '../../lib/useCosmetics'

type Props = {
  cosmetics: CosmeticsApi
  level: number
}

/** Emote ve iz (trail) seçimi. Seviye kilidi uygulanır. */
export function CosmeticsPicker({ cosmetics, level }: Props) {
  const { emote, trail, emoteOptions, trailOptions, setEmote, setTrail, triggerEmote } = cosmetics

  return (
    <div className="cosmetics">
      <div className="cosmetics-group">
        <span className="cosmetics-label">Emote</span>
        <div className="chip-row">
          {emoteOptions.map((option) => {
            const locked = level < option.minLevel
            return (
              <button
                key={option.id}
                type="button"
                className={['chip', emote === option.id ? 'active' : '', locked ? 'locked' : ''].join(' ')}
                disabled={locked}
                title={locked ? `Unlocks at level ${option.minLevel}` : option.label}
                onClick={() => {
                  setEmote(option.id)
                  triggerEmote(option.id)
                }}
              >
                <span aria-hidden>{option.glyph}</span>
                <small>{option.label}</small>
              </button>
            )
          })}
        </div>
      </div>

      <div className="cosmetics-group">
        <span className="cosmetics-label">Trail</span>
        <div className="chip-row">
          {trailOptions.map((option) => {
            const locked = level < option.minLevel
            return (
              <button
                key={option.id}
                type="button"
                className={['chip', trail === option.id ? 'active' : '', locked ? 'locked' : ''].join(' ')}
                disabled={locked}
                title={locked ? `Unlocks at level ${option.minLevel}` : option.label}
                onClick={() => setTrail(option.id)}
              >
                <span className="trail-swatch" style={{ background: option.color }} aria-hidden />
                <small>{option.label}</small>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
