import { ARENA, COLLECT_RADIUS, MOVE_SPEED, STEAL_RADIUS, getCoinValue } from './config'
import { objectiveOf, progressOf, targetOf } from './display'
import type { Coin, CoinType, Objective, Player } from './types'

/**
 * TEK OYUNCULU "Play vs Bot" — YAPAY ZEKÂ (MEDIUM zorluk).
 *
 * TASARIM İLKELERİ
 * ----------------
 * 1) ADİL OYUN (HİLE YOK): Bot, insan oyuncunun GÖREBİLDİĞİ bilgiden fazlasına
 *    erişemez. Girdi olarak yalnızca herkese açık durumu alır: arena coinleri
 *    (`coins`), kendi görevi (`me.objective`), kendi sayaçları ve rakibin
 *    GÖRÜNÜR konumu. Rakibin görevi/ilerlemesi gibi gizli bilgileri OKUMAZ.
 * 2) AYNI KURALLAR: Bot, insanla BİREBİR aynı kurallara tabidir — aynı
 *    `MOVE_SPEED`, aynı `COLLECT_RADIUS`, aynı `STEAL_RADIUS`, aynı coin
 *    değerleri (`getCoinValue`), aynı görev tamamlama mantığı (`display.ts`).
 *    Ayrıcalıklı hız/menzil/ışınlanma YOKTUR.
 * 3) MEDIUM ZORLUK: Bot hedefe yönelir ama MÜKEMMEL değildir. Ara sıra
 *    ("mistake" olasılığı) yanlış bir coine yönelir veya bir an duraksar.
 *    Böylece rekabetçi ama yenilebilir olur.
 * 4) YENİDEN KULLANIM: Görev/coin/puan mantığı burada YENİDEN YAZILMAZ;
 *    `config.ts` (coin değeri, görev havuzu) ve `display.ts` (ilerleme,
 *    tamamlanma) fonksiyonları kullanılır.
 */

export type BotDifficulty = 'medium'

export type BotInput = {
  /** Botun kendi oyuncu kaydı (görev + sayaçlar). */
  me: Player
  /** Rakibin (insan) GÖRÜNÜR konumu. Gizli bilgi değildir. */
  rival: { x: number; y: number } | null
  /** Arenadaki tüm coinler (herkes görür). */
  coins: Coin[]
  /** Şu anki zaman (epoch ms). */
  now: number
  /** Chaos olayı (varsa) — coin değeri hesabı için. */
  chaosEventId?: string
}

export type BotDecision = {
  /** Botun bu kare için hareket yönü (normalize edilmemiş; -1..1). */
  dx: number
  dy: number
  /** Bot bu karede toplamak istediği coin id'leri (menzil içindeyse). */
  collectIds: number[]
  /** Bot bu karede çalmak istiyor mu? */
  steal: boolean
}

/** Botun "yanlış karar" (mistake) olasılığı — MEDIUM zorluk. */
const MISTAKE_CHANCE = 0.18
/** Bir hatanın ortalama süresi (ms). Bu süre boyunca bot yanlış hedefte kalır. */
const MISTAKE_MS = 900
/** Botun hedefini yeniden değerlendirme aralığı (ms). */
const RETARGET_MS = 420
/** Bot, rakibi bu mesafedeyse ve uygun koşullar varsa çalmaya yönelir. */
const STEAL_APPROACH_RADIUS = 26
/** Botun çalma denemesi için minimum bekleme (ms) — insanla aynı cooldown. */
const BOT_STEAL_COOLDOWN_MS = 700

/**
 * Botun kalıcı (kareler arası) hafızası. React dışında bir ref'te tutulur.
 */
export type BotMemory = {
  /** Şu an hedeflenen coin id'si (veya -1 = hedef yok). */
  targetCoinId: number
  /** Son hedef seçim zamanı. */
  lastRetargetAt: number
  /** Hata (mistake) bitiş zamanı. */
  mistakeUntil: number
  /** Hata sırasında yönelinecek "yanlış" coin id'si. */
  mistakeCoinId: number
  /** Son çalma denemesi zamanı. */
  lastStealAt: number
  /** Botun son bilinen konumu (kareler arası süreklilik için). */
  x: number
  y: number
}

export const createBotMemory = (x: number, y: number): BotMemory => ({
  targetCoinId: -1,
  lastRetargetAt: 0,
  mistakeUntil: 0,
  mistakeCoinId: -1,
  lastStealAt: 0,
  x,
  y,
})

