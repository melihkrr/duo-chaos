import type { AvatarId, ChaosEvent, Coin, CoinType, EmoteId, Objective, TrailId } from './types'

// --- Süreler ---
export const BATTLE_MS = 90_000
export const COUNTDOWN_MS = 3_000
export const MATCH_ROUNDS = 3

// --- Ağ / döngü aralıkları ---
// 16ms ≈ 60Hz: pozisyon yayını kare hızıyla eşleşir, rakip akıcı görünür.
export const MOVE_SEND_MS = 16
// Hareketsizken bile bu aralıkla konum (canlılık) yayınlarız. `move` yayını
// aynı zamanda "buradayım" sinyalidir; hareketsiz oyuncudan hiç sinyal
// gitmezse rakip yanlışlıkla "ayrıldı" sanır. 1sn, `RIVAL_ALIVE_TTL_MS`'ten
// çok daha kısa olduğundan tek bir paket kaybı bile sorun yaratmaz.
export const MOVE_HEARTBEAT_MS = 1_000
export const ACTION_MS = 90
export const STEAL_COOLDOWN_MS = 700
export const BUMP_SLOW_MS = 400
export const BUMP_SPEED_MULTIPLIER = 0.55
export const RECONCILE_MS = 1000
export const HEARTBEAT_MS = 400
export const PHASE_TICK_MS = 80
export const CLOCK_TICK_MS = 150
/**
 * Peer broadcast pozisyonunun sunucu snapshot'ını ezme süresi.
 *
 * ÖNEMLİ: Bu değer eskiden 5000 ms idi. Rakibin `move` yayını durduğunda
 * (sekme arka plana düştü, paket kaybı) istemci 5 SANİYE boyunca donmuş eski
 * konumu "taze" sayıp kullanıyordu → "rakip 5 sn sonra hareket ediyor" hatası.
 * 600 ms, 60Hz yayında ~36 paketlik bir toleranstır; bu süre dolunca sunucu
 * snapshot'ı (1 sn'de bir) devralır ve rakip doğru konuma oturur.
 *
 * GÜNCELLEME (kullanıcı raporu: "bir playerın hareketleri diğerinde biraz
 * laglı görünüyor"): 600 ms çok agresifti. Supabase Realtime broadcast
 * "best-effort"tur; kısa bir paket kaybı/ağ takılması 600 ms'yi aşınca
 * dead-reckoning DURUYOR (`vel = 0`) ve rakip aniden donuyor → "laglı/titrek"
 * görünüm. 1500 ms, ~90 paketlik toleransla kısa kayıpları yutar; yine de
 * gerçek bir kopmada (sekme kapandı) 1.5 sn içinde sunucu snapshot'ına düşer.
 */
export const REMOTE_POS_TTL = 1_500
/**
 * Rakip broadcast'i bu süreden uzun süre gelmezse, konumu SUNUCU snapshot'ına
 * bırakırız (sert devralma).
 *
 * KÖK SORUN ("bazen rakip bir başka konuma ışınlanıyor"): Sunucu snapshot'ı
 * ~1 sn GECİKMELİDİR. `REMOTE_POS_TTL` (1.5 sn) dolduğu anda sunucuya
 * düşersek, sunucu konumu rakibin GERÇEK konumunun gerisinde kalır; yumuşatma
 * rakibi geriye çeker, sonra broadcast dönünce ileri atar → ileri-geri
 * "ışınlanma" hissi. Kısa paket kayıplarında (1.5–3 sn) hedefi SON BİLİNEN
 * broadcast konumunda tutmak (kısa donma) ışınlanmadan çok daha iyidir.
 *
 * 3 sn, 1 sn'lik heartbeat'in üst üste ~3 kez kaybına denk gelir; bu noktadan
 * sonra gerçek bir kopma varsayıp sunucuya devrederiz (rakip spawn'da değil,
 * sunucunun son bildiği konumda belirir).
 */
