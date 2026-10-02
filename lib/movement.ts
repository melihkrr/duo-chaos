import {
  ARENA,
  BUMP_CONTACT_R,
  BUMP_KNOCKBACK,
  OBSTACLES,
  PLAYER_HIT_R,
} from './config'

/**
 * Engel çarpışma sistemi — "solid" ve görselle birebir hizalı.
 *
 * TASARIM KARARLARI
 * -----------------
 * 1) GÖRSEL == FİZİKSEL
 *    Engel, `Battle.tsx` içinde `width: w%`, `height: h%` ve `border: 3px`
 *    ile çizilir. Eski kod oyuncu yarıçapını `radius * 0.72` ile %28
 *    KÜÇÜLTÜYORDU; bu yüzden oyuncu görsel olarak engelin İÇİNE girmeden
 *    çarpışma tetiklenmiyordu ("fiziksel sınır görselin içinde kalıyor").
 *    Artık çarpışma yarıçapı = gerçek görsel yarıçap (`PLAYER_HIT_R`).
 *
 * 2) GÖRSEL DİKDÖRTGENLE BİREBİR
 *    Engel kutusu, `Battle.tsx`'te çizilen `w% × h%` dikdörtgenin TA KENDİSİDİR.
 *    Kenarlık (border) ile GENİŞLETİLMEZ; aksi halde çarpışma, görünen
 *    dikdörtgenin DIŞINA taşar ve oyuncu "görünmeyen bir duvara" çarpar.
 *    Kullanıcı şikâyeti: "fiziksel olarak görünen kısmından fazla yerde engel
 *    uyguluyoruz". Bu yüzden kutu, görselin nominal boyutuna birebir eşittir.
 *
 * 3) SÜPÜRMELİ (SWEPT) ÇARPIŞMA
 *    Hareket, en ince engelin yarısından küçük adımlara bölünerek ilerletilir.
 *    Kare düşüşlerinde (mobil, arka plan sekmesi) tek karede 5.5%'lik engelin
 *    "üzerinden atlama" (tunneling) tamamen engellenir.
 *
 * 4) DIŞARI İTME (PUSH-OUT)
 *    Herhangi bir sebeple (spawn, ışınlanma, eski durum) oyuncu engelin
 *    içinde kalırsa, en yakın kenara itilir. Böylece oyuncu asla engelin
 *    içinde "sıkışmaz" veya içinden geçemez.
 */

/**
 * Engel kutusu — `Battle.tsx`'te çizilen `w% × h%` dikdörtgenle BİREBİR.
 * Kenarlık ile GENİŞLETİLMEZ; çarpışma asla görünen dikdörtgenin dışına taşmaz.
 */
type ObstacleBox = {
  cx: number
  cy: number
  /** Yerel x ekseninde yarı-genişlik (görsel dikdörtgenle birebir). */
  hw: number
  /** Yerel y ekseninde yarı-yükseklik (görsel dikdörtgenle birebir). */
  hh: number
  cos: number
  sin: number
}

const OBSTACLE_BOXES: ObstacleBox[] = OBSTACLES.map((o) => {
  const rad = (-o.angleDeg * Math.PI) / 180
  return {
    cx: o.cx,
    cy: o.cy,
    hw: o.w / 2,
    hh: o.h / 2,
    cos: Math.cos(rad),
    sin: Math.sin(rad),
  }
})

/** Engellerin en küçük yarı-boyutu — swept adım boyutunu belirlemek için. */
const MIN_OBSTACLE_HALF_EXTENT = Math.min(
  ...OBSTACLE_BOXES.map((b) => Math.min(b.hw, b.hh)),
)

export function clampPos(x: number, y: number) {
  return {
    x: Math.max(ARENA.minX, Math.min(ARENA.maxX, x)),
    y: Math.max(ARENA.minY, Math.min(ARENA.maxY, y)),
  }
}

