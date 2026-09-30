'use client'

import type { ChaosApi } from '../../lib/useChaos'

type Props = {
  chaos: ChaosApi
}

/** Sunucudan gelen aktif chaos olayını gösterir. */
export function ChaosBanner({ chaos }: Props) {
  const { event, secondsLeft } = chaos
  if (!event) return null

  return (
    <div className={`chaos-banner chaos-${event.id}`} role="status">
      <strong>{event.name}</strong>
      <span>{event.description}</span>
      <em>{event.boost}</em>
      {secondsLeft > 0 && <small className="chaos-timer">{secondsLeft}s</small>}
    </div>
  )
}