export const REMOTE_HARD_TTL_MS = 3_000
export const POLL_MS = { lobby: 700, countdown: 500, battle: RECONCILE_MS, other: 1500 }
/**
 * Maç başladıktan sonra presence düşüşünü YOK SAYDIĞIMIZ süre (ms).
 *
 * KÖK SORUN: Host `duo_start_round` çağırıp faz `countdown`'a geçtiğinde,
 * misafirin realtime kanalı yeni faza geçerken kısa süreliğine presence
 * boşluğu yaşayabiliyor. Eski kod bu boşluğu "rakip ayrıldı" sanıp host'ta
 * "Your rival left the game" gösteriyordu. Maç başlangıcından sonraki bu
 * pencere içinde presence sinyaline GÜVENMEYİZ; yalnızca açık `leave`
 * broadcast'i (rivalLeft) dikkate alınır.
 */
export const MATCH_PRESENCE_GRACE_MS = 6_000

// --- Hareket / çarpışma ---
// Hız %/s cinsindendir. 52 → 38: karakter çevik ama kontrol edilebilir;
// 52 çok hızlıydı, hedefe kilitlenmek ve topları takip etmek zorlaşıyordu.
export const MOVE_SPEED = 38
export const COLLECT_RADIUS = 9
export const STEAL_RADIUS = 10
/**
 * Oyuncu çarpışma yarıçapı (arena % birimi). GÖRSEL avatar yarıçapıyla
 * BİREBİR eşleşmelidir; aksi halde oyuncu engelin GÖRÜNEN kenarına
 * değmeden bloklanır ("engelin yakınından geçerken takılıyorum" şikâyeti).
 *
 * Görsel: `.avatar-body` = 32px (border-box) → yarıçap 16px. Tipik arena
 * genişliği ~615px → 16/615 ≈ 2.6%. Eski değer 4.2 idi; bu, görselden
 * ~%60 DAHA BÜYÜK bir hayalet yarıçap demekti ve oyuncu engelin
 * "havada" bir noktasında bloklanıyordu.
 */
export const PLAYER_HIT_R = 2.6
/**
 * Rakip pozisyonu için ÜSTEL yumuşatma oranı (1/saniye). Kare hızından
 * bağımsız çalışır: her karede `alpha = 1 - exp(-k * dt)` kadar hedefe
 * yaklaşılır. Böylece 30fps'te de 144fps'te de AYNI yakınsama süresi elde
 * edilir (eski sabit `0.35` katsayısı kare hızına bağlıydı ve mobilde
 * "laglı/titrek" görünüme yol açıyordu).
 *
 * Zaman sabiti ≈ 1/k saniye. k=12 → ~83ms; akıcı ama tepkisel.
 */
export const REMOTE_SMOOTHING_K = 12
// NOT: Eskiden `REMOTE_SNAP_DISTANCE` vardı; büyük farklarda rakibi ANINDA
// hedefe zıplatıyordu. Bu, sunucu snapshot'ına düşülen durumlarda NORMAL
// hareket sırasında tetiklenip rakibi ileri-geri ışınlıyordu ("bazen rakip bir
// başka konuma ışınlanıyor"). Ani zıplama kaldırıldı; her zaman yumuşatılır.
// Gerçek respawn/yeni tur `remoteTarget` sıfırlamasıyla ele alınır.
export const ARENA = { minX: 5, maxX: 95, minY: 7, maxY: 93 }
export const SPAWN = { p1: { x: 18, y: 50 }, p2: { x: 82, y: 50 } }

/**
 * SPAWN KONUMLARI — AYNALAMA YOK.
 *
 * Online oyunda aynalama (mirroring) YOKTUR. Dünya her iki istemcide de
 * AYNEN çizilir: `p1` her zaman solda (x=18), `p2` her zaman sağda (x=82)
 * başlar. Her oyuncu kendi gerçek konumunu görür; biri solda, diğeri sağda.
 *
 * Önceki sürümde "yerel oyuncu her zaman solda görünsün" diye tüm dünya
 * `x' = 100 - x` ile aynalanıyordu. Bu, joystick yönünün ters dönmesi,
 * rakip konumunun ışınlanması ve skor/konum senkronunun bozulması gibi bir
 * dizi hataya yol açıyordu. Aynalama tamamen kaldırıldı.
 */

