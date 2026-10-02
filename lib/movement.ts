import {
  ARENA,
  OBSTACLES,
  PLAYER_COLLIDE_R,
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
 * İKİ OYUNCU ARASI "SOLID" ÇARPIŞMA — saf (pure) çözümleyici.
 *
 * Oyuncular birbirlerinin İÇİNDEN GEÇEMEZ. Hedef konum rakibin temas
 * menziline giriyorsa, hareket rakibin dışında kalacak şekilde KISITLANIR.
 * İTME / KNOCKBACK YOKTUR: rakip asla hareket ettirilmez; yalnızca hareket
 * eden oyuncunun hedefi kırpılır.
 *
 * Davranış:
 *   * Temas yoksa hedef AYNEN döner (normal hareket bozulmaz).
 *   * Temas varsa hedef, rakibin merkezinden `collideR` uzaklıkta kalacak
 *     şekilde rakibe doğru olan eksende geri çekilir (kayma/slide korunur:
 *     teğet bileşen serbest kalır).
 *   * Merkezler tam çakışıksa (belirsiz) deterministik +x yedeği kullanılır.
 *   * Sonuç arena sınırlarına kırpılır ve engel dışına itilir.
 *
 * Skor/coin/görev/tur DEĞİŞTİRMEZ; NaN/Infinity asla üretilmez.
 *
 * @returns Kısıtlanmış hedef konum.
 */
export function resolvePlayerCollision(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  rivalX: number,
  rivalY: number,
  collideR = PLAYER_COLLIDE_R,
): { x: number; y: number } {
  const dx = toX - rivalX
  const dy = toY - rivalY
  const dist = Math.hypot(dx, dy)

  // Temas yok VE hareket doğrusu rakibin çemberini kesmiyorsa: hedef aynen geçer.
  const mx = toX - fromX
  const my = toY - fromY
  const mdist = Math.hypot(mx, my)

  // Hareket doğrusu rakibin collide çemberini kesiyor mu? (swept test)
  // Bu, hem normal teması hem de hızlı bir adımın rakibin "üzerinden
  // atlamasını" (tünelleme) aynı mantıkla yakalar.
  let sweepHit = false
  let stopX = toX
  let stopY = toY
  if (mdist > 1e-6) {
    const ux = mx / mdist
    const uy = my / mdist
    // Rakip merkezinin hareket doğrusuna izdüşümü (segment üzerinde).
    const t = ((rivalX - fromX) * ux + (rivalY - fromY) * uy) / mdist
    if (t > 0 && t < 1) {
      const projX = fromX + ux * (t * mdist)
      const projY = fromY + uy * (t * mdist)
      const perp = Math.hypot(rivalX - projX, rivalY - projY)
      if (perp < collideR) {
        // Çemberi kesiyoruz: hareket yönünde çemberin YAKIN yüzeyinde dur.
        const back = Math.sqrt(Math.max(0, collideR * collideR - perp * perp))
        stopX = projX - ux * back
        stopY = projY - uy * back
        sweepHit = true
      }
    }
  }

  // Temas yok ve süpürme de çarpmıyorsa hedef aynen geçer.
  if (dist >= collideR && !sweepHit) return clampPos(toX, toY)

  // Süpürme çarptıysa yakın yüzeyde dur (geldiğimiz taraf korunur).
  if (sweepHit) {
    const safe = pushOut(stopX, stopY, PLAYER_HIT_R)
    return clampPos(safe.x, safe.y)
  }

  // Buradan sonrası: hedef zaten rakibin çemberi İÇİNDE (dist < collideR).
  // Rakibin merkezinden hedefe doğru birim vektör. Merkezler tam çakışıksa
  // (belirsiz durum) hareket yönünün TERSİNİ kullan: böylece oyuncu geldiği
  // tarafa geri itilir ve rakibin İÇİNDEN GEÇEMEZ.
  let nx: number
  let ny: number
  if (dist < 1e-6) {
    if (mdist < 1e-6) {
      nx = 1
      ny = 0
    } else {
      nx = -mx / mdist
      ny = -my / mdist
    }
  } else {
    nx = dx / dist
    ny = dy / dist
  }

  // Hedefi rakibin dışında tut: merkezden `collideR` uzaklıkta bir nokta.
  const targetX = rivalX + nx * collideR
  const targetY = rivalY + ny * collideR

  // Engelin içinde kalmasın: `resolveMove` ile aynı push-out güvencesi.
  const safe = pushOut(targetX, targetY, PLAYER_HIT_R)
  return clampPos(safe.x, safe.y)
}
