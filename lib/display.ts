import { defaultObjectiveForPlayer, OBJECTIVE_POOL } from './config'
import type { CoinType, Objective, Player } from './types'

/**
 * SADECE GÖRÜNTÜ yardımcıları. Skor, kazanan ve görev tamamlama kararı
 * sunucuda verilir; buradaki fonksiyonlar bunları asla belirlemez.
 */
export const objectiveOf = (p?: Pick<Player, 'id' | 'objective'>): Objective | null =>
  typeof p?.objective === 'string'
    ? {
        ...defaultObjectiveForPlayer(p.id),
        label: p.objective.replace(/\*+/g, '').trim(),
        shortLabel: p.objective.replace(/\*+/g, '').trim(),
        target: Number(p.objective.match(/\d+/)?.[0] || 0),
      }
    : p?.objective ?? defaultObjectiveForPlayer(p?.id ?? 'p1')

export const targetOf = (o?: Objective | null) => {
  if (typeof o?.target === 'number' && Number.isFinite(o.target) && o.target > 0) return o.target
  const raw = o as (Objective & { label?: string; shortLabel?: string }) | string | null | undefined
  const rawText = typeof raw === 'string' ? raw : [raw?.label, raw?.shortLabel].filter(Boolean).join(' ')
  const canonical =
    OBJECTIVE_POOL.find(
      (item) =>
        item.id === (typeof raw === 'string' ? undefined : raw?.id) ||
        item.label === rawText ||
        item.shortLabel === rawText,
    ) ??
    OBJECTIVE_POOL.find((item) => {
      const text = rawText
      if (!text) return false
      return item.label.includes(text) || item.shortLabel.includes(text) || text.includes(item.label) || text.includes(item.shortLabel)
    })

  if (canonical) return canonical.target

  const match = rawText.match(/\d+/g)
  if (!match) return 0
  return Number(match[0]) || 0
}

export const progressOf = (
  p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen' | 'collectedTypes'>,
) => {
  const objective = objectiveOf(p)
  if (objective?.requirements) {
    const resourceProgress = Object.entries(objective.requirements).reduce(
      (sum, [type, required]) => Math.min(p.collectedTypes?.[type as CoinType] || 0, required || 0) + sum,
      0,
    )
    if (objective.kind === 'steal') return Math.min(p.stolen || 0, objective.stealTarget || 0) + resourceProgress
    return resourceProgress
  }
  if (objective?.coinType && objective.coinType !== 'mixed') {
    return p.collectedTypes?.[objective.coinType] || 0
  }
  return objective?.kind === 'steal' ? p.stolen || 0 : p.coins || 0
}

export const objectiveSatisfied = (
  p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen' | 'collectedTypes'>,
) => {
  const objective = objectiveOf(p)
  if (!objective) return false
  const resourcesMet = Object.entries(objective.requirements || {}).every(
    ([type, required]) => (p.collectedTypes?.[type as CoinType] || 0) >= (required || 0),
  )
  const stealsMet = objective.kind !== 'steal' || (p.stolen || 0) >= (objective.stealTarget || objective.target)
  return resourcesMet && stealsMet && progressOf(p) >= objective.target
}

/** Sunucunun missionDone alanı öncelikli; yoksa sadece etiket göstermek için türetilir. */
export const missionDoneForDisplay = (p: Player) =>
  p.missionDone ?? objectiveSatisfied(p)

export const missionLabel = (o?: Objective | null) =>
  (o?.label || 'Collect 3 Gold').replace(/\*+/g, '').trim()
