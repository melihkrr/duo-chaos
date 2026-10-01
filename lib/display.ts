import { defaultObjectiveForPlayer, OBJECTIVE_POOL } from './config'
import type { CoinType, Objective, Player } from './types'

/**
 * SADECE GÖRÜNTÜ yardımcıları. Skor, kazanan ve görev tamamlama kararı
 * sunucuda verilir; buradaki fonksiyonlar bunları asla belirlemez.
 */
export const objectiveOf = (p?: Pick<Player, 'id' | 'objective'>): Objective | null => {
  const fallback = defaultObjectiveForPlayer(p?.id ?? 'p1')
  const raw = p?.objective as unknown
  if (!raw) return fallback
  const objective = raw as Objective

  if (typeof raw === 'string') {
    const text = raw.replace(/\*+/g, '').trim()
    return { ...fallback, label: text, shortLabel: text, target: Number(text.match(/\d+/)?.[0] || fallback.target) }
  }

  const rawLabel = String(objective.label || '').replace(/\*+/g, '').trim()
  const rawShortLabel = String(objective.shortLabel || '').replace(/\*+/g, '').trim()
  const text = [rawLabel, rawShortLabel].filter(Boolean).join(' ').trim()
  const isGeneric = /^(collect|steal)$/i.test(rawLabel) || /^(collect|steal)$/i.test(rawShortLabel)
  const canonical =
    OBJECTIVE_POOL.find((item) => item.id === objective.id) ||
    OBJECTIVE_POOL.find((item) => item.label.toLowerCase() === text.toLowerCase() || item.shortLabel.toLowerCase() === text.toLowerCase()) ||
    (isGeneric ? fallback : undefined)

  return {
    ...(canonical || fallback),
    ...objective,
    label: canonical?.label || (rawLabel || fallback.label),
    shortLabel: canonical?.shortLabel || (rawShortLabel || fallback.shortLabel),
    target: objective.target > 0 ? objective.target : canonical?.target || fallback.target,
    coinType: objective.coinType || canonical?.coinType,
    requirements: objective.requirements || canonical?.requirements,
    stealTarget: objective.stealTarget || canonical?.stealTarget,
  }
}

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

/**
 * Görev ilerlemesi (HAM sayı). Sunucudaki `duo_mission_satisfied` ile BİREBİR
 * aynı mantığı izlemelidir; aksi halde istemci "tamamlandı" derken sunucu
 * demez (veya tersi) ve sayaç tutarsız görünür.
 *
 * SUNUCU MANTIĞI (0002_helpers.sql):
 *   - `requirements` varsa: progress = Σ min(collected[key], required)
 *   - `coinType` (mixed değil) varsa: progress = collected[coinType]
 *   - aksi halde: progress = stolen (steal) veya coins
 *
 * ÖNEMLİ: `requirements` + `steal` görevlerinde (ör. "Steal 2 and secure 1
 * Gold") sunucu `progress`e ÇALMAYI EKLEMEZ; çalma ayrı bir `steals_met`
 * koşuludur. Eski istemci kodu burada `stolen`'ı progress'e ekliyordu; bu
 * yüzden sayaç sunucudan farklı (şişkin) görünüyordu.
 */
export const progressOf = (
  p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen' | 'collectedTypes'>,
) => {
  const objective = objectiveOf(p)
  if (objective?.requirements) {
    return Object.entries(objective.requirements).reduce(
      (sum, [type, required]) => Math.min(p.collectedTypes?.[type as CoinType] || 0, required || 0) + sum,
      0,
    )
  }
  if (objective?.coinType && objective.coinType !== 'mixed') {
    return p.collectedTypes?.[objective.coinType] || 0
  }
  return objective?.kind === 'steal' ? p.stolen || 0 : p.coins || 0
}

/**
 * Görev tamamlandı mı? Sunucudaki `duo_mission_satisfied` ile BİREBİR aynı.
 *   resources_met AND steals_met AND progress >= target
 */
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
  String(o?.label ?? 'Collect 3 Gold').replace(/\*+/g, '').trim()

/**
 * Rakibin görevi GİZLİ mi?
 *
 * Sunucu (`duo_public_state`), rakibin görevini yalnızca taranmışsa (scout)
 * döndürür; aksi halde `objective: null` gönderir. İstemci eskiden bu `null`
 * değeri `defaultObjectiveForPlayer('p2')` ile SAHTE bir göreve çeviriyordu;
 * bu yüzden iki oyuncu rakibin görevi için FARKLI metinler görüyordu
 * ("görevler çelişkili görünüyor" hatası). Artık gizli görevi uydurmuyoruz.
 *
 * KURAL: Yerel oyuncu (index 0) için `null` = "henüz atanmadı" (fallback
 * gösterilebilir). Rakip (index 1) için `null` = "gizli" (uydurma YOK).
 */
export const objectiveHidden = (p?: Pick<Player, 'id' | 'objective'>): boolean =>
  !!p && p.id !== 'p1' && !p.objective