/**
 * Verilen noktanın, verilen yarıçapla herhangi bir engelle çakışıp
 * çakışmadığını döndürür. Dönen değer, çakışma varsa en derin (en çok
 * örtüşen) engeli de içerir; push-out için kullanılır.
 */
function overlapAt(
  x: number,
  y: number,
  radius: number,
): { hit: boolean; box?: ObstacleBox; lx?: number; ly?: number } {
  let best: { box: ObstacleBox; lx: number; ly: number; depth: number } | null = null

  for (const box of OBSTACLE_BOXES) {
    const dx = x - box.cx
    const dy = y - box.cy
    // Dünya → engelin yerel ekseni (engel açısının tersi kadar döndür).
    const lx = dx * box.cos - dy * box.sin
    const ly = dx * box.sin + dy * box.cos

    const overlapX = box.hw + radius - Math.abs(lx)
    const overlapY = box.hh + radius - Math.abs(ly)
    if (overlapX > 0 && overlapY > 0) {
      // En küçük örtüşme ekseni, en sığ çıkış yönünü verir.
      const depth = Math.min(overlapX, overlapY)
      if (!best || depth > best.depth) best = { box, lx, ly, depth }
    }
  }

  if (!best) return { hit: false }
  return { hit: true, box: best.box, lx: best.lx, ly: best.ly }
}

export function hitsObstacle(x: number, y: number, radius = PLAYER_HIT_R): boolean {
  return overlapAt(x, y, radius).hit
}

/**
 * Oyuncuyu engelin dışına, en yakın kenardan iter. Yalnızca gerçekten
 * içerideyse çalışır; aksi halde konumu aynen döndürür.
 */
function pushOut(x: number, y: number, radius: number): { x: number; y: number } {
  const hit = overlapAt(x, y, radius)
  if (!hit.hit || !hit.box) return { x, y }

  const { box } = hit
  const lx = hit.lx as number
  const ly = hit.ly as number

  // Yerel eksende en sığ çıkış yönünü seç.
  const overlapX = box.hw + radius - Math.abs(lx)
  const overlapY = box.hh + radius - Math.abs(ly)

  let nlx = lx
  let nly = ly
  if (overlapX < overlapY) {
    nlx = (lx >= 0 ? 1 : -1) * (box.hw + radius)
  } else {
    nly = (ly >= 0 ? 1 : -1) * (box.hh + radius)
  }

  // Yerel → dünya (engel açısı kadar döndür).
  const wx = box.cx + nlx * box.cos + nly * box.sin
  const wy = box.cy - nlx * box.sin + nly * box.cos
  return clampPos(wx, wy)
}

/**
 * Hareketi çözer: önce tam hedefi dener, çakışma varsa eksen kayması
 * (slide) uygular. Tüm hareket SÜPÜRMELİ (swept) ilerletilir; böylece
 * yüksek hızda veya kare düşüşünde engelin içinden geçilemez.
 */