/**
 * Bir coinin, verilen görev için "önem" puanını hesaplar. Bot bu puanı
 * kullanarak hangi coine yöneleceğine karar verir. Yüksek = daha önemli.
 *
 * ÖNEMLİ: Bu, oyunun PUAN değeri DEĞİLDİR (o `getCoinValue`'dur ve sunucu/
 * istemci tarafından verilir). Bu yalnızca botun hedef SEÇİM sezgisidir.
 */
export const coinPriority = (coin: Coin, objective: Objective | null, collectedTypes?: Partial<Record<CoinType, number>>): number => {
  if (coin.collectedBy) return -1
  if (!objective) return 1

  // Elmas her zaman çok değerlidir (tek seferlik +50).
  if (coin.type === 'diamond') return 100

  // Görev gereksinimleri: eksik olan türleri önceliklendir.
  if (objective.requirements) {
    const required = objective.requirements[coin.type]
    if (required) {
      const have = collectedTypes?.[coin.type] ?? 0
      // Hâlâ ihtiyaç varsa yüksek öncelik; ihtiyaç karşılandıysa düşük.
      return have < required ? 50 + (required - have) : 2
    }
    // Gereksinim listesinde olmayan tür: düşük öncelik.
    return 1
  }

  // Tek tür görevi (ör. "Collect 4 Blue").
  if (objective.coinType && objective.coinType !== 'mixed') {
    return coin.type === objective.coinType ? 50 : 1
  }

  // Çalma görevi: coin toplamak görevi ilerletmez; yine de puan için toplanır.
  if (objective.kind === 'steal') {
    return coin.type === 'emerald' ? 6 : 3
  }

  return 3
}

/** İki nokta arası mesafe. */
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)

/**
 * Botun bir kare için kararını üretir. SAF bir fonksiyondur: yalnızca girdiye
 * ve `memory`'ye bakar; `memory`'yi yerinde günceller (kareler arası durum).
 */
