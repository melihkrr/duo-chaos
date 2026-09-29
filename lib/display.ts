import { COLLECT_TARGET, STEAL_TARGET } from './config'
import type { Objective, Player } from './types'

/**
 * SADECE GÖRÜNTÜ yardımcıları. Skor, kazanan ve görev tamamlama kararı
 * sunucuda verilir; buradaki fonksiyonlar bunları asla belirlemez.
 */
export const objectiveOf = (p?: Pick<Player, 'id' | 'objective'>): Objective =>
  p?.objective ?? (p?.id === 'p1' ? 'collect' : 'steal')

export const targetOf = (o: Objective) => (o === 'collect' ? COLLECT_TARGET : STEAL_TARGET)

export const progressOf = (p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen'>) =>
  objectiveOf(p) === 'collect' ? p.coins || 0 : p.stolen || 0

/** Sunucunun missionDone alanı öncelikli; yoksa sadece etiket göstermek için türetilir. */
export const missionDoneForDisplay = (p: Player) =>
  p.missionDone ?? progressOf(p) >= targetOf(objectiveOf(p))

export const missionLabel = (o: Objective) =>
  o === 'collect' ? `Collect ${COLLECT_TARGET} coins` : `Steal ${STEAL_TARGET} coins`