export function resolveMove(fromX: number, fromY: number, toX: number, toY: number) {
  const start = clampPos(fromX, fromY)
  const target = clampPos(toX, toY)

  // Başlangıç zaten engel içindeyse (spawn/ışınlanma) önce dışarı it.
  const safeStart = pushOut(start.x, start.y, PLAYER_HIT_R)

  const dx = target.x - safeStart.x
  const dy = target.y - safeStart.y
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-6) return safeStart

  // Adım boyutu: en ince engelin yarısından küçük olmalı ki hiçbir karede
  // engelin "üzerinden atlanamasın". En az 1 adım, en fazla 64 adım.
  const maxStep = Math.max(0.25, MIN_OBSTACLE_HALF_EXTENT * 0.5)
  const steps = Math.min(64, Math.max(1, Math.ceil(dist / maxStep)))
  const stepX = dx / steps
  const stepY = dy / steps

  let curX = safeStart.x
  let curY = safeStart.y

  for (let i = 0; i < steps; i += 1) {
    const tryX = curX + stepX
    const tryY = curY + stepY

    if (!hitsObstacle(tryX, tryY)) {
      curX = tryX
      curY = tryY
      continue
    }

    // Çakışma: eksen kayması dene (duvar boyunca kayma).
    const xOnly = clampPos(tryX, curY)
    const yOnly = clampPos(curX, tryY)
    const xOpen = !hitsObstacle(xOnly.x, xOnly.y)
    const yOpen = !hitsObstacle(yOnly.x, yOnly.y)

    if (xOpen && !yOpen) {
      curX = xOnly.x
      curY = xOnly.y
      continue
    }
    if (yOpen && !xOpen) {
      curX = yOnly.x
      curY = yOnly.y
      continue
    }
    if (xOpen && yOpen) {
      // İki eksen de açık: hedefe daha çok yaklaştıranı seç.
      const xGain = Math.abs(stepX)
      const yGain = Math.abs(stepY)
      if (xGain >= yGain) {
        curX = xOnly.x
        curY = xOnly.y
      } else {
        curX = yOnly.x
        curY = yOnly.y
      }
      continue
    }

    // Her iki eksen de kapalı: bu adımda ilerleyemeyiz. Konumu güvene al
    // (olası sayısal sızmayı temizle) ve dur.
    const safe = pushOut(curX, curY, PLAYER_HIT_R)
    curX = safe.x
    curY = safe.y
    break
  }

  // Son bir güvenlik: asla engel içinde bitirme.
  const final = pushOut(curX, curY, PLAYER_HIT_R)
  return clampPos(final.x, final.y)
}

/**
 * PLAYER BUMP / KNOCKBACK — saf (pure) çözümleyici.
 *
 * İki oyuncu temas menzilindeyse İKİSİNİ de birbirinden uzaklaştıracak yeni
 * konumları döndürür. Sunucudaki `duo_bump` ile AYNI matematiği kullanır:
 *   * yön = rakibinden bana doğru normalize vektör,
 *   * merkezler çakışıksa (belirsiz) deterministik +x yedeği,
 *   * her oyuncu `BUMP_KNOCKBACK` kadar itilir,
 *   * sonuç arena sınırlarına kırpılır ve engel dışına itilir.
 *
 * Skor/coin/görev/tur DEĞİŞTİRMEZ; yalnızca konum döndürür. NaN/Infinity asla
 * üretilmez (mesafe 0 iken yedek yön kullanılır).
 *
 * @returns `bumped: false` ve mevcut konumlar (temas yoksa); aksi halde yeni
 *          konumlar.
 */
export function computeBump(
  meX: number,
  meY: number,
  rivalX: number,
  rivalY: number,
  contactR = BUMP_CONTACT_R,
  knockback = BUMP_KNOCKBACK,
): {
  bumped: boolean
  me: { x: number; y: number }
  rival: { x: number; y: number }
} {
  const dx = meX - rivalX
  const dy = meY - rivalY
  const dist = Math.hypot(dx, dy)

  if (dist > contactR) {
    return { bumped: false, me: { x: meX, y: meY }, rival: { x: rivalX, y: rivalY } }
  }

  // Yön: rakibinden bana doğru. Merkezler çakışıksa deterministik +x yedeği.
  let nx: number
  let ny: number
  if (dist < 1e-6) {
    nx = 1
    ny = 0
  } else {
    nx = dx / dist
    ny = dy / dist
  }

  const meTarget = clampPos(meX + nx * knockback, meY + ny * knockback)
  const rivalTarget = clampPos(rivalX - nx * knockback, rivalY - ny * knockback)

  // Engel içinde kalmasın: `resolveMove` ile aynı push-out güvencesi.
  const meSafe = pushOut(meTarget.x, meTarget.y, PLAYER_HIT_R)
  const rivalSafe = pushOut(rivalTarget.x, rivalTarget.y, PLAYER_HIT_R)

  return {
    bumped: true,
    me: clampPos(meSafe.x, meSafe.y),
    rival: clampPos(rivalSafe.x, rivalSafe.y),
  }
}