export const decideBot = (input: BotInput, memory: BotMemory): BotDecision => {
  const { me, rival, coins, now, chaosEventId } = input
  const objective = objectiveOf(me)
  const target = targetOf(objective)
  const progress = progressOf(me)

  // Botun konumu: hafızadaki konum (oyun döngüsü her karede günceller).
  const bx = memory.x
  const by = memory.y

  // --- 1) ÇALMA DEĞERLENDİRMESİ ---
  // Bot, çalma görevi varsa VEYA rakibi yakınındaysa çalmaya yönelir. Ancak
  // insanla aynı kurallara tabidir: yalnızca `STEAL_RADIUS` içindeyken çalar ve
  // aynı cooldown'ı bekler.
  const stealObjective = objective?.kind === 'steal'
  const stealNeeded = stealObjective && progress < target
  let wantSteal = false
  if (rival) {
    const rivalDist = dist(bx, by, rival.x, rival.y)
    const canStealNow = now - memory.lastStealAt >= BOT_STEAL_COOLDOWN_MS
    // Rakip menzile girdiyse ve (çalma görevi varsa veya fırsatçıysa) çal.
    if (rivalDist <= STEAL_RADIUS && canStealNow) {
      wantSteal = true
    } else if (stealNeeded && rivalDist <= STEAL_APPROACH_RADIUS) {
      // Çalma görevi var ve rakip yakın: ona doğru yönel.
      return approach(bx, by, rival.x, rival.y, [], false)
    }
  }

  // --- 2) HATA (MISTAKE) DURUMU ---
  // Bot ara sıra yanlış bir coine yönelir veya duraksar. Bu, "yenilebilir"
  // hissini verir ve botun mükemmel olmasını engeller.
  if (now < memory.mistakeUntil) {
    const wrong = coins.find((c) => c.id === memory.mistakeCoinId && !c.collectedBy)
    if (wrong) {
      return approach(bx, by, wrong.x, wrong.y, [], false)
    }
    // Yanlış hedef kaybolduysa hatayı bitir.
    memory.mistakeUntil = 0
  }

  // --- 3) HEDEF COIN SEÇİMİ ---
  const available = coins.filter((c) => !c.collectedBy)
  if (available.length === 0) {
    // Coin yoksa merkeze doğru süzül (hareket hissi).
    return approach(bx, by, (ARENA.minX + ARENA.maxX) / 2, (ARENA.minY + ARENA.maxY) / 2, [], false)
  }

  // Hedefi periyodik olarak yeniden seç (her karede değiştirmek titremeye yol açar).
  const needRetarget = now - memory.lastRetargetAt >= RETARGET_MS || memory.targetCoinId < 0
  if (needRetarget) {
    memory.lastRetargetAt = now
    // Hata tetikleme: yalnızca yeniden hedefleme anında, rastgele.
    if (Math.random() < MISTAKE_CHANCE) {
      // Yanlış hedef: en DÜŞÜK öncelikli (işe yaramaz) bir coin seç.
      const worst = [...available].sort(
        (a, b) => coinPriority(a, objective, me.collectedTypes) - coinPriority(b, objective, me.collectedTypes),
      )[0]
      if (worst) {
        memory.mistakeUntil = now + MISTAKE_MS
        memory.mistakeCoinId = worst.id
        memory.targetCoinId = worst.id
        return approach(bx, by, worst.x, worst.y, [], false)
      }
    }
    // Doğru hedef: en yüksek öncelikli, en yakın coin (öncelik + mesafe).
    let best: Coin | null = null
    let bestScore = -Infinity
    for (const coin of available) {
      const priority = coinPriority(coin, objective, me.collectedTypes)
      if (priority < 0) continue
      const d = dist(bx, by, coin.x, coin.y)
      // Öncelik baskın; mesafe ikincil (yakın olan tercih edilir).
      const score = priority * 10 - d
      if (score > bestScore) {
        bestScore = score
        best = coin
      }
    }
    memory.targetCoinId = best?.id ?? -1
  }

  // Hedeflenen coin hâlâ geçerli mi?
  let targetCoin = coins.find((c) => c.id === memory.targetCoinId && !c.collectedBy)
  if (!targetCoin) {
    // Hedef kayboldu (biri topladı): anında yeniden seç.
    memory.lastRetargetAt = 0
    memory.targetCoinId = -1
    // Bu karede en yakın geçerli coine yönel (bir sonraki kare yeniden seçer).
    targetCoin = available.reduce<Coin | undefined>((closest, coin) => {
      if (!closest) return coin
      return dist(bx, by, coin.x, coin.y) < dist(bx, by, closest.x, closest.y) ? coin : closest
    }, undefined)
  }

  // --- 4) TOPLAMA (menzil içindeki coinler) ---
  // Bot, insanla aynı `COLLECT_RADIUS` içindeki TÜM coinleri toplar.
  const collectIds = coins
    .filter((c) => !c.collectedBy && dist(bx, by, c.x, c.y) <= COLLECT_RADIUS)
    .map((c) => c.id)

  // --- 5) HAREKET ---
  if (wantSteal && rival) {
    return approach(bx, by, rival.x, rival.y, collectIds, true)
  }
  if (targetCoin) {
    return approach(bx, by, targetCoin.x, targetCoin.y, collectIds, false)
  }
  return { dx: 0, dy: 0, collectIds, steal: wantSteal }
}

/** Bir hedefe doğru normalize edilmiş yön üretir. */
const approach = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  collectIds: number[],
  steal: boolean,
): BotDecision => {
  const dx = toX - fromX
  const dy = toY - fromY
  const len = Math.hypot(dx, dy)
  if (len < 1e-3) return { dx: 0, dy: 0, collectIds, steal }
  return { dx: dx / len, dy: dy / len, collectIds, steal }
}

/**
 * Botun konumunu, verilen karar doğrultusunda ilerletir. İnsan oyuncuyla AYNI
 * hız (`MOVE_SPEED`) ve AYNI çarpışma çözümü (`resolveMove`) kullanılır.
 *
 * `resolveMove` çağıran tarafından uygulanır (oyun döngüsü), böylece bu modül
 * `movement.ts`'e bağımlı kalmaz ve saf kalır.
 */
export const botStepDistance = (dt: number, slowed: boolean) => {
  const speed = MOVE_SPEED * (slowed ? 0.55 : 1)
  return speed * dt
}

/**
 * Botun bir coin için kazanacağı PUANI hesaplar (görsel/telemetri amaçlı).
 * Oyunun gerçek puanı `getCoinValue` ile aynıdır — burada yeniden kullanılır.
 */
export const botCoinValue = (coin: Coin, chaosEventId: string | undefined, objective: Objective | null) =>
  getCoinValue(coin.type, chaosEventId, objective)