/** Arena % koordinatlarında engeller (CSS .obstacle.one / .two ile eşleşir) */
export const OBSTACLES: Array<{ cx: number; cy: number; w: number; h: number; angleDeg: number }> = [
  { cx: 29, cy: 31, w: 16, h: 5.5, angleDeg: 28 },
  { cx: 71, cy: 69, w: 16, h: 5.5, angleDeg: -32 },
]

// --- Görev hedefleri (oyunun yeni MVP mantığına göre) ---
export const COLLECT_TARGET = 7
export const STEAL_TARGET = 3
export const COIN_TYPES: CoinType[] = ['gold', 'blue', 'red', 'emerald']

/**
 * Görev havuzu. `points` = görev tamamlanınca kazanılan PUAN ödülü.
 *
 * PUAN DENGESİ (görevler önemini yitirmesin diye):
 *   - Sıradan coin 5, hedef coin 15, zümrüt 25, elmas 50, çalma 20 puandır.
 *   - Bir tur 90 sn; oyuncu tipik olarak ~15-25 coin toplar (~150-250 puan).
 *   - Görev ödülleri 40-70 arasındadır: birkaç coin'den YÜKSEK, böylece
 *     görevler skorun yaklaşık YARISINI oluşturur ve belirleyici kalır; ama
 *     tek başına da her şeyi çözmez, coin/çalma da önemini korur.
 *   - Zorluk arttıkça ödül artar (hedef sayısı + çalma/çoklu-kaynak görevleri).
 *
 * ÖNEMLİ: Bu değerler sunucudaki `duo_objective_pool()` ile BİREBİR aynı
 * olmalıdır; aksi halde iki taraf farklı puan hesaplar.
 */
export const OBJECTIVE_POOL: Objective[] = [
  { id: 'gold-rush', kind: 'collect', label: 'Collect 3 Gold', shortLabel: '3 Gold', target: 3, coinType: 'gold', points: 45 },
  { id: 'blue-raid', kind: 'collect', label: 'Collect 2 Blue + 2 Red', shortLabel: '2 Blue + 2 Red', target: 4, coinType: 'mixed', requirements: { blue: 2, red: 2 }, points: 60 },
  { id: 'emerald-hunt', kind: 'collect', label: 'Collect 3 Emerald', shortLabel: '3 Emerald', target: 3, coinType: 'emerald', points: 55 },
  { id: 'resource-control', kind: 'steal', label: 'Steal 3 from your rival', shortLabel: '3 stolen', target: 3, coinType: 'mixed', points: 60 },
  { id: 'jackpot-run', kind: 'collect', label: 'Collect 1 Gold + 2 Blue', shortLabel: '1 Gold + 2 Blue', target: 3, coinType: 'mixed', requirements: { gold: 1, blue: 2 }, points: 50 },
  { id: 'red-burn', kind: 'collect', label: 'Collect 2 Red + 1 Emerald', shortLabel: '2 Red + 1 Emerald', target: 3, coinType: 'mixed', requirements: { red: 2, emerald: 1 }, points: 55 },
  { id: 'blue-pressure', kind: 'collect', label: 'Collect 4 Blue', shortLabel: '4 Blue', target: 4, coinType: 'blue', points: 50 },
  { id: 'gold-robbery', kind: 'steal', label: 'Steal 2 and secure 1 Gold', shortLabel: '2 stolen + 1 Gold', target: 3, coinType: 'mixed', requirements: { gold: 1 }, stealTarget: 2, points: 70 },
]

export const CHAOS_EVENTS: ChaosEvent[] = [
  { id: 'gold-rush', name: 'Gold Rush', description: 'Gold spawns are boosted for 15s.', boost: 'Gold reward x3' },
  { id: 'blackout', name: 'Blackout', description: 'The arena dims and nearby resources become more valuable.', boost: 'Risky visibility' },
  { id: 'magnet', name: 'Magnet Storm', description: 'Coins drift toward the center and pressure rises.', boost: 'Resource control' },
  { id: 'swap', name: 'Chaos Swap', description: 'One of your targets is swapped mid-round.', boost: 'Plans break' },
  { id: 'jackpot', name: 'Jackpot', description: 'A single Diamond appears. First player gets +50.', boost: 'Diamond +50' },
]

