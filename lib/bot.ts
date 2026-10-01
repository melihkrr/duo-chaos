import {
  ARENA,
  COLLECT_RADIUS,
  MOVE_SPEED,
  OBSTACLES,
  PLAYER_HIT_R,
  STEAL_RADIUS,
  getCoinValue,
} from './config'
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
const STEAL_APPROACH_DISTANCE = STEAL_RADIUS - 1
/** Botun çalma denemesi için minimum bekleme (ms) — insanla aynı cooldown. */
const BOT_STEAL_COOLDOWN_MS = 700
const NAVIGATION_CLEARANCE = 0.75

type NavigationPoint = { x: number; y: number }
type NavigationObstacle = {
  cx: number
  cy: number
  hw: number
  hh: number
  cos: number
  sin: number
}

const NAVIGATION_OBSTACLES: NavigationObstacle[] = OBSTACLES.map((obstacle) => {
  const angle = (obstacle.angleDeg * Math.PI) / 180
  return {
    cx: obstacle.cx,
    cy: obstacle.cy,
    hw: obstacle.w / 2 + PLAYER_HIT_R + NAVIGATION_CLEARANCE,
    hh: obstacle.h / 2 + PLAYER_HIT_R + NAVIGATION_CLEARANCE,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
  }
})

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

const segmentEntersRectangle = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  halfWidth: number,
  halfHeight: number,
) => {
  const dx = toX - fromX
  const dy = toY - fromY
  let enter = -Infinity
  let exit = Infinity

  for (const [origin, delta, extent] of [
    [fromX, dx, halfWidth],
    [fromY, dy, halfHeight],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (origin <= -extent || origin >= extent) return false
      continue
    }
    const first = (-extent - origin) / delta
    const second = (extent - origin) / delta
    enter = Math.max(enter, Math.min(first, second))
    exit = Math.min(exit, Math.max(first, second))
  }

  return Math.max(enter, 0) < Math.min(exit, 1)
}

const segmentIsClear = (from: NavigationPoint, to: NavigationPoint) =>
  NAVIGATION_OBSTACLES.every((obstacle) => {
    const localFromX =
      (from.x - obstacle.cx) * obstacle.cos + (from.y - obstacle.cy) * obstacle.sin
    const localFromY =
      -(from.x - obstacle.cx) * obstacle.sin + (from.y - obstacle.cy) * obstacle.cos
    const localToX =
      (to.x - obstacle.cx) * obstacle.cos + (to.y - obstacle.cy) * obstacle.sin
    const localToY =
      -(to.x - obstacle.cx) * obstacle.sin + (to.y - obstacle.cy) * obstacle.cos
    return !segmentEntersRectangle(
      localFromX,
      localFromY,
      localToX,
      localToY,
      obstacle.hw,
      obstacle.hh,
    )
  })

const obstacleCorners = (obstacle: NavigationObstacle): NavigationPoint[] => {
  const corners: NavigationPoint[] = []
  for (const x of [-obstacle.hw, obstacle.hw]) {
    for (const y of [-obstacle.hh, obstacle.hh]) {
      corners.push({
        x: obstacle.cx + x * obstacle.cos - y * obstacle.sin,
        y: obstacle.cy + x * obstacle.sin + y * obstacle.cos,
      })
    }
  }
  return corners
}

/**
 * Returns the next visible waypoint on the shortest collision-free route.
 * The expanded rectangles match the player's collision radius, with a small
 * margin so collision resolution does not stop the bot at a corner.
 */
const nextNavigationPointToAny = (
  from: NavigationPoint,
  targets: NavigationPoint[],
): NavigationPoint | null => {
  const safeTargets = targets.filter(
    (point) =>
      point.x >= ARENA.minX &&
      point.x <= ARENA.maxX &&
      point.y >= ARENA.minY &&
      point.y <= ARENA.maxY &&
      segmentIsClear(point, point),
  )
  if (safeTargets.length === 0) return null
  const directTarget = safeTargets
    .filter((point) => segmentIsClear(from, point))
    .sort((a, b) => dist(from.x, from.y, a.x, a.y) - dist(from.x, from.y, b.x, b.y))[0]
  if (directTarget) return directTarget

  const points = [
    from,
    ...NAVIGATION_OBSTACLES.flatMap(obstacleCorners).filter(
      (point) =>
        point.x >= ARENA.minX &&
        point.x <= ARENA.maxX &&
        point.y >= ARENA.minY &&
        point.y <= ARENA.maxY,
    ),
    ...safeTargets,
  ]
  const firstTargetIndex = points.length - safeTargets.length
  const distances = points.map(() => Infinity)
  const previous = points.map(() => -1)
  const visited = points.map(() => false)
  distances[0] = 0
  let reachedTarget = -1

  for (let iteration = 0; iteration < points.length; iteration += 1) {
    let current = -1
    for (let index = 0; index < points.length; index += 1) {
      if (!visited[index] && (current < 0 || distances[index] < distances[current])) {
        current = index
      }
    }
    if (current < 0 || !Number.isFinite(distances[current])) break
    if (current >= firstTargetIndex) {
      reachedTarget = current
      break
    }
    visited[current] = true

    for (let next = 1; next < points.length; next += 1) {
      if (visited[next] || next === current || !segmentIsClear(points[current], points[next])) {
        continue
      }
      const candidate = distances[current] + dist(
        points[current].x,
        points[current].y,
        points[next].x,
        points[next].y,
      )
      if (candidate < distances[next]) {
        distances[next] = candidate
        previous[next] = current
      }
    }
  }

  if (reachedTarget < 0 || previous[reachedTarget] < 0) return null
  let waypoint = reachedTarget
  while (previous[waypoint] > 0) waypoint = previous[waypoint]
  return points[waypoint]
}

