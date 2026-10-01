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
 * Görev ilerlemesi (HAM sayı).
 *
 * ÖNCELİK: Sunucunun `objectiveProgress` alanı (0029_objective_progress_authority).
 * Sunucu bu değeri `duo_mission_progress` ile hesaplar ve `duo_public_state`
 * ile döndürür. İstemci bunu DOĞRUDAN gösterir; sayaçlardan yeniden inşa
 * ETMEZ. Böylece görev tamamlanmasında sayaçlar sıfırlansa bile ilerleme
 * "artıp geri düşmez".
 *
 * YEDEK (sunucu değeri yoksa — eski oda / geçiş anı): `duo_mission_satisfied`
 * (0002_helpers.sql) ile BİREBİR aynı mantık:
 *   - `requirements` varsa: progress = Σ min(collected[key], required)
 *   - `coinType` (mixed değil) varsa: progress = collected[coinType]
 *   - aksi halde: progress = stolen (steal) veya coins
 *
 * ÖNEMLİ (0038): `requirements` + `stealTarget` birlikte olan görevlerde (ör.
 * "Steal 2 and secure 1 Gold") ilerleme = Σ min(collected, required) +
 * min(stolen, stealTarget). Çalma ayrıca `steals_met` koşuludur; görev yalnızca
 * HEM kaynak HEM çalma sağlandığında tamamlanır.
 */
export const progressOf = (
  p: Pick<Player, 'id' | 'objective' | 'coins' | 'stolen' | 'collectedTypes' | 'objectiveProgress'>,
) => {
  const objective = objectiveOf(p)
  // HEDEF SINIRI (0037): ilerleme hedefi ASLA aşamaz. Sunucu değeri de
  // sınırlanır; böylece "5/3" / "6/4" gibi aşırı değerler gösterilmez.
  const target = targetOf(objective)
  const cap = (value: number) => (target > 0 ? Math.min(value, target) : value)
  // SUNUCU OTORİTESİ: sunucu ilerlemeyi hesapladıysa AYNEN göster (sınırlı).
  if (typeof p.objectiveProgress === 'number' && Number.isFinite(p.objectiveProgress)) {
    return cap(Math.max(0, p.objectiveProgress))
  }
  if (objective?.requirements) {
    const resources = Object.entries(objective.requirements).reduce(
      (sum, [type, required]) => Math.min(p.collectedTypes?.[type as CoinType] || 0, required || 0) + sum,
      0,
    )
    // ÇALMA BİLEŞENİ (0038): kaynak + çalma görevlerinde çalma da sayılır.
    const stealTarget = objective.stealTarget || 0
    const steals = stealTarget > 0 ? Math.min(p.stolen || 0, stealTarget) : 0
    return cap(resources + steals)
  }
  if (objective?.coinType && objective.coinType !== 'mixed') {
    return cap(p.collectedTypes?.[objective.coinType] || 0)
  }
  return cap(objective?.kind === 'steal' ? p.stolen || 0 : p.coins || 0)
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
