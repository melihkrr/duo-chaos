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
  const canonical = OBJECTIVE_POOL.find((item) => item.id === o?.id || item.label === o?.label)
  return canonical?.target ?? 0
}

export const progressOf = (p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen'>) =>
  objectiveOf(p)?.kind === 'steal' ? p.stolen || 0 : p.coins || 0

/** Sunucunun missionDone alanı öncelikli; yoksa sadece etiket göstermek için türetilir. */
export const missionDoneForDisplay = (p: Player) =>
  p.missionDone ?? progressOf(p) >= (targetOf(objectiveOf(p)) || 0)

export const missionLabel = (o?: Objective | null) => o?.label ?? 'Collect 3 Gold'