const nextNavigationPoint = (from: NavigationPoint, target: NavigationPoint) =>
  nextNavigationPointToAny(from, [target]) ?? target

const stealApproachPoints = (rival: NavigationPoint): NavigationPoint[] =>
  Array.from({ length: 16 }, (_, index) => {
    const angle = (index * Math.PI * 2) / 16
    return {
      x: rival.x + Math.cos(angle) * STEAL_APPROACH_DISTANCE,
      y: rival.y + Math.sin(angle) * STEAL_APPROACH_DISTANCE,
    }
  })

const approachWithNavigation = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  collectIds: number[],
  steal: boolean,
): BotDecision => {
  const waypoint = nextNavigationPoint({ x: fromX, y: fromY }, { x: toX, y: toY })
  return approach(fromX, fromY, waypoint.x, waypoint.y, collectIds, steal)
}

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

  // --- 1) ÇALMA GÖREVİ ÖNCELİĞİ ---
  const stealObjective = objective?.kind === 'steal'
  const stealsRemaining = objective?.stealTarget
    ? Math.max(0, objective.stealTarget - (me.stolen ?? 0))
    : Math.max(0, target - progress)
  const stealNeeded = stealObjective && stealsRemaining > 0
  const collectIds = coins
    .filter((coin) => !coin.collectedBy && dist(bx, by, coin.x, coin.y) <= COLLECT_RADIUS)
    .map((coin) => coin.id)

  // While steal requirements remain, pursuing the rival takes precedence over
  // coins and medium-difficulty detours. Navigation picks a reachable point
  // inside the actual steal radius and routes around obstacles.
  if (stealNeeded && rival) {
    const rivalDistance = dist(bx, by, rival.x, rival.y)
    if (rivalDistance <= STEAL_RADIUS) {
      return {
        dx: 0,
        dy: 0,
        collectIds,
        steal: now - memory.lastStealAt >= BOT_STEAL_COOLDOWN_MS,
      }
    }

    const waypoint = nextNavigationPointToAny(
      { x: bx, y: by },
      stealApproachPoints(rival),
    )
    if (waypoint) return approach(bx, by, waypoint.x, waypoint.y, collectIds, false)
    return { dx: 0, dy: 0, collectIds, steal: false }
  }

  // --- 2) HATA (MISTAKE) DURUMU ---
  // Bot ara sıra yanlış bir coine yönelir veya duraksar. Bu, "yenilebilir"
  // hissini verir ve botun mükemmel olmasını engeller.
  if (now < memory.mistakeUntil) {
    const wrong = coins.find((c) => c.id === memory.mistakeCoinId && !c.collectedBy)
    if (wrong) {
      return approachWithNavigation(bx, by, wrong.x, wrong.y, [], false)
    }
    // Yanlış hedef kaybolduysa hatayı bitir.
    memory.mistakeUntil = 0
  }

  // --- 3) HEDEF COIN SEÇİMİ ---
  const available = coins.filter((c) => !c.collectedBy)
  if (available.length === 0) {
    // Coin yoksa merkeze doğru süzül (hareket hissi).
    return approachWithNavigation(
      bx,
      by,
      (ARENA.minX + ARENA.maxX) / 2,
      (ARENA.minY + ARENA.maxY) / 2,
      [],
      false,
    )
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
        return approachWithNavigation(bx, by, worst.x, worst.y, [], false)
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

  // --- 4) HAREKET ---
  // Coin hunting resumes when no steal component remains.
  if (targetCoin) {
    return approachWithNavigation(bx, by, targetCoin.x, targetCoin.y, collectIds, false)
  }
  return { dx: 0, dy: 0, collectIds, steal: false }
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
