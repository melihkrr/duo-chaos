'use client'

import type { ChaosApi } from '../../lib/useChaos'
import { localizedChaosEvent, useI18n } from '../../lib/i18n'

type Props = {
  chaos: ChaosApi
}

/** Sunucudan gelen aktif chaos olayını gösterir. */
export function ChaosBanner({ chaos }: Props) {
  const { event, secondsLeft } = chaos
  const { language } = useI18n()
  if (!event) return null
  const translated = localizedChaosEvent(event, language)

  return (
    <div className={`chaos-banner chaos-${event.id}`} role="status">
      <strong>{translated.name}</strong>
      <span>{translated.description}</span>
      <em>{translated.boost}</em>
      {secondsLeft > 0 && <small className="chaos-timer">{secondsLeft}s</small>}
    </div>
  )
}