export const defaultObjectiveForPlayer = (id: string): Objective => {
  const index = id === 'p2' ? 1 : 0
  return OBJECTIVE_POOL[index % OBJECTIVE_POOL.length]
}

/**
 * Tamamlanan bir görevin yerine rastgele YENİ bir görev seçer.
 * `excludeId` verilirse aynı görev tekrar gelmez (mümkünse).
 */
export const randomObjective = (excludeId?: string): Objective => {
  const candidates = excludeId
    ? OBJECTIVE_POOL.filter((item) => item.id !== excludeId)
    : OBJECTIVE_POOL
  const pool = candidates.length > 0 ? candidates : OBJECTIVE_POOL
  return pool[Math.floor(Math.random() * pool.length)] ?? OBJECTIVE_POOL[0]
}

export const generateObjectivePair = (seed?: string): [Objective, Objective] => {
  const hash = (value: string) => {
    let result = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index)
      result = Math.imul(result, 16777619)
    }
    return result >>> 0
  }
  const shuffled = [...OBJECTIVE_POOL].sort((left, right) =>
    hash(`${seed || Math.random()}:${left.id}`) - hash(`${seed || Math.random()}:${right.id}`),
  )
  const first = shuffled[0] ?? OBJECTIVE_POOL[0]
  const second = shuffled.find((item) => item.id !== first.id) ?? first
  return [first, second]
}

export const nextChaosEvent = (at = Date.now()): ChaosEvent => {
  const slot = Math.floor(at / 15_000)
  const event = CHAOS_EVENTS[slot % CHAOS_EVENTS.length]
  return event ?? CHAOS_EVENTS[0]
}

export const chaosEventForRound = (seed: string): ChaosEvent => {
  const value = [...seed].reduce((sum, character) => sum + character.charCodeAt(0), 0)
  return CHAOS_EVENTS[value % CHAOS_EVENTS.length] ?? CHAOS_EVENTS[0]
}

export const getCoinValue = (type: CoinType, chaosEvent?: string, objective?: Objective | null) => {
  if (type === 'diamond') return 50
  const isTarget = objective?.requirements?.[type] || objective?.coinType === type
  const base = type === 'emerald' ? 25 : isTarget ? 15 : 5
  if (chaosEvent === 'gold-rush' && type === 'gold') return base + 25
  return base
}

// --- Coin ---
export const COIN_COUNT = 14
/**
 * Toplanan bir coin bu süre sonra AYNI konumda yeniden doğar.
 *
 * ÖNEMLİ: Yeniden doğan coin'in RENGİ DEĞİŞMEZ. Renk, coin "yuvasına" (id'ye)
 * bağlıdır ve yalnızca yeni tur başında yeniden dağıtılır. Aksi halde oyuncu
 * aynı noktada sürekli renk değiştiren coinler görür ("renkleri değişiyor"
 * şikâyeti tam olarak buydu).
 */
export const COIN_RESPAWN_MS = 3_000

/**
 * Arena için deterministik coin düzeni üretir. Konumlar ve renkler `seed`e
 * bağlıdır; iki istemci aynı turda AYNI düzeni görür. Bu, "noktalar saçma
 * sapan çıkıyor" sorununu kökten çözer: düzen rastgele değil, tur başına
 * sabittir.
 */
