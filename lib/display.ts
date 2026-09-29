import { defaultObjectiveForPlayer, OBJECTIVE_POOL } from './config'
import type { Objective, Player } from './types'

/**
 * SADECE GÖRÜNTÜ yardımcıları. Skor, kazanan ve görev tamamlama kararı
 * sunucuda verilir; buradaki fonksiyonlar bunları asla belirlemez.
 */
export const objectiveOf = (p?: Pick<Player, 'id' | 'objective'>): Objective | null =>
  p?.objective ?? defaultObjectiveForPlayer(p?.id ?? 'p1')

export const targetOf = (o?: Objective | null) => {
  if (typeof o?.target === 'number' && Number.isFinite(o.target) && o.target > 0) return o.target
  const canonical =
    OBJECTIVE_POOL.find(
      (item) =>
        item.id === o?.id ||
        item.label === o?.label ||
        item.shortLabel === o?.shortLabel ||
        item.label === (o as { label?: string } | null | undefined)?.label,
    ) ??
    OBJECTIVE_POOL.find((item) => {
      const text = [o?.label, o?.shortLabel].filter(Boolean).join(' ')
      if (!text) return false
      return item.label.includes(text) || item.shortLabel.includes(text) || text.includes(item.label) || text.includes(item.shortLabel)
    })

  if (canonical) return canonical.target

  const text = [o?.label, o?.shortLabel].filter(Boolean).join(' ')
  const match = text.match(/\d+/g)
  if (!match) return 0
  return Number(match[0]) || 0
}

export const progressOf = (p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen'>) =>
  objectiveOf(p)?.kind === 'steal' ? p.stolen || 0 : p.coins || 0

/** Sunucunun missionDone alanı öncelikli; yoksa sadece etiket göstermek için türetilir. */
export const missionDoneForDisplay = (p: Player) =>
  p.missionDone ?? progressOf(p) >= (targetOf(objectiveOf(p)) || 0)

export const missionLabel = (o?: Objective | null) => o?.label ?? 'Collect 3 Gold'