export const spawnCoins = (seed = 'round-1'): Coin[] => {
  // Basit deterministik hash — aynı seed her zaman aynı diziyi verir.
  const hash = (value: string) => {
    let h = 2166136261
    for (let i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  let state = hash(seed) || 1
  const next = () => {
    // xorshift32 — hızlı, deterministik, tekrarsız.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  // Coinleri ızgara hücrelerine dağıt: üst üste binmezler, düzenli görünür.
  const cols = 5
  const rows = 3
  const cells = Array.from({ length: cols * rows }, (_, i) => i)
  // Fisher–Yates (deterministik) — hücreleri karıştır.
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[cells[i], cells[j]] = [cells[j], cells[i]]
  }
  return Array.from({ length: COIN_COUNT }, (_, i) => {
    const cell = cells[i % cells.length]
    const col = cell % cols
    const row = Math.floor(cell / cols)
    return {
      id: i,
      // Izgara hücresinin merkezi + küçük deterministik sapma.
      x: 12 + col * 19 + (next() * 6 - 3),
      y: 16 + row * 30 + (next() * 8 - 4),
      type: COIN_TYPES[Math.floor(next() * COIN_TYPES.length)] ?? 'gold',
    }
  })
}

export const spawnResourceWave = (round: number, wave: number): Coin[] => {
  const anchor = (round * 17 + wave * 23) % 76
  return [0, 1].map((index) => ({
    id: 1000 + round * 100 + wave * 10 + index,
    x: 12 + ((anchor + index * 37) % 76),
    y: 16 + ((anchor * 2 + index * 29) % 68),
    type: COIN_TYPES[(round + wave + index) % COIN_TYPES.length],
  }))
}

export const spawnFor = (id: string) => (id === 'p2' ? SPAWN.p2 : SPAWN.p1)

// --- Guess / Read (scout) mekaniği ---
/** Maç başına tarama hakkı. */
export const SCOUT_CHARGES = 2
/** İki tarama arasındaki bekleme süresi. */
export const SCOUT_COOLDOWN_MS = 8_000
/** İpucunun ekranda kalma süresi. */
export const SCOUT_HINT_TTL_MS = 12_000
/** İpucu gösterilirken rakibin görevinin kaçta kaçı açığa çıkar (0-1). */
export const SCOUT_REVEAL_RATIO = 0.5

// --- Kozmetikler ---
export const EMOTES: Array<{ id: EmoteId; label: string; glyph: string; minLevel: number }> = [
  { id: 'wave', label: 'Wave', glyph: '👋', minLevel: 1 },
  { id: 'taunt', label: 'Taunt', glyph: '😜', minLevel: 2 },
  { id: 'shock', label: 'Shock', glyph: '😱', minLevel: 3 },
  { id: 'gg', label: 'Good Game', glyph: '🤝', minLevel: 4 },
  { id: 'fire', label: 'On Fire', glyph: '🔥', minLevel: 5 },
]

export const TRAILS: Array<{ id: TrailId; label: string; color: string; minLevel: number }> = [
  { id: 'none', label: 'None', color: 'transparent', minLevel: 1 },
  { id: 'spark', label: 'Spark', color: '#facc15', minLevel: 1 },
  { id: 'frost', label: 'Frost', color: '#67e8f9', minLevel: 2 },
  { id: 'ember', label: 'Ember', color: '#fb7185', minLevel: 3 },
  { id: 'shadow', label: 'Shadow', color: '#a78bfa', minLevel: 4 },
]

export const emoteById = (id?: EmoteId | null) => EMOTES.find((item) => item.id === id) ?? null
export const trailById = (id?: TrailId | null) => TRAILS.find((item) => item.id === id) ?? TRAILS[0]

/**
 * HAYVAN AVATARLARI — kullanıcının seçebileceği yüz emojileri.
 *
 * İsim nasıl serbestçe seçilebiliyorsa, oyuncunun arena/HUD/sonuç ekranlarında
 * görünen hayvan yüzü de buradan seçilir. `minLevel` ile seviye kilidi uygulanır
 * (emote/trail ile aynı desen). `id` değerleri sunucudaki `duo_avatar_ids()`
 * ile BİREBİR aynı olmalıdır; aksi halde seçim sunucuda reddedilir.
 *
 * Varsayılanlar: p1 → 'rabbit' (🐰), p2 → 'bear' (🐻). Böylece avatar
 * seçmeyen oyuncular eski görünümü korur.
 */
export const AVATARS: Array<{ id: AvatarId; label: string; glyph: string; minLevel: number }> = [
  { id: 'rabbit', label: 'Rabbit', glyph: '🐰', minLevel: 1 },
  { id: 'bear', label: 'Bear', glyph: '🐻', minLevel: 1 },
  { id: 'fox', label: 'Fox', glyph: '🦊', minLevel: 1 },
  { id: 'panda', label: 'Panda', glyph: '🐼', minLevel: 1 },
  { id: 'cat', label: 'Cat', glyph: '🐱', minLevel: 1 },
  { id: 'dog', label: 'Dog', glyph: '🐶', minLevel: 1 },
  { id: 'frog', label: 'Frog', glyph: '🐸', minLevel: 2 },
  { id: 'penguin', label: 'Penguin', glyph: '🐧', minLevel: 2 },
  { id: 'koala', label: 'Koala', glyph: '🐨', minLevel: 3 },
  { id: 'tiger', label: 'Tiger', glyph: '🐯', minLevel: 3 },
  { id: 'unicorn', label: 'Unicorn', glyph: '🦄', minLevel: 4 },
  { id: 'dragon', label: 'Dragon', glyph: '🐲', minLevel: 5 },
]

/** Slot bazlı VARSAYILAN avatar (seçim yapılmamışsa). */
export const DEFAULT_AVATAR: Record<'p1' | 'p2', AvatarId> = { p1: 'rabbit', p2: 'bear' }

export const avatarById = (id?: AvatarId | null) =>
  AVATARS.find((item) => item.id === id) ?? null

/**
 * Bir avatar id'sini güvenli biçimde çözer: geçerliyse glifini, değilse
 * `fallback` (slot bazlı varsayılan) glifini döndürür. UI'da ham emoji
 * göstermek yerine bunu kullanırız; böylece sunucudan boş/geçersiz değer
 * gelse bile ekranda her zaman bir hayvan yüzü olur.
 */
export const avatarGlyph = (id?: AvatarId | null, fallback: AvatarId = 'rabbit'): string =>
  avatarById(id)?.glyph ?? avatarById(fallback)?.glyph ?? '🐰'

// --- İlerleme (XP) ---
export const XP_PER_WIN = 120
export const XP_PER_MATCH = 40
export const XP_PER_ROUND = 25
export const XP_PER_MISSION = 60

export type ProfileProgress = { xp: number; level: number; title: string; nextAt: number; progress: number }

/**
 * XP eşikleri — sunucudaki `duo_profile_for_xp` (0002_helpers.sql) ile BİREBİR
 * aynı olmalıdır. Önceden istemci `sqrt(xp/100)` eğrisini, sunucu ise
 * `floor(xp/250)+1` eğrisini kullanıyordu; bu yüzden aynı XP için istemci ve
 * sunucu FARKLI seviye/ünvan gösteriyordu ("seviyem yanlış görünüyor").
 */
const XP_PER_LEVEL = 250

/** Sunucu ile aynı ünvan eşikleri (xp >= eşik). */
const TITLE_TIERS: Array<{ min: number; title: string }> = [
  { min: 1500, title: 'Chaos Master' },
  { min: 1000, title: 'Risk Taker' },
  { min: 650, title: 'Coin Thief' },
  { min: 300, title: 'Chaos Rookie' },
  { min: 0, title: 'Rookie' },
]

/** XP'den seviye/ünvan türetir. Sunucu ile aynı eğriyi kullanır. */
export const profileForXp = (xp: number): ProfileProgress => {
  const safeXp = Math.max(0, Math.floor(xp || 0))
  const level = Math.max(1, Math.floor(safeXp / XP_PER_LEVEL) + 1)
  const floorXp = (level - 1) * XP_PER_LEVEL
  const nextAt = level * XP_PER_LEVEL
  const span = Math.max(1, nextAt - floorXp)
  const progress = Math.min(1, Math.max(0, (safeXp - floorXp) / span))
  const title = TITLE_TIERS.find((tier) => safeXp >= tier.min)?.title ?? 'Rookie'
  return { xp: safeXp, level, title, nextAt, progress }
}
