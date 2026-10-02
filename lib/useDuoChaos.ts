'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BATTLE_MS,
  COIN_RESPAWN_MS,
  COUNTDOWN_MS,
  MATCH_PRESENCE_GRACE_MS,
  MATCH_ROUNDS,
  POLL_MS,
  generateObjectivePair,
  spawnCoins,
} from './config'
import { friendlyError } from './errors'
import {
  applyAuthoritativeRivalState,
  createPositionActionQueue,
  isRpcSuccess,
  runAfterPositionSync,
  shouldIgnoreStalePhaseSnapshot,
  shouldRetryRematch,
} from './objectiveSync'
import {
  BACKGROUND_RETRY_POLICY,
  FAST_RETRY_POLICY,
  createRetryController,
  isTransientRpcFailure,
  withRetry,
} from './retry'
import { playSound, unlockAudio } from './sound'
import { useChaos } from './useChaos'
import { useCosmetics } from './useCosmetics'
import { useGameLoop } from './useGameLoop'
import { blankPlayer, useGameState } from './useGameState'
import { useProgress } from './useProgress'
import { useRoom, readName, readToken, saveToken } from './useRoom'
import { resolvePlayerName } from './playerName'
import { useToast } from './useToast'
import type { AvatarId, Coin, CoinType, EmoteId, Phase, Player, State, TrailId } from './types'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Rakibin "canlı" sayılması için son yayınından bu yana geçebilecek azami süre.
 * Rakip bu süre içinde bir `move`/`collect`/`steal`/`score`/`trail` yayını
 * gönderdiyse kesinlikle oyundadır; presence düşse bile "rakip ayrıldı"
 * uyarısını GÖSTERMEYİZ.
 *
 * TAMPON: `move` heartbeat'i 1 sn'de bir, `trail` heartbeat'i 3 sn'de bir
 * yayınlanır. Supabase Realtime broadcast "best-effort"tur; paket kaybı veya
 * kısa bir ağ takılması olabilir. 6 sn'lik pencere, üst üste birkaç paket
 * kaybında bile yanlış pozitif üretebiliyordu (kullanıcı raporu: "hareketler
 * laglı görünüyor, sonra rakip ayrıldı diyor"). 12 sn, en kötü durumda
 * (3 sn'lik heartbeat'in 3-4 kez üst üste kaybı) bile güvenli kalır.
 */
const RIVAL_ALIVE_TTL_MS = 12_000

/**
 * MAÇ KAZANANINI İSTEMCİ TARAFINDA HESAPLA.
 *
 * Kök sorun: Sunucudaki `duo_advance_phase`, kazananı `duo_players.total_score`
 * sütununa göre seçer (`order by total_score desc, slot asc`). Ancak `duo_tick`
 * hiç çağrılmadığı için sunucunun `score` sütunu HER ZAMAN 0'dır; dolayısıyla
 * `total_score` de 0 olur ve eşitlik bozucu `slot asc` devreye girip HER İKİ
 * istemciye de `winner = 'p1'` döner. Sonuç: iki oyuncu da "Victory!" ekranı
 * görür (biri 35, diğeri 1290 puandayken bile).
 *
 * Çözüm: Kazananı sunucudan ALMAYIZ; istemcinin kendi OTORİTE `matchScores`
 * değerinden hesaplarız. `matchScores` her turda `roundScore`'lardan birikir ve
 * iki istemcide de aynıdır. Eşitlikte kazanan yoktur (`undefined`).
 */
const winnerFromScores = (matchScores?: Record<string, number>): string | undefined => {
  const p1 = matchScores?.p1 ?? 0
  const p2 = matchScores?.p2 ?? 0
  if (p1 === p2) return undefined
  return p1 > p2 ? 'p1' : 'p2'
}

/**
 * Bir tur bittiğinde (`battle` → `results`/`matchover`) kümülatif maç skorunu
 * üretir: mevcut `matchScores`'a o turun `roundScore`'larını ekler.
 *
 * Bu, `advancePhase` yolunda zaten yapılıyordu; ancak faz geçişini önce
 * yakalayan yol (battle poll / faz uzlaşması) `matchScores`'u biriktirmediği
 * için kazanan eski (eksik) skordan hesaplanabiliyordu. Kazananı her yolda
 * TUTARLI hesaplamak için bu yardımcıyı kullanırız.
 */
const accumulateMatchScores = (
  prevMatch: Record<string, number> | undefined,
  players: Player[],
): Record<string, number> => ({
  p1: (prevMatch?.p1 ?? 0) + (players[0]?.roundScore ?? 0),
  p2: (prevMatch?.p2 ?? 0) + (players[1]?.roundScore ?? 0),
})

const makeCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('')

/**
 * Oyuncuya özel benzersiz token. İki oyuncu aynı token'ı kullanırsa
 * `duo_join_room` ikinci oyuncuyu "yeniden bağlanan host" sanıp slot 1'e
 * oturtur; bu yüzden her istemci kendi rastgele token'ını üretir.
 */
const makeToken = () => {
  const rand = () => Math.random().toString(36).slice(2, 10)
  return `t-${rand()}${rand()}`
}

/**
 * Rakibin emote etiketinin ekranda kalma süresi. `useCosmetics`'teki
 * `EMOTE_MS` ile AYNI olmalıdır; aksi halde etiket animasyondan önce/sonra
 * kaybolur. Burada ayrı tanımlanır çünkü `useCosmetics` bu sabiti export
 * etmez ve döngüsel import istemeyiz.
 */
const EMOTE_MS = 1_600

/**
 * Adres çubuğunu yeniden yüklemeden günceller. Oda oluşturma/katılma sonrası
 * paylaşılabilir `/play/CODE` linkini, çıkışta ise kök `/` yolunu gösterir.
 */
const syncUrl = (path: string) => {
  if (typeof window === 'undefined') return
  if (window.location.pathname === path) return
  window.history.pushState(null, '', path)
}

/**
 * Sunucudaki `player_id` (`'p1'`/`'p2'`) değerini YEREL slota çevirir:
 * yerel slot 0 her zaman "ben", slot 1 her zaman "rakip".
 *
 * Önceki sürüm hatalıydı: host için (`meId === 'p1'`) sunucunun `p2` satırı da
 * `'p1'`'e eşleniyordu. Böylece `duo_public_state` birleştirmesinde rakip
 * bulunamıyor, rakip verisi hiç güncellenmiyor ve rakip skoru 0'da kalıyordu
 * ("kendimi 130, rakibim beni 0 görüyor" hatası).
 */
const mapPlayerId = (rawId: string, meId: string): string => (rawId === meId ? 'p1' : 'p2')

/**
 * Sunucunun skor sözlüğünü (`{ p1, p2 }`, SUNUCU slotlarıyla anahtarlı) YEREL
 * slotlarla anahtarlanmış sözlüğe çevirir.
 *
 * Sunucu `round_scores`/`match_scores` alanlarını `player_id` (`'p1'`/`'p2'`)
 * ile döndürür. Yerel state ise skorları YEREL slotlarla tutar (slot 0 = 'p1' =
 * ben, slot 1 = 'p2' = rakip). Bu çevrimi yapmazsak p2 istemcisi sunucunun
 * `p1` skorunu (yani RAKİBİN skorunu) kendi skoru sanar → "puanlar ters
 * görünüyor" ve kazanan yanlış hesaplanır.
 */
const mapScores = (
  scores: Record<string, number> | undefined,
  meId: string,
): Record<string, number> | undefined => {
  if (!scores) return undefined
  const out: Record<string, number> = {}
  for (const [rawId, value] of Object.entries(scores)) {
    out[mapPlayerId(rawId, meId)] = value
  }
  return out
}

/**
 * Tur seed'i — sunucunun `duo_start_round` içinde ürettiği `round_seed` ile
 * BİREBİR aynı olmalıdır: `CODE:round`.
 *
 * Neden kritik? Coin düzeni bu seed'den deterministik olarak üretilir. Sunucu
 * (`duo_spawn_coins`) ve istemci (`spawnCoins`) AYNI seed'i kullanmazsa iki
 * taraf farklı konum/renk üretir; sunucu otoritesi uygulandığında coinler
 * "zıplar". Bu yüzden istemci de tam olarak `CODE:round` tohumlar.
 */
const roundSeedFor = (code: string | null | undefined, round: number): string =>
  code ? `${code}:${round}` : `round-${round}`

// NOT: Skor artık SUNUCUDA tutulur (`duo_players.score`). `duo_tick` periyodik
// çağrıldığı için `duo_public_state` her zaman gerçek skoru döndürür; sayfa
// yenilendiğinde `restore` sunucudan skoru geri alır. Bu yüzden istemci-taraflı
// localStorage skor kalıcılığı (eski workaround) tamamen kaldırıldı.

/**
 * Sunucudan gelen coin satırı. `duo_public_state` / `duo_sync_coins` artık
 * `respawnAt` alanını da döndürür; böylece istemci, rakip tarafından toplanan
 * bir coin'in NE ZAMAN geri geleceğini kesin olarak bilir.
 */
type ServerCoin = {
  id: number
  x: number
  y: number
  type: Coin['type']
  collectedBy?: string | null
  respawnAt?: number | null
}

/**
 * Sunucu coin listesini yerel `Coin[]` biçimine çevirir.
 *
 * ÖNEMLİ: Sunucu `collectedBy` alanını sunucu `player_id`'si (`'p1'`/`'p2'`)
 * olarak döndürür. Yerel state'te slot 0 her zaman "ben" olduğundan, bu değeri
 * `mapPlayerId` ile yerel slota çeviririz; aksi halde misafir oyuncu kendi
 * topladığı coini "rakip topladı" sanır.
 *
 * `respawnAt` sunucu epoch-ms'dir; yerel saate çevirmek için `toLocal`
 * kullanılır. Aksi halde saat farkı olan bir istemcide coin ya hemen ya da çok
 * geç canlanır.
 */
const toLocalCoins = (
  coins: ServerCoin[] | undefined,
  myId: string,
  toLocal: (serverTs?: number) => number,
): Coin[] | null => {
  if (!coins || coins.length === 0) return null
  return coins.map((coin) => {
    const localRespawn = toLocal(coin.respawnAt ?? undefined)
    return {
      id: coin.id,
      x: coin.x,
      y: coin.y,
      type: coin.type,
      collectedBy: coin.collectedBy ? mapPlayerId(String(coin.collectedBy), myId) : undefined,
      respawnAt: localRespawn > 0 ? localRespawn : undefined,
    }
  })
}

/**
 * SUNUCU OTORİTELİ İLERLEME BİRLEŞTİRME.
 *
 * KÖK SORUN (İKİ İSTEMCİ FARKLI SONUÇ GÖRÜYOR — "desync"):
 *   Eski sürüm bu alanları MONOTONİK (`Math.max`) birleştiriyordu. Bu, yerel
 *   İYİMSER artışları (collect/steal broadcast'i + oyun döngüsü) KALICI hale
 *   getiriyordu: sunucu otoritesi (gerçek değer) yerelden KÜÇÜKSE yok sayılıyordu.
 *   İki istemci farklı sayıda iyimser artış yaptığında (paket kaybı, yarış
 *   durumu, farklı zamanlama) her istemci KENDİ değerini kilitliyordu →
 *   Melih 🪙50 görürken PLAYER 2 Melih'i 🪙42 görüyordu. Skorlar (sunucu
 *   tarafından hesaplandığı için) tutarlıydı ama TUR İSTATİSTİKLERİ
 *   (`roundCoins`/`roundStolen`) ve `coins`/`stolen` ıraksıyordu.
 *
 * ÇÖZÜM: Bu alanlar için SUNUCU TEK OTORİTEDİR. Eylem RPC yanıtı ve bunun
 *   Realtime yayını aynı sunucu değerini anında uygular; public-state yoklaması
 *   yedek yakınsamadır. İstemci sayaçları iyimser olarak artırmaz.
 *
 * Neden "collect → ilerleme kaybolur" hatası geri gelmez?
 *   `duo_collect_batch`/`duo_steal_versioned` işlemleri objective progress ve
 *   tur sayaçlarını atomik olarak günceller. Bu alanlar eylem yanıtı/yayını
 *   üzerinden doğrudan uygulanır; public-state snapshot yedek otoritedir.
 *
 * `collectedTypes` için de sunucu otoritedir; sunucu görev değişiminde
 *   sayaçları sıfırlar ve bu sıfırlama iki istemcide de aynı anda görünür.
 */
const mergeProgress = (
  local: Player,
  server: Partial<Player>,
  objectiveChanged: boolean,
): Pick<
  Player,
  'coins' | 'stolen' | 'roundCoins' | 'roundStolen' | 'collectedTypes' | 'objectiveProgress'
> => {
  // BAYAT SNAPSHOT KORUMASI (KÖK SORUN DÜZELTMESİ).
  //
  // `objectiveChanged` çağıran tarafından "sunucu görev kimliği yerelden farklı"
  // diye hesaplanır. Ancak BAYAT bir snapshot, ÖNCEKİ görevin kimliğini taşır;
  // bu durumda `objectiveChanged` yanlışlıkla `true` olur ve eski görevin
  // ilerlemesi YENİ görevin üzerine yazılır ("görev değişti ama ilerleme eski
  // değerde kaldı" hatası). Sunucunun `objectivesDone` sayacı monotonik bir
  // sürüm damgasıdır: snapshot'ın `objectivesDone`'ı yerelden KÜÇÜKSE snapshot
  // BAYATTIR ve görev değişimi SAYILMAZ.
  const serverDone =
    typeof server.objectivesDone === 'number' && Number.isFinite(server.objectivesDone)
      ? server.objectivesDone
      : undefined
  const localDone =
    typeof local.objectivesDone === 'number' && Number.isFinite(local.objectivesDone)
      ? local.objectivesDone
      : 0
  const staleSnapshot = serverDone !== undefined && serverDone < localDone
  // BAYAT SNAPSHOT: sunucunun `objectivesDone`'ı yerelden geride → bu snapshot
  // ÖNCEKİ göreve aittir. TAMAMEN YOK SAYILIR; hiçbir alanı uygulanmaz. Aksi
  // halde eski görevin ilerlemesi (ör. 4) yeni görevin üzerine yazılır.
  if (staleSnapshot) {
    return {
      coins: local.coins,
      stolen: local.stolen,
      roundCoins: local.roundCoins,
      roundStolen: local.roundStolen,
      collectedTypes: local.collectedTypes ?? {},
      objectiveProgress: local.objectiveProgress ?? 0,
    }
  }
  const effectiveChanged = objectiveChanged
  // Görev GERÇEKTEN değiştiyse sunucu sayaçları sıfırlamıştır; AYNEN al.
  if (effectiveChanged) {
    return {
      coins: server.coins ?? local.coins,
      stolen: server.stolen ?? local.stolen,
      roundCoins: server.roundCoins ?? local.roundCoins,
      roundStolen: server.roundStolen ?? local.roundStolen,
      collectedTypes: server.collectedTypes ?? {},
      // Yeni görev: ilerleme 0'dan başlar; sunucu değerini AYNEN al.
      objectiveProgress: server.objectiveProgress ?? 0,
    }
  }
  // SUNUCU OTORİTESİ + MONOTONİKLİK (KÖK SORUN DÜZELTMESİ).
  //
  // KÖK SORUN ("4/4 → 3/4 → 4/4"): `objectiveProgress`'e İKİ yazar vardı:
  //   1. TAZE yol — versioned action RPC yanıtı (`applyServerState`),
  //      anında ve otoriter (4/4 gösterir).
  //   2. BAYAT yol — `duo_public_state` yoklaması (~1 sn gecikmeli). Snapshot
  //      4. toplama commit edilmeden ÖNCE alındıysa ilerleme 3 taşır.
  //
  // Önceki sürüm "sunucu değeri kazanır" diyordu; ancak snapshot BAYAT
  // olabildiği için (replica gecikmesi / yazma öncesi okuma) bu, taze 4'ü
  // bayat 3 ile EZİYOR ve ilerleme geri düşüyordu.
  //
  // ÇÖZÜM: İlerleme, GÖREV KİMLİĞİ BAŞINA MONOTONİKTİR. Görev kimliği
  // değişmediği sürece HİÇBİR yazar değeri DÜŞÜREMEZ (`Math.max`). Tek meşru
  // sıfırlama, görev kimliği değiştiğinde (sunucu yeni görev atadığında) olur
  // ve o dal yukarıda ele alınır. Böylece 1/4 → 2/4 → 3/4 → 4/4 garanti;
  // 4/4 → 3/4 ASLA olmaz.
  const serverProgress =
    typeof server.objectiveProgress === 'number' && Number.isFinite(server.objectiveProgress)
      ? server.objectiveProgress
      : undefined
  const localProgress =
    typeof local.objectiveProgress === 'number' && Number.isFinite(local.objectiveProgress)
      ? local.objectiveProgress
      : 0
  // Görev değişmedi → monotonik: en büyük değeri koru (bayat snapshot düşüremez).
  const objectiveProgress =
    serverProgress === undefined ? localProgress : Math.max(localProgress, serverProgress)
  return {
    coins: server.coins ?? local.coins,
    stolen: server.stolen ?? local.stolen,
    roundCoins: server.roundCoins ?? local.roundCoins,
    roundStolen: server.roundStolen ?? local.roundStolen,
    collectedTypes: server.collectedTypes ?? local.collectedTypes ?? {},
    objectiveProgress,
  }
}

/**
 * RAKİBİN görev ilerlemesini birleştirir — sunucu otoritesi ve görev-başı monotoniklik.
 *
 * KÖK SORUN ("görev sahibi 2/3, rakip 3/3 görüyor"):
 *   Görevin SAHİBİ, ilerlemesinin TEK otoritesidir. Rakip istemci sahibin
 *   ilerlemesini KENDİ yerel olaylarından (collect/steal yayınları) türetirse,
 *   bu yerel değer sunucunun otoriter değerinin ÜSTÜNE çıkabilir (yayın
 *   kaybolması/gecikmesi, sahibin sunucudaki sayacından farklı olması vb.).
 *   Bu yerel türetim artık yapılmıyor. Sunucunun ilerlemesi görev başına
 *   monotoniktir; aynı görev için eski bir yoklama daha düşük değer döndürürse
 *   iki istemci de en son gördüğü otoriter ilerlemeyi korur.
 *
 * Görev kimliği gerçekten değiştiğinde yeni görev ve ilerleme birlikte alınır;
 * aynı görevde ise stale snapshot ilerlemeyi düşüremez.
 */
const mergeRivalProgress = (
  local: Player,
  server: Partial<Player>,
  objectiveChanged: boolean,
): ReturnType<typeof mergeProgress> => mergeProgress(local, server, objectiveChanged)

/**
 * Sunucu coin listesini yerel listeyle birleştirir (sunucu OTORİTEDİR).
 *
 * Neden birleştirme? Sunucu snapshot'ı ~1 sn gecikmeli gelir. Yerel oyuncu bir
 * coini yeni topladıysa ve sunucu henüz bu toplamayı işlemediyse, snapshot o
 * coini "toplanmamış" gösterir. Doğrudan uygularsak coin bir anlığına geri
 * gelir ("coin geri geldi / titredi" hatası). Bu yüzden:
 *   * Sunucu "toplanmış" diyorsa → toplanmış kabul et (otorite).
 *   * Sunucu "toplanmamış" diyorsa ama yerelde toplanmışsa → yerel kararı koru
 *     (henüz sunucuya ulaşmamış olabilir).
 *   * Konum ve renk HER ZAMAN sunucudan alınır (iki istemci birebir aynı görsün).
 */
const mergeCoins = (local: Coin[], server: Coin[], meId: string): Coin[] => {
  const byId = new Map(server.map((coin) => [coin.id, coin]))
  const localIds = new Set(local.map((coin) => coin.id))
  const merged = local.map((coin) => {
    const remote = byId.get(coin.id)
    if (!remote) return coin
    // SLOT EŞLEME: Sunucu `collectedBy` alanını SUNUCU slotu (`'p1'`/`'p2'`)
    // olarak döndürür; yerel state YEREL slot bekler (slot 0 = 'p1' = ben).
    // Çevirmezsek p2 istemcisinde rakip tarafından toplanan coin "ben topladım"
    // gibi işaretlenir. (Şu an yalnızca boolean olarak kullanılsa da tutarlılık
    // için doğru slota çeviririz.)
    const remoteCollectedBy = remote.collectedBy
      ? mapPlayerId(String(remote.collectedBy), meId)
      : undefined
    // Sunucu toplanmış diyorsa otoritedir; değilse yerel "toplandı" kararını koru.
    const collectedBy = remoteCollectedBy ?? coin.collectedBy
    const respawnAt = remote.collectedBy ? remote.respawnAt : coin.respawnAt
    return {
      ...coin,
      // Konum + renk sunucudan (iki istemci birebir aynı).
      x: remote.x,
      y: remote.y,
      type: remote.type,
      collectedBy,
      respawnAt,
    }
  })
  // SUNUCUDA OLUP YERELDE OLMAYAN COINLER: kaynak dalgası coinleri (id 1000+)
  // ve elmas (id 900+round) yalnızca sunucuda doğar. Bunları EKLEMEZSEK
  // oyuncular dalga coinlerini ve elması hiç görmez (yalnızca yeni turda,
  // `roundChanged` tam listeyi benimsediğinde ortaya çıkarlar). Bu yüzden
  // sunucuya özel coinleri listeye ekleriz.
  for (const remote of server) {
    if (localIds.has(remote.id)) continue
    merged.push({
      id: remote.id,
      x: remote.x,
      y: remote.y,
      type: remote.type,
      collectedBy: remote.collectedBy
        ? mapPlayerId(String(remote.collectedBy), meId)
        : undefined,
      respawnAt: remote.respawnAt ?? undefined,
    })
  }
  return merged
}

/** `duo_public_state` RPC'sinin döndürdüğü anlık görüntü. */
type PublicSnapshot = {
  phase?: Phase
  round?: number
  /** Sunucudaki gerçek oyuncu satırı sayısı (presence değil). */
  playerCount?: number
  /** Sunucunun yanıt anındaki saati (epoch ms) — saat farkını düzeltmek için. */
  serverNow?: number
  endsAt?: number
  countdownEndsAt?: number
  winner?: string
  /** Sunucunun tur bazlı skorları (`{ p1, p2 }`). */
  roundScores?: Record<string, number>
  /** Sunucunun maç bazlı kümülatif skorları (`{ p1, p2 }`). */
  matchScores?: Record<string, number>
  /** Sunucu chaos olayını `chaosEvent` adıyla döndürür (id/name/description/boost). */
  chaosEvent?: { id?: string; name?: string; description?: string; boost?: string } | null
  /** Chaos olayının bitiş anı (sunucu epoch ms). */
  chaosEventEndsAt?: number
  players?: Array<Partial<Player> & { id?: string }>
  coins?: ServerCoin[]
}

/**
 * DUO CHAOS'un tüm parçalarını birleştiren orkestratör.
 * Sayfa bileşeni sadece bunu tüketir.
 */
export const useDuoChaos = () => {
  // `room` ÖNCE kurulur: `useGameState` yerel oyuncunun GERÇEK spawn konumunu
  // sunucu slotuna (`room.playerId`) göre belirler (aynalama için kritik).
  const room = useRoom()
  const positionActionQueue = useRef(createPositionActionQueue())
  const game = useGameState(room.playerId)
  const progress = useProgress()
  const chaos = useChaos()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Sunucudaki gerçek oyuncu satırı sayısı. Realtime presence'ın aksine bu
  // değer `duo_join_room` commit edene kadar 1 kalır; bu yüzden "Start match"
  // butonu presence yerine buna göre kilitlenir.
  const [serverPlayerCount, setServerPlayerCount] = useState(0)
  // Rakip oyundan ayrıldığında (broadcast 'leave' veya presence düşüşü) true
  // olur. Oyun duraklatılır ve kullanıcıya "bekle / ayrıl" seçeneği sunulur.
  const [rivalLeft, setRivalLeft] = useState(false)
  // Sonraki tur onayı: yerel oyuncu onayladı mı, rakip onayladı mı?
  // İki oyuncu da onaylayınca tur başlar ("next round iki oyuncunun da
  // onayıyla başlamalı"). Host tek başına turu başlatamaz.
  const [nextReady, setNextReady] = useState(false)
  const [rivalNextReady, setRivalNextReady] = useState(false)
  // RÖVANŞ (rematch) onayı: maç bittiğinde İKİ oyuncunun da onayı gerekir.
  // Sunucu `duo_rematch` yalnızca iki taraf da hazır olunca odayı `lobby`'ye
  // çeker; bu yüzden istemci tek başına `lobby`'ye geçmemeli (aksi halde
  // uzlaşma fazı onu tekrar `matchover`'a geri çekerdi — "rematch'e basınca
  // yine sonuç ekranına dönüyorum" hatası).
  const [rematchReady, setRematchReady] = useState(false)
  const [rivalRematchReady, setRivalRematchReady] = useState(false)
  const remotePos = useRef<Map<string, { x: number; y: number; at: number }>>(new Map())
  // Rakibin emote etiketini süresi dolunca temizlemek için zamanlayıcı.
  const remoteEmoteTimer = useRef<number>(0)
  // NOT: Eskiden burada `rivalBroadcastSeenRef` adlı KALICI bir mandal vardı:
  // tur içinde bir kez `move` broadcast'i görüldüyse sunucu snapshot'ı rakip
  // konumu için sonsuza dek devre dışı kalıyordu. Bu, "bir süre sonra rakip
  // sabit/donuk görünüyor" hatasının köküydü (broadcast sessizce durunca hiçbir
  // kurtarma yolu kalmıyordu). Artık rakip konumu TAZELİK bazlı seçilir:
  // taze broadcast > sunucu snapshot'ı. Mandal kaldırıldı.
  // `room` her render'da yeni bir nesne kimliği taşır (useRoom dönüşü
  // memoize edilmemiş). Bu yüzden yoklama effect'lerinin bağımlılığı olarak
  // `room` kullanmak, effect'in her render'da yeniden kurulup interval'i
  // sıfırlamasına ve hiç ateşlenmemesine yol açıyordu. Çağrı fonksiyonunu
  // ref'te tutup effect'leri kararlı ilkel değerlere bağlarız.
  const callRef = useRef(room.call)
  useEffect(() => {
    callRef.current = room.call
  }, [room.call])

  // `room.broadcast` da her render'da yeni kimlik taşır. Yoklama effect'i
  // içinde (misafir lobiden çıkarken `hello` yayını) kullanıldığı için ref'te
  // tutarız; böylece effect bağımlılığına `room` eklemek zorunda kalmayız ve
  // interval her render'da sıfırlanmaz.
  const broadcastRef = useRef(room.broadcast)
  useEffect(() => {
    broadcastRef.current = room.broadcast
  }, [room.broadcast])

  // Sunucu saati ile yerel saat arasındaki fark (ms). Sunucu deadline'ları
  // (countdown_ends_at / ends_at) mutlak epoch-ms olarak döner; ancak sunucu
  // saati istemciden farklı olabilir (bulut VM'lerde yaygın). Bu farkı
  // hesaplayıp sunucu deadline'larını yerel saate çeviririz; aksi halde faz
  // geçişi ya anında tetiklenir ya da hiç tetiklenmez.
  const serverOffsetRef = useRef(0)
  // `advancePhase` kendi kendini yeniden denemek zorunda (sunucu `not_ready`
  // döndüğünde). Fonksiyonun kendi kimliğine erişmesi için ref'te tutarız.
  const retryRef = useRef(0)
  const advancePhaseRef = useRef<((from: Phase) => Promise<void>) | null>(null)
  // Realtime işleyicileri (broadcast callback'leri) güncel `nextReady` ve
  // `beginNextRound` değerlerine ihtiyaç duyar; ancak bu callback'ler effect
  // kurulumunda bir kez bağlanır. Güncel değerleri ref'lerde tutarız.
  const nextReadyRef = useRef(false)
  const beginNextRoundRef = useRef<(() => Promise<void>) | null>(null)
  // Güncel tur numarası. `next-ready` el sıkışmasını TURA bağlamak için
  // realtime işleyicisinden okunur (işleyici effect kurulumunda bir kez
  // bağlandığı için `state.round`'a doğrudan erişemez).
  const roundRef = useRef(1)
  // Maçın (ilk turun) başladığı yerel zaman damgası. `rivalGone` hesabında
  // maç başlangıcından sonraki kısa bir "grace" penceresinde presence
  // düşüşünü yok saymak için kullanılır (bkz. MATCH_PRESENCE_GRACE_MS).
  //
  // NOT: Bu bir REF değil STATE'tir; çünkü `rivalGone` RENDER sırasında
  // hesaplanır ve lint kuralı (`react-hooks/refs`) render'da ref okumayı
  // yasaklar. State kullanmak ayrıca grace penceresi dolduğunda yeniden
  // render tetikleyip "rakip ayrıldı" uyarısının doğru anda görünmesini
  // sağlar.
  const [matchStartAt, setMatchStartAt] = useState(0)
  // Rakibin EN SON canlı yayın (move/collect/steal/score) gönderdiği yerel
  // zaman. Presence düşse bile bu damga tazeyse rakip OYUNDADIR; "rakip
  // ayrıldı" kararını buna göre yumuşatırız (bkz. `rivalGone`).
  //
  // NOT: Bu bir REF değil STATE'tir; çünkü `rivalGone` RENDER sırasında
  // hesaplanır ve lint kuralı (`react-hooks/refs`) render'da ref okumayı
  // yasaklar. State kullanmak ayrıca TTL dolduğunda yeniden render tetikleyip
  // uyarının doğru anda görünmesini sağlar.
  const [rivalAliveAt, setRivalAliveAt] = useState(0)
  // Sunucudan gelen EN SON yerel-saat deadline'ları. Misafir yeni turda
  // `resetRound` çağırdığında bu değerler `0`'lanır (resetRound `endsAt` ve
  // `countdownEndsAt`'i sıfırlar). Bu yüzden resetten HEMEN sonra sunucu
  // deadline'larını geri yazarız; aksi halde misafirin geri sayımı silinir ve
  // tur başlamaz ("birinde 3-2-1 sayılırken diğerinde sayılmadan başlıyor").
  const serverDeadlineRef = useRef<{ countdownEndsAt: number; endsAt: number }>({
    countdownEndsAt: 0,
    endsAt: 0,
  })
  const noteServerNow = useCallback((serverNow?: number) => {
    if (typeof serverNow === 'number' && serverNow > 0) {
      serverOffsetRef.current = serverNow - Date.now()
    }
  }, [])
  /** Sunucu deadline'ını yerel saat eksenine çevirir. */
  const toLocal = useCallback((serverTs?: number) => {
    if (typeof serverTs !== 'number' || serverTs <= 0) return 0
    return serverTs - serverOffsetRef.current
  }, [])

  const { state, setState, setPhase, resetRound, resetMatch, updatePlayer, moveLocal } = game

  // En güncel `state`'e interval/effect içinden erişmek için. Skor heartbeat'i
  // gibi periyodik işler, effect'i her skor değişiminde yeniden kurmadan güncel
  // skoru okumalıdır.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Saat tiki (geri sayım / süre göstergesi).
  // Yalnızca aktif fazlarda çalışır; home/lobby/results'ta gereksiz render yok.
  useEffect(() => {
    if (state.phase !== 'countdown' && state.phase !== 'battle') return
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [state.phase])

  // SUNUCU TİKİ (duo_tick) — DÜNYANIN OTORİTESİ.
  //
  // KÖK SORUN: `duo_tick` hiç çağrılmadığı için sunucu dünyayı İLERLETMİYORDU:
  // countdown→battle geçişi, chaos olayları, kaynak dalgaları ve coin
  // yeniden doğuşu sunucuda hiç tetiklenmiyordu. Bu yüzden istemci skoru ve
  // konumu "yerel olarak" yönetmek zorunda kalmıştı (kırılgan bir yığın
  // workaround: localStorage skor, broadcast skor senkronu, istemci-taraflı
  // kazanan hesabı). Kullanıcı bu yerel yönetimi açıkça reddetti.
  //
  // ÇÖZÜM: Aktif fazlarda periyodik olarak `duo_tick` çağırırız. Sunucu artık
  // fazı ilerletir, chaos'u zamanlar ve coinleri canlandırır. Skor/konum
  // otoritesi sunucuya döner; istemci yalnızca kendi hareketini yayınlar ve
  // sunucu snapshot'ını tüketir. İki istemci de aynı `duo_tick`'i çağırsa bile
  // fonksiyon idempotenttir (zaman damgalarına göre çalışır).
  useEffect(() => {
    if (state.phase !== 'countdown' && state.phase !== 'battle') return
    const myToken = room.token ?? room.playerId
    // İDEMPOTENT: `duo_tick` zaman damgalarına göre çalışır; iki istemci de
    // çağırsa bile dünyayı iki kez ilerletmez. Bu yüzden geçici hatalarda
    // GÜVENLE yeniden denenebilir. Tek bir başarısız tik artık dünyayı
    // "donmuş" bırakmaz: `createRetryController` başarısızlıkta geri çekilme
    // uygular, başarıda sayacı sıfırlar (yüksek frekanslı döngü yok).
    const controller = createRetryController(BACKGROUND_RETRY_POLICY)
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (!controller.shouldRunNow()) return
      void controller
        .run(async () => {
          const response = await room.call('duo_tick', { p_token: myToken })
          if (!isRpcSuccess(response) && isTransientRpcFailure(response)) {
            throw new Error(`duo_tick rejected: ${JSON.stringify(response)}`)
          }
        })
        .catch(() => undefined)
    }
    const id = window.setInterval(tick, 1_000)
    // Faz geçişini geciktirmemek için hemen bir tik at.
    tick()
    return () => window.clearInterval(id)
  }, [room, state.phase])

  // SKOR HEARTBEAT KALDIRILDI: Skor artık sunucunun tekelindedir. İstemci skoru
  // ne üretir ne de rakibe yayınlar; her iki taraf da `duo_public_state`
  // yoklamasından aynı mutlak skoru okur. Böylece "puanlar birbirinden farklı
  // görünüyor" sorunu kökten çözülür (tek doğruluk kaynağı sunucu).

  const cosmetics = useCosmetics(
    {
      emote: progress.progress.emote,
      trail: progress.progress.trail,
      avatar: progress.progress.avatar,
    },
    (input) => void progress.setCosmetics(input),
    (id) => room.broadcast('emote', { by: room.playerId, id }),
    // İz (trail) seçimi değişince rakibe bildir; rakip `state.players[1].trail`
    // üzerinden bizim izimizi görsün.
    (id) => room.broadcast('trail', { by: room.playerId, id }),
    // Avatar seçimi değişince rakibe bildir; rakip `state.players[1].avatar`
    // üzerinden bizim hayvan yüzümüzü görsün.
    (id) => room.broadcast('avatar', { by: room.playerId, id }),
  )

  // `cosmetics` nesnesi `activeEmote` değişince (her emote animasyonunda) yeni
  // kimlik kazanır. Realtime işleyici effect'i `cosmetics`'e bağımlı olursa her
  // emote'ta işleyiciler sökülüp yeniden bağlanır ve bu sırada gelen olaylar
  // kaybolabilir. Bu yüzden güncel `cosmetics`'i ref'te tutarız; effect yalnızca
  // kararlı `room`/`setState`'e bağlı kalır.
  const cosmeticsRef = useRef(cosmetics)
  useEffect(() => {
    cosmeticsRef.current = cosmetics
  }, [cosmetics])

  // İZ (TRAIL) SENKRONU.
  //
  // Kök sorun: `offTrail` yalnızca rakip izini DEĞİŞTİRDİĞİNDE tetiklenir.
  // Oyun başladığında (veya yeni turda) rakip kendi izini hiç "değiştirmez";
  // bu yüzden karşı taraf rakibin izini hep varsayılan/seed değerle görür.
  // Sonuç: "iki oyuncu birbirinin izini doğru renkte görmüyor".
  //
  // Çözüm: yerel iz seçimini bağlantı kurulduğunda, tur başladığında ve
  // periyodik olarak yayınlarız. Böylece rakip her zaman OTORİTE iz değerini
  // görür. `trailRef` ile en güncel seçimi effect'i yeniden kurmadan okuruz.
  const trailRef = useRef(cosmetics.trail)
  useEffect(() => {
    trailRef.current = cosmetics.trail
  }, [cosmetics.trail])

  // AVATAR SENKRONU (iz ile aynı desen). Rakip, oyun başında/yeni turda kendi
  // avatarını "değiştirmez"; bu yüzden seçimi bağlantı kurulduğunda, tur
  // başladığında ve periyodik olarak yayınlarız. Böylece rakip her zaman
  // OTORİTE avatar değerini görür.
  const avatarRef = useRef(cosmetics.avatar)
  useEffect(() => {
    avatarRef.current = cosmetics.avatar
  }, [cosmetics.avatar])

  // YENİDEN BAĞLANMA UZLAŞMASI (reconnect reconciliation).
  //
  // KÖK SORUN: Realtime kanalı düştüğünde (`CHANNEL_ERROR`/`TIMED_OUT`) istemci
  // yalnızca bir sonraki rastgele olaya kadar "kör" kalıyordu. Kanal geri
  // geldiğinde bile sunucu durumu (skor, görev ilerlemesi, faz, rakip konumu)
  // hemen tazelenmiyordu; oyuncu bayat/yanlış durumda takılı kalabiliyordu.
  //
  // ÇÖZÜM: `useRoom` her başarılı (yeniden) abonelikte `onReconnect` işleyicisini
  // tetikler. Burada OTORİTE snapshot'ını (`duo_public_state`) hemen çekeriz ve
  // `hello`/`trail`/`avatar` sinyallerini yeniden yayınlarız. Böylece her iki
  // istemci de kısa sürede aynı sunucu durumuna yakınsar; oyuncunun sayfayı
  // elle yenilemesi GEREKMEZ.
  useEffect(() => {
    const off = room.onReconnect(() => {
      if (!room.code) return
      const myToken = room.token ?? room.playerId
      // Rakibe "buradayım" sinyali: karşı tarafın "rakip ayrıldı" uyarısını
      // hemen temizler (presence senkronu gecikebilir).
      broadcastRef.current('hello', { by: room.playerId })
      broadcastRef.current('trail', { by: room.playerId, id: trailRef.current })
      broadcastRef.current('avatar', { by: room.playerId, id: avatarRef.current })
      // OTORİTE DURUMU: faz/skor/görev/rakip konumunu hemen tazele. Bu çağrı
      // idempotenttir; başarısız olursa normal yoklama döngüsü zaten yakalar.
      void callRef
        .current<PublicSnapshot>('duo_public_state', { p_token: myToken })
        .then((data) => {
          if (!data) return
          if (typeof data.playerCount === 'number') setServerPlayerCount(data.playerCount)
          noteServerNow(data.serverNow)
        })
        .catch(() => undefined)
    })
    return off
  }, [noteServerNow, room])

  useEffect(() => {
    if (!room.code) return
    const publish = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      room.broadcast('trail', { by: room.playerId, id: trailRef.current })
      room.broadcast('avatar', { by: room.playerId, id: avatarRef.current })
    }
    // Bağlanır bağlanmaz ve her tur başlangıcında yayınla.
    publish()
    // RAKİBE "BURADAYIM" SİNYALİ: Yeniden bağlandığımızda rakibin ekranındaki
    // "rakip ayrıldı" uyarısını hemen kapatması için `hello` yayınlarız.
    // (Presence senkronu gecikebilir; bu sinyal anında temizler.)
    room.broadcast('hello', { by: room.playerId })
    // Periyodik heartbeat: tek bir paket kaybolsa bile yakınsar.
    const id = window.setInterval(publish, 3_000)
    return () => window.clearInterval(id)
  }, [room, room.code, room.playerId, state.phase, state.round])

  const publishMove = useCallback(
    (x: number, y: number) => {
      // Pozisyonu her karede yayınla: rakip bu broadcast ile akıcı görünür.
      room.broadcast('move', { by: room.playerId, x, y })
      positionActionQueue.current.enqueueMove(
        async () => {
          // İDEMPOTENT: `duo_move` yalnızca konumu yazar (yan etkisi yoktur).
          // Bu yüzden geçici bir hatada GÜVENLE yeniden denenebilir. Sınırlı
          // üstel geri çekilme sayesinde tek bir başarısız istek oyuncuyu
          // kalıcı olarak "dondurmaz" (kök sorun).
          await withRetry(
            async () => {
              const response = await room.call('duo_move', {
                p_token: room.token ?? room.playerId,
                p_x: x,
                p_y: y,
              })
              if (!isRpcSuccess(response)) {
                // ANTI-CHEAT UZLAŞMASI: sunucu konumu erişilemez bulduysa
                // (`too_fast`) yerel oyuncuyu sunucunun YETKİLİ konumuna
                // oturturuz. Aksi halde istemci reddedilen konumu göndermeye
                // devam eder ve sunucunun depoladığı konumdan giderek uzaklaşır
                // → kalıcı desenkron. `too_fast` kalıcı bir reddir (retry.ts),
                // bu yüzden burada yeniden denemeyiz.
                const reason = (response as { reason?: unknown }).reason
                if (reason === 'too_fast') {
                  const ax = (response as { x?: unknown }).x
                  const ay = (response as { y?: unknown }).y
                  if (typeof ax === 'number' && typeof ay === 'number') {
                    moveLocal(ax, ay)
                  }
                  return
                }
                // Mantıksal red (ör. `not_ready`): yeniden denemek anlamsızsa
                // fırlatmayız; `isTransientRpcFailure` ile ayırt ederiz.
                if (!isTransientRpcFailure(response)) return
                throw new Error(`duo_move rejected: ${JSON.stringify(response)}`)
              }
            },
            FAST_RETRY_POLICY,
          )
        },
        (error) => console.warn('Failed to sync player position', error),
      )
    },
    [room, moveLocal],
  )

  const runPositionedActions = useCallback(
    (
      x: number,
      y: number,
      actions: Array<() => Promise<void>>,
      positionIncludedInAction = false,
    ) =>
      positionActionQueue.current.runActions(
        () =>
          runAfterPositionSync(
            async () => {
              const response = await room.call('duo_move', {
                p_token: room.token ?? room.playerId,
                p_x: x,
                p_y: y,
              })
              if (!isRpcSuccess(response)) {
                // ANTI-CHEAT UZLAŞMASI: `too_fast` reddinde yerel oyuncuyu
                // sunucunun yetkili konumuna oturturuz ve aksiyonu YİNE DE
                // çalıştırırız. Toplama/çalma mesafesi sunucuda SUNUCU-DEPOLU
                // konuma göre ölçüldüğü için (0047) bu güvenlidir; aksiyonu
                // iptal etmek geçerli bir toplamayı kaybettirebilirdi.
                const reason = (response as { reason?: unknown }).reason
                if (reason === 'too_fast') {
                  const ax = (response as { x?: unknown }).x
                  const ay = (response as { y?: unknown }).y
                  if (typeof ax === 'number' && typeof ay === 'number') {
                    moveLocal(ax, ay)
                  }
                  return
                }
                throw new Error(`duo_move rejected before gameplay action: ${JSON.stringify(response)}`)
              }
            },
            actions,
            positionIncludedInAction,
          ),
        positionIncludedInAction,
      ),
    [room, moveLocal],
  )

  /**
   * PLAYER BUMP — konum kuyruğuna SIRALI bir `duo_bump` yazar.
   *
   * NEDEN AYRI BİR YOL: `duo_bump` çağrısından ÖNCE `duo_move` çalıştırmak
   * YANLIŞTI. `duo_move` temas anındaki (knockback ÖNCESİ) konumu sunucuya
   * yazıyordu; oyuncu ilerlemeye devam edince bir sonraki `duo_move` sunucunun
   * depoladığı eski konuma göre "erişilemez" (`too_fast`) bulunup reddediliyor
   * ve istemci `moveLocal` ile İLK ÇARPIŞMA konumuna geri ışınlanıyordu.
   *
   * `duo_bump` zaten çağıranın konumunu `duo_step_ok` ile doğrulayıp kendisi
   * yazar; bu yüzden öncesinde ayrı bir `duo_move` GEREKSİZDİR. Bu yol yalnızca
   * `duo_bump`'ı konum kuyruğuna ekler (böylece diğer konum yazımlarıyla
   * sıralı kalır) ve sunucunun döndürdüğü yetkili konumlara uzlaşır.
   */
  const runBump = useCallback(
    (x: number, y: number, onResolved: (result: unknown) => void) => {
      positionActionQueue.current.enqueueMove(
        async () => {
          const response = await room.call('duo_bump', {
            p_token: room.token ?? room.playerId,
            p_x: x,
            p_y: y,
          })
          onResolved(response)
        },
        (error) => console.warn('Failed to resolve player bump', error),
      )
    },
    [room],
  )

  const advancePhase = useCallback(
    async (from: Phase) => {
      let data: {
        phase?: Phase
        winner?: string
        roundScores?: Record<string, number>
        matchScores?: Record<string, number>
        serverNow?: number
        endsAt?: number
      } | null = null
      try {
        data = await room.call<{
          phase?: Phase
          winner?: string
          roundScores?: Record<string, number>
          matchScores?: Record<string, number>
          serverNow?: number
          endsAt?: number
        }>('duo_advance_phase', { p_token: room.token ?? room.playerId })
      } catch {
        // Sunucu `not_ready` fırlattı (istemci saati sunucudan ileride olabilir).
        // Aşağıdaki `from === 'countdown'` dalı yeniden dener.
        data = null
      }
      if (data?.phase) {
        noteServerNow(data.serverNow)
        const localEndsAt = toLocal(data.endsAt)
        setState((prev) => {
          // SKOR OTORİTESİ (SUNUCU): `duo_tick` artık periyodik çağrıldığı için
          // sunucu `score` sütununu GERÇEKTEN günceller; `duo_advance_phase`
          // gerçek `roundScores`/`matchScores`/`winner` döndürür. Bu yüzden
          // sunucu değerlerini doğrudan uygularız. Sunucu değeri yoksa (eski oda
          // / geçiş anı) yerel roundScore'lardan üretiriz.
          const serverRound = data.roundScores
          const serverMatch = data.matchScores
          let roundScores = prev.roundScores
          let matchScores = prev.matchScores
          if (from === 'battle' && data.phase !== 'battle') {
            roundScores = {
              p1: prev.players[0]?.roundScore ?? 0,
              p2: prev.players[1]?.roundScore ?? 0,
            }
            matchScores = {
              p1: (prev.matchScores?.p1 ?? 0) + roundScores.p1,
              p2: (prev.matchScores?.p2 ?? 0) + roundScores.p2,
            }
          }
          // SLOT EŞLEME: Sunucu skorları SUNUCU slotlarıyla anahtarlıdır;
          // yerel state YEREL slot bekler. `mapScores` ile çeviririz.
          const mappedRound = mapScores(serverRound, room.playerId)
          const mappedMatch = mapScores(serverMatch, room.playerId)
          if (mappedRound) roundScores = mappedRound
          if (mappedMatch) matchScores = mappedMatch
          // KAZANAN: Sunucu artık skoru tuttuğu için `winner` alanı güvenilirdir.
          //
          // ÖNEMLİ (SLOT EŞLEME): Sunucunun `winner` alanı SUNUCU slotudur
          // (`player_id` = 'p1'/'p2'). Yerel state'te `winner` ise YEREL slottur
          // (slot 0 = 'p1' = ben, slot 1 = 'p2' = rakip). Bu yüzden sunucu
          // değerini `mapPlayerId` ile yerel slota çeviririz; aksi halde p2
          // istemcisi sunucunun 'p1' (yani RAKİP) değerini "ben kazandım" sanar
          // ve iki oyuncu da "Victory!" görür.
          const nextPhase = data.phase as Phase
          const winner =
            (data.winner ? mapPlayerId(data.winner, room.playerId) : undefined) ??
            (nextPhase === 'matchover' ? winnerFromScores(matchScores) : prev.winner)
          return {
            ...prev,
            phase: nextPhase,
            winner,
            roundScores,
            matchScores,
            endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          }
        })
      } else if (from === 'countdown') {
        // Sunucu henüz `not_ready` döndürdü (istemci saati sunucudan ileride
        // olabilir). Yerel fazı ilerletmeyiz; kısa aralıklarla yeniden deneriz
        // ki sunucu da `battle`'a geçsin. `useGameLoop` bu fonksiyonu her
        // karede çağırmaz, bu yüzden burada kendi zamanlayıcımızı kurarız.
        if (retryRef.current) window.clearTimeout(retryRef.current)
        retryRef.current = window.setTimeout(() => {
          retryRef.current = 0
          void advancePhaseRef.current?.('countdown')
        }, 400)
      } else {
        // Offline: yerel geçiş.
        setState((prev) => {
          if (from === 'battle') {
            const roundScores = { p1: prev.players[0]?.roundScore ?? 0, p2: prev.players[1]?.roundScore ?? 0 }
            const matchScores = {
              p1: (prev.matchScores?.p1 ?? 0) + roundScores.p1,
              p2: (prev.matchScores?.p2 ?? 0) + roundScores.p2,
            }
            const isLast = prev.round >= MATCH_ROUNDS
            const winner = matchScores.p1 === matchScores.p2 ? undefined : matchScores.p1 > matchScores.p2 ? 'p1' : 'p2'
            return {
              ...prev,
              phase: isLast ? 'matchover' : 'results',
              roundScores,
              matchScores,
              winner: isLast ? winner : undefined,
            }
          }
          return prev
        })
      }
    },
    [noteServerNow, room, setState, toLocal],
  )

  // `advancePhase`'in kendi kendini yeniden deneyebilmesi için güncel kimliği
  // ref'te tutarız; ayrıca bileşen sökülürken bekleyen zamanlayıcıyı temizleriz.
  useEffect(() => {
    advancePhaseRef.current = advancePhase
    return () => {
      if (retryRef.current) window.clearTimeout(retryRef.current)
      retryRef.current = 0
    }
  }, [advancePhase])

  // AYNALAMA YOK. Dünya her iki istemcide de aynen çizilir: `p1` solda,
  // `p2` sağda başlar. Girdi ve render aynı (ekran = dünya) koordinat
  // uzayındadır; bu yüzden `useGameLoop`'a ayrıca bir yön bayrağı geçmiyoruz.
  const loop = useGameLoop({
    state,
    setState,
    token: room.token,
    // Yerel oyuncunun sunucu slotu. Yayınlanan `collect`/`steal`/`score`
    // olaylarında `by` alanına yazılır; böylece karşı taraf kendi yayınını
    // doğru şekilde ayırt edebilir.
    playerId: room.playerId,
    publishMove,
    runPositionedActions,
    runBump,
    broadcast: room.broadcast,
    call: room.call,
    syncChaos: chaos.sync,
    advancePhase,
    remotePos,
  })

  // Sanal joystick girdisini döngüye bağlar. `VirtualJoystick` bu setter'ı
  // çağırır; değer bir ref'te tutulduğu için pointer hareketi React render'ı
  // tetiklemez (yalnızca RAF okur).
  const onJoystick = loop.setJoystick
  // Yerel oyuncunun ve rakibin ekrana basılan konumları. `Battle` bunları
  // doğrudan DOM'a yazar; 60Hz hareket React render'ı tetiklemez.
  const livePos = loop.livePos
  const liveRivalPos = loop.liveRivalPos
  // Son görev tamamlanma anı. `Battle` bunu izleyip küçük kutlama gösterir.
  const celebrateRef = loop.celebrateRef
  // Elmas (jackpot) toplama anı/konumu. `Battle` bunu izleyip elmasın üstünde
  // uçan "+50" rozetini gösterir.
  const diamondPopRef = loop.diamondPopRef
  // COMBO serisi (ardışık toplama). `Battle` HUD'da "x3 COMBO" rozetini gösterir.
  const comboRef = loop.comboRef
  // Uçan puan rozetleri (+5/+15/+25/+50). `Battle` bunları arena'ya basar.
  const scorePopRef = loop.scorePopRef
  // Ekran sarsıntısı (çalma/çarpışma). `Battle` arena'ya shake uygular.
  const shakeRef = loop.shakeRef

  // Realtime olaylarını bağla.
  useEffect(() => {
    // RAKİP HÂLÂ OYNUYOR SİNYALİ: Rakip her `move`/`collect`/`steal`/`score`
    // yayınında "buradayım" damgasını günceller. Presence (Supabase) güvenilmez
    // olduğundan — sekme arka plana düşünce veya kanal yeniden abone olurken
    // `sync` boş dönebiliyor — "rakip ayrıldı" kararını presence'a TEK BAŞINA
    // bırakmayız. Rakip canlı yayın gönderiyorsa kesinlikle oyundadır.
    //
    // NOT: Bu fonksiyon, kendisini kullanan işleyicilerden (offMove/offCollect/
    // offSteal/offTrail/offHello/offScore) ÖNCE tanımlanmalıdır. Aksi halde
    // `const` temporal-dead-zone nedeniyle kırılgan bir sıralamaya bağlı kalır.
    const noteRivalAlive = () => {
      setRivalAliveAt(Date.now())
      // Canlı sinyal geldiyse "ayrıldı" bayrağını da temizle.
      setRivalLeft(false)
    }

    // Rakip hareketi: yalnızca HEDEFİ kaydederiz, state'e yazmayız.
    //
    // Neden: broadcast 60Hz gelir. Her pakette `setState` çağırmak saniyede
    // 60 render tetikler ve döngünün kendi interpolasyonuyla çakışır — bu da
    // hareketin "laglı/titrek" görünmesine yol açar. Bunun yerine hedefi
    // `remotePos`'a yazarız; `useGameLoop` her karede yumuşakça yaklaştırır ve
    // tek bir `setState` ile ekrana basar.
    const offMove = room.on('move', (payload) => {
      const data = payload as { by?: string; x?: number; y?: number }
      if (!data || data.by === room.playerId) return
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return
      // Gönderenin SLOTU ile anahtarla (`p1`/`p2`). Ayrıca kanonik `'rival'`
      // anahtarına da yazarız; böylece hem slot bazlı hem de eski `'rival'`
      // bazlı okuyucular aynı taze konumu görür. Bu, "rakip hareketi bende
      // görünmüyor" hatasının kalıcı çözümüdür.
      const at = Date.now()
      const slot = data.by ?? 'rival'
      remotePos.current.set(slot, { x: data.x, y: data.y, at })
      remotePos.current.set('rival', { x: data.x, y: data.y, at })
      // Rakip canlı hareket ediyor → "ayrıldı" bayrağını kesin temizle.
      noteRivalAlive()
    })

    const offCollect = room.on('collect', (payload) => {
      const data = payload as {
        ids?: number[]
        by?: string
        respawnAt?: number
        diamond?: boolean
        objectiveState?: import('./objectiveSync').AuthoritativeActionState
        round?: number
      }
      if (!data || data.by === room.playerId || !data.ids || data.ids.length === 0) return
      const ids = new Set(data.ids)
      noteRivalAlive()
      const authoritativeState = data.objectiveState
      const actionRound = data.round
      if (authoritativeState && typeof actionRound === 'number') {
        setState((prev) => applyAuthoritativeRivalState(prev, authoritativeState, actionRound))
      }
      // Rakip ELMASI (jackpot) aldıysa ayırt edici sesi çalarız: elmas tek
      // seferlik ve 50 puanlık olduğundan, oyuncu büyük ödülü KAYBETTİĞİNİ
      // net hisseder. `diamond` bayrağı `useGameLoop` collect yayınından gelir.
      if (data.diamond) playSound('jackpot')
      // Rakip topladığında da coin AYNI konumda, 3 sn sonra yeniden doğar.
      // `respawnAt` yazmazsak coin sonsuza dek toplanmış kalır ve bir daha
      // görünmez; bu da "coin kayboldu" hissi verir.
      //
      // ÖNEMLİ: `respawnAt`'i gönderen tarafın verdiği değerle (varsa) kurarız;
      // böylece iki istemci AYNI anda canlandırır. Yoksa yerel saatten türetiriz.
      //
      // ELMAS İSTİSNASI: Elmas tek seferliktir; sunucu elmasları canlandırmaz.
      // Bu yüzden elmas için `respawnAt` YAZMAYIZ — aksi halde rakip elması
      // aldığında istemci 3 sn sonra onu yeniden gösterirdi.
      const respawnAt =
        typeof data.respawnAt === 'number' && data.respawnAt > 0
          ? data.respawnAt
          : Date.now() + COIN_RESPAWN_MS
      setState((prev) => {
        if (typeof actionRound === 'number' && prev.round !== actionRound) return prev
        const coins = prev.coins.map((coin) => {
          if (!ids.has(coin.id)) return coin
          if (coin.collectedBy) return coin
          // Elmas tek seferlik: respawn planlama.
          const nextRespawnAt = coin.type === 'diamond' ? undefined : respawnAt
          return { ...coin, collectedBy: 'p2' as const, respawnAt: nextRespawnAt }
        })
        if (coins.every((coin, index) => coin === prev.coins[index])) return prev
        return { ...prev, coins }
      })
    })

    const offEmote = room.on('emote', (payload) => {
      const data = payload as { by?: string; id?: EmoteId }
      if (!data || data.by === room.playerId || !data.id) return
      // `cosmeticsRef` üzerinden okuruz: effect artık `cosmetics`'e bağımlı
      // değil (her emote animasyonunda yeniden bağlanmasın diye).
      cosmeticsRef.current.showRemoteEmote(data.id)
      const emoteId = data.id
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, emote: emoteId } : player,
        ),
      }))
      // KÖK SORUN ("emojinin adı emoji yok olunca da ekranda kalıyor"):
      // Rakibin emote etiketi (`avatar-emote`) yalnızca yeni bir emote
      // geldiğinde güncelleniyordu; hiçbir zaman TEMİZLENMİYORDU. Bu yüzden
      // emote animasyonu bittikten sonra da rakibin üstünde asılı kalıyordu.
      // Çözüm: yerel emote süresi (EMOTE_MS) dolduğunda rakibin emote'unu da
      // temizle. Yeni bir emote gelirse bu zamanlayıcı iptal edilip yeniden
      // kurulur (aşağıdaki `clearTimeout`).
      if (remoteEmoteTimer.current) window.clearTimeout(remoteEmoteTimer.current)
      remoteEmoteTimer.current = window.setTimeout(() => {
        remoteEmoteTimer.current = 0
        setState((prev) => ({
          ...prev,
          players: prev.players.map((player, index) =>
            index === 1 && player.emote === emoteId ? { ...player, emote: null } : player,
          ),
        }))
      }, EMOTE_MS)
    })

    // Rakip iz (trail) seçimini değiştirdiğinde anında yansıt.
    const offTrail = room.on('trail', (payload) => {
      const data = payload as { by?: string; id?: TrailId }
      if (!data || data.by === room.playerId || !data.id) return
      // `trail` her 3 saniyede bir yayınlanan HEARTBEAT'tir. Bunu yalnızca
      // kozmetik güncelleme olarak görmek YETMEZ: rakip hareketsiz durup hiç
      // coin toplamadığında `move`/`collect`/`steal`/`score` yayını gelmez ve
      // `rivalAliveAt` bayatlar → yanlış "rakip ayrıldı" popup'ı çıkar. Bu
      // yüzden heartbeat'i de bir CANLILIK sinyali sayarız.
      noteRivalAlive()
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, trail: data.id ?? 'none' } : player,
        ),
      }))
    })

    // Rakip avatarını değiştirdiğinde anında yansıt. `avatar` da periyodik
    // heartbeat olarak yayınlanır; bu yüzden CANLILIK sinyali sayarız.
    const offAvatar = room.on('avatar', (payload) => {
      const data = payload as { by?: string; id?: AvatarId }
      if (!data || data.by === room.playerId || !data.id) return
      noteRivalAlive()
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, avatar: data.id } : player,
        ),
      }))
    })

    // Rakip adını değiştirdiğinde anında yansıt.
    const offName = room.on('name', (payload) => {
      const data = payload as { by?: string; name?: string }
      if (!data || data.by === room.playerId || !data.name) return
      const nextName = data.name.trim().slice(0, 16)
      if (!nextName) return
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, name: nextName } : player,
        ),
      }))
    })

    // Rakip oyundan ayrıldığında oyunu duraklat ve kullanıcıyı bilgilendir.
    //
    // ÖNEMLİ: 'leave' yayını TEK BAŞINA "rakip gitti" demek için yeterli
    // DEĞİLDİR. Kanal yeniden abone olurken (reconnect) veya sekme arka plana
    // düşüp geri geldiğinde Supabase istemcisi kısa bir 'leave'/'join' döngüsü
    // üretebiliyor; bu da iki oyuncu da oynarken yanlış "rakip ayrıldı"
    // uyarısına yol açıyordu. Bu yüzden yalnızca bir "aday" işaretleriz;
    // gerçek kararı aşağıdaki `rivalGone` (sürekli yokluk + canlı sinyal yok)
     // verir.
    const offLeave = room.on('leave', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      setRivalLeft(true)
    })

    // SKOR SENKRONU: `duo_tick` çağrılmadığı için sunucu skoru güncellemez.
    // Rakip, kendi skor değişimini `score` olayıyla yayınlar; burada onu
    // rakibin (index 1) skoruna ekleriz. Böylece iki taraf da aynı puanı görür.
    // Rakip "sonraki tur" için onay verdi mi? İki oyuncu da onaylayınca tur
    // başlar. Bu, "next round iki oyuncunun da onayıyla başlamalı" isteğini
    // karşılar: host tek başına turu başlatamaz.
    const offNextReady = room.on('next-ready', (payload) => {
      const data = payload as { by?: string; round?: number }
      if (!data || data.by === room.playerId) return
      // ÖNEMLİ: Onayı TUR NUMARASINA bağlarız. Eski kod yalnızca `by` alanına
      // bakıyordu; önceki turdan GECİKMİŞ bir `next-ready` paketi (veya
      // heartbeat) yeni turun sonuç ekranında `rivalNextReady`'yi yeniden
      // `true` yapıyor ve host, rakip hiç onay vermeden turu başlatıyordu
      // ("bir oyuncu next round demeden tur başladı" hatası).
      //
      // KÖK SORUN ("Waiting for your rival to accept… ikiside kabul ettiği
      // halde"): Eski kontrol TAM EŞİTLİK istiyordu (`data.round !== currentRound`
      // → yok say). Ancak iki istemcinin tur sayacı, yoklama gecikmesi yüzünden
      // KISA SÜRE farklı olabiliyor (biri N, diğeri N+1). Bu durumda geçerli bir
      // onay paketi "eski tur" sanılıp reddediliyor ve İKİ taraf da birbirini
      // bekliyordu. Doğru kural: yalnızca GERÇEKTEN ESKİ turdan gelen paketleri
      // (data.round < currentRound) yok sayarız; aynı VEYA daha yeni turdan gelen
      // onayı kabul ederiz. Böylece gecikmiş ama geçerli onay el sıkışmayı
      // tamamlar; önceki turdan sızan paket yine engellenir.
      const currentRound = roundRef.current
      if (typeof data.round === 'number' && data.round < currentRound) return
      setRivalNextReady(true)
      // Host, rakibin onayını alınca ve kendisi de onaylamışsa turu başlatır.
      // (Effect yerine olay işleyicisinde başlatırız; lint kuralı gereği.)
      if (nextReadyRef.current && room.playerId === 'p1') {
        void beginNextRoundRef.current?.()
      }
    })

    // RÖVANŞ ONAYI: Rakip "rematch" için hazır olduğunu bildirir. Sunucu
    // tarafı iki onayı da görünce odayı `lobby`'ye çeker; istemci faz
    // uzlaşmasıyla oraya geçer. Burada yalnızca UI durumunu işaretleriz.
    const offRematchReady = room.on('rematch-ready', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      setRivalRematchReady(true)
    })

    // RAKİP GERİ DÖNDÜ: Rakip yeniden bağlandığında (broadcast 'hello' veya
    // presence yeniden göründüğünde) "rakip ayrıldı" uyarısını KESİN olarak
    // kapatırız. Aksi halde rakip geri gelse bile popup ekranda kalıyordu.
    const offHello = room.on('hello', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      // `hello` bir CANLILIK sinyalidir: rakip yeniden bağlandı. Yalnızca
      // `rivalLeft`'i temizlemek yetmez; `rivalAliveAt`'i de tazelemeliyiz.
      // Aksi halde presence henüz yeniden senkron olmadan `rivalSilentLongEnough`
      // true kalır ve `rivalGone` popup'ı hemen geri gelir (yanıp söner).
      noteRivalAlive()
    })

    // SKOR SENKRONU: Rakip MUTLAK skorunu yayınlar; biz de rakibin (index 1)
    // skorunu bu değere EŞİTLERİZ. Delta eklemek yerine eşitlemek, kaçan bir
    // paketin kalıcı sapmaya yol açmasını engeller (her yayın kendini düzeltir).
    // Geriye dönük uyumluluk için `delta` alanı da desteklenir.
    // SKOR YAYINI — yalnızca CANLILIK sinyali olarak kullanılır.
    //
    // Skor artık SUNUCUDA tutulur (`duo_players.score`) ve `duo_public_state`
    // yoklaması gerçek değeri uygular. Bu yüzden burada rakibin skorunu
    // broadcast'ten EZMEYİZ; aksi halde iki kaynak (broadcast vs sunucu)
    // çakışır ve "puanlar birbirinden farklı görünüyor" hatası geri gelir.
    // Yayını yalnızca "rakip hâlâ oyunda" sinyali olarak değerlendiririz.
    const offScore = room.on('score', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      noteRivalAlive()
    })

    return () => {
      offNextReady()
      offRematchReady()
      offHello()
      offMove()
      offCollect()
      offEmote()
      offTrail()
      offAvatar()
      offName()
      offLeave()
      offScore()
      if (remoteEmoteTimer.current) {
        window.clearTimeout(remoteEmoteTimer.current)
        remoteEmoteTimer.current = 0
      }
    }
  }, [room, setState])

  // Sunucu snapshot'ını periyodik çek.
  //
  // Maliyet optimizasyonu: yalnızca aktif oyun fazlarında (countdown/battle)
  // ve sekme görünürken çalışır. Lobby/home/results fazlarında hiç istek
  // atılmaz — bu fazlardaki değişimler zaten realtime broadcast ile gelir.
  // Aralık `POLL_MS` haritasından seçilir (battle'da 1s, countdown'da 0.5s).
  useEffect(() => {
    const code = room.code
    if (!code) return
    const active = state.phase === 'countdown' || state.phase === 'battle'
    if (!active) return
    const myId = room.playerId
    const myToken = room.token ?? room.playerId
    let cancelled = false
    const pull = async () => {
      let data: PublicSnapshot | null = null
      try {
        data = await callRef.current<PublicSnapshot>('duo_public_state', { p_token: myToken })
      } catch {
        // Oda silinmiş olabilir (rakip çıktı / leave). Sessizce dur; UI'yi bozma.
        return
      }
      if (cancelled || !data) return
      // SUNUCU OTORİTESİ (oyuncu sayısı): `rivalGone` kararı presence'a
      // (güvenilmez) değil, sunucunun GERÇEK oyuncu satırı sayısına dayanmalı.
      // Bu değeri savaş sırasında da güncelleriz; aksi halde maç boyunca lobiden
      // kalan bayat değer kullanılır ve sunucu rakibin gittiğini asla bildiremez.
      if (typeof data.playerCount === 'number') setServerPlayerCount(data.playerCount)
      // Sunucu saat farkını güncelle, sonra deadline'ları yerel saate çevir.
      noteServerNow(data.serverNow)
      const localEndsAt = toLocal(data.endsAt)
      const localCountdownEndsAt = toLocal(data.countdownEndsAt)
      // En son sunucu deadline'larını sakla: misafir yeni turda `resetRound`
      // çağırınca bu değerler sıfırlanır; resetten sonra geri yazarız.
      if (localCountdownEndsAt > 0) serverDeadlineRef.current.countdownEndsAt = localCountdownEndsAt
      if (localEndsAt > 0) serverDeadlineRef.current.endsAt = localEndsAt
      setState((prev) => {
        if (typeof data.round === 'number' && data.round < prev.round) return prev
        const players = prev.players.map((player) => {
          const server = data.players?.find((item) => mapPlayerId(String(item.id), myId) === player.id)
          if (!server) return player
          // Sunucudan gelen adı koru; boşsa mevcut adı bırak.
          const serverName = typeof server.name === 'string' && server.name.trim() ? server.name : player.name
          // KÖK SORUN DÜZELTMESİ (İKİ İSTEMCİ FARKLI İLERLEME GÖRÜYOR):
          // `{ ...player, ...server }` ham yayılımı sunucunun `objective`,
          // `objectiveProgress` ve `objectivesDone` alanlarını KOŞULSUZ uygular.
          // Bu alanlar birbirine BAĞLI bir üçlüdür (görev kimliği + ilerleme +
          // sürüm damgası); ham yayılım bunları AYRIŞTIRIR. Örneğin sunucu
          // görevi reroll ettiyse `objective` yeni görev olur ama
          // `objectiveProgress` aşağıdaki `mergeProgress` ile ESKİ göreve göre
          // hesaplanır → "görev A ama ilerleme B" uyumsuzluğu. Ayrıca
          // `objectivesDone` ham yayılımla uygulanınca `mergeProgress`'in bayat
          // snapshot koruması devre dışı kalır. Bu üç alanı yayılımdan ÇIKARIR,
          // yalnızca aşağıdaki atomik mantıkla uygularız.
          const merged = { ...player, ...server, id: player.id, name: serverName } as Player
          // Görev üçlüsünü yerel değerlere GERİ AL; aşağıda atomik olarak
          // (kimlik + ilerleme + damga birlikte) uygulanır.
          merged.objective = player.objective
          merged.objectiveProgress = player.objectiveProgress
          merged.objectivesDone = player.objectivesDone
          // İYİMSER İLERLEME (MONOTONİK): Yerel oyuncu (index 0) için
          // `collectedTypes`/`coins`/`roundCoins`/`stolen`/`roundStolen` alanları
          // sunucu snapshot'ı ile EZİLMEZ; yalnızca ARTABİLİR. Sunucu `duo_collect`
          // RPC'sini henüz işlemediyse snapshot BAYATTIR ve doğrudan uygulamak
          // yerel ilerlemeyi geri alır ("collect → ilerleme kaybolur" hatası).
          // Görev değiştiyse (sunucu yeni görev atayıp sayaçları sıfırladıysa)
          // tabanı sıfırlarız; aksi halde eski görevin sayıları taşınırdı.
          if (player.id === 'p1') {
            const localObjectiveId = player.objective?.id ?? null
            const serverObjectiveId = server.objective?.id ?? null
            // BAYAT SNAPSHOT KORUMASI (KÖK SORUN): `objectivesDone` monotonik
            // sürüm damgasıdır. Sunucu snapshot'ı yerelden GERİDE ise (ör. gecikmiş
            // bir yanıt) görev KİMLİĞİNİ de uygulamamalıyız; aksi halde eski görev
            // diriltilir ve kimlik/ilerleme ayrışır ("görev A ama ilerleme B").
            const serverDone =
              typeof server.objectivesDone === 'number' ? server.objectivesDone : undefined
            const localDone = typeof player.objectivesDone === 'number' ? player.objectivesDone : 0
            const staleSnapshot = serverDone !== undefined && serverDone < localDone
            const objectiveChanged =
              !staleSnapshot && serverObjectiveId !== null && serverObjectiveId !== localObjectiveId
            const progress = mergeProgress(player, server, objectiveChanged)
            merged.coins = progress.coins
            merged.stolen = progress.stolen
            merged.roundCoins = progress.roundCoins
            merged.roundStolen = progress.roundStolen
            merged.collectedTypes = progress.collectedTypes
            merged.objectiveProgress = progress.objectiveProgress
            // GÖREV KİMLİĞİ (ATOMİK): sunucu görevi GERÇEKTEN değiştirdiyse
            // (reroll) yeni görevi AYNI anda uygularız. `mergeProgress` bu
            // durumda ilerlemeyi sunucudan AYNEN aldığı için kimlik + ilerleme
            // tutarlı kalır. Görev değişmediyse ya da snapshot BAYATSA yerel
            // kimliği koruruz (ham yayılım zaten geri alındı).
            if (objectiveChanged && server.objective) {
              merged.objective = server.objective
            }
            // `objectivesDone` MONOTONİK sürüm damgası: yalnızca İLERİ alınır.
            // Bayat snapshot geride kalırsa yerel değeri koruruz; aksi halde
            // `mergeProgress`'in bayat koruması bir sonraki yoklamada bozulur.
            if (serverDone !== undefined && serverDone >= localDone) {
              merged.objectivesDone = serverDone
            }
            // `missionDone` MONOTONİK: görev değişmediyse sunucunun bayat
            // `false` değeri yerel `true`'yu EZEMEZ (kutlama bayrağı geri
            // alınırsa "Mission complete" tekrar tekrar tetiklenir). Görev
            // değiştiyse sunucu değeri (yeni görev için `false`) geçerlidir.
            if (!objectiveChanged) {
              merged.missionDone = Boolean(player.missionDone || server.missionDone)
            }
          }
          // SUNUCU OTORİTESİ (skor + ilerleme): `duo_tick` artık periyodik
          // çağrıldığı için sunucu skoru, coin/görev ilerlemesini ve
          // `missionDone`'ı GERÇEKTEN günceller. Bu yüzden bu alanları
          // sunucudan uygularız — istemci-taraflı skor yönetimi kaldırıldı.
          // (Kullanıcı "konum ve puan konularını localle yönetmicez" dedi.)
          //
          // KONUM: yerel oyuncunun (index 0) x/y'si HER ZAMAN yerel döngüye
          // aittir; sunucu snapshot'ı gecikmeli gelir ve uygularsak oyuncu her
          // yoklamada geriye zıplar. Rakip (index 1) konumu ise canlı `move`
          // broadcast'i tazeyse broadcast'ten, değilse sunucudan alınır.
          if (player.id === 'p1') {
            merged.x = player.x
            merged.y = player.y
            // `slowedUntil` sunucu saatine göre damgalanır; saat farkı yüzünden
            // yanlış yorumlanmasın diye yerel değeri koruruz.
            merged.slowedUntil = player.slowedUntil
          }
          if (player.id === 'p2') {
            // Rakip konumu: canlı `move` broadcast'i sunucunun gecikmeli x/y'sinden
            // HER ZAMAN daha tazedir. Bu yüzden bu turda rakip için EN AZ BİR
            // broadcast görüldüyse, sunucu snapshot'ı konumu EZMEZ.
            //
            // KÖK SORUNLAR:
            //  1. ("bir süre sonra rakip sabit/donuk görünüyor") Eski kodda
            //     `rivalBroadcastSeenRef` KALICI bir mandaldı; bir kez broadcast
            //     görülünce sunucu snapshot'ı SONSUZA DEK devre dışı kalıyordu ve
            //     broadcast sessizce durunca rakip donuyordu.
            //  2. ("hareket etmelerine rağmen bazen durup kalıyorlar") Mandalı
            //     `REMOTE_HARD_TTL_MS` (3 sn) ile sınırlamak da yetersizdi:
            //     broadcast 3 sn'den uzun kesilince sunucu snapshot'ı (≈1 sn
            //     gecikmeli, üstelik `duo_move` heartbeat'i de aynı yoldan
            //     geciktiği için BAYAT) konumu eziyordu. Rakip gerçekte hareket
            //     ederken ekranda DONUYORDU.
            //
            // ÇÖZÜM: `remotePos` girdisinin VARLIĞINI esas alırız (yaşını değil).
            //   - Bu turda rakip broadcast'i GÖRÜLDÜYSE → yerel konumu KORU.
            //     `useGameLoop` zaten bayat broadcast'te son bilinen konumu tutar
            //     ve `REMOTE_HARD_TTL_MS` sonrası sunucuya yumuşakça devreder;
            //     burada sunucuyla EZMEK o mantığı bozuyordu.
            //   - Hiç broadcast GÖRÜLMEDİYSE (geç katılma / kanal sorunu) →
            //     sunucu snapshot'ı başlangıç konumunu sağlar.
            //
            // Rakibin GERÇEK slotunu kullanırız (yerel `p2` isek rakip `p1`'dir);
            // eski kod sabit `'p2'` okuduğu için yanlış anahtara bakabiliyordu.
            const rivalSlot = player.id === 'p2' ? 'p1' : 'p2'
            const remote =
              remotePos.current.get(rivalSlot) ??
              remotePos.current.get('rival') ??
              remotePos.current.get('p2')
            if (!remote) {
              merged.x = player.x
              merged.y = player.y
            }
            // Kozmetikler (trail/emote/avatar) broadcast ile gelir; sunucu
            // bunları güncellemez, bu yüzden yerel değerleri koruruz.
            merged.trail = player.trail
            merged.emote = player.emote
            merged.avatar = player.avatar
            // RAKİBİN GÖREV İLERLEMESİ — SUNUCU OTORİTESİ (KÖK SORUN DÜZELTMESİ).
            //
            // KÖK SORUN ("görev sahibi 2/3, rakip 3/3 görüyor"): Rakip istemci,
            // sahibin ilerlemesini KENDİ yerel collect/steal yayınlarından
            // türetiyordu ve `mergeProgress` monotonik (`Math.max`) olduğu için
            // yerel değer sunucunun otoriter değerinin ÜSTÜNE çıktığında BİR DAHA
            // düşmüyordu. Örnek: sahip sunucuda 2 çalma yapmışken rakip istemci
            // 3 çalma yayını görmüşse rakip kalıcı olarak "3/3" gösteriyordu.
            //
            // ÇÖZÜM: Rakip de yalnızca sunucu ilerlemesini uygular. Artık
            // yayınlardan yerel objectiveProgress türetilmediği için aynı görev
            // içinde `Math.max` stale poll yanıtlarının ilerlemeyi geri almasını
            // engeller; reroll'da görev kimliği + ilerleme birlikte sıfırlanır.
            // Eski objective sürümündeki snapshot ayrıca reddedilir.
            const rivalLocalObjectiveId = player.objective?.id ?? null
            const rivalServerObjectiveId = server.objective?.id ?? null
            const rivalServerDone =
              typeof server.objectivesDone === 'number' ? server.objectivesDone : undefined
            const rivalLocalDone =
              typeof player.objectivesDone === 'number' ? player.objectivesDone : 0
            const rivalStaleSnapshot =
              rivalServerDone !== undefined && rivalServerDone < rivalLocalDone
            const rivalObjectiveChanged =
              !rivalStaleSnapshot &&
              rivalServerObjectiveId !== null &&
              rivalServerObjectiveId !== rivalLocalObjectiveId
            const rivalProgress = mergeRivalProgress(player, server, rivalObjectiveChanged)
            merged.coins = rivalProgress.coins
            merged.stolen = rivalProgress.stolen
            merged.roundCoins = rivalProgress.roundCoins
            merged.roundStolen = rivalProgress.roundStolen
            merged.collectedTypes = rivalProgress.collectedTypes
            merged.objectiveProgress = rivalProgress.objectiveProgress
            // GÖREV KİMLİĞİ (ATOMİK) — RAKİP: sunucu rakibin görevini
            // değiştirdiyse yeni görevi AYNI anda uygularız; böylece rakip
            // HUD'unda "görev A ama ilerleme B" uyumsuzluğu oluşmaz. Bu,
            // "aynı görev iki oyuncuda farklı ilerleme gösteriyor" hatasının
            // kök nedenidir: ham yayılım `objective`'i sunucudan alırken
            // `objectiveProgress` yerel göreve göre hesaplanıyordu. Snapshot
            // BAYATSA kimliği de uygulamayız (eski görev diriltilmesin).
            if (rivalObjectiveChanged && server.objective) {
              merged.objective = server.objective
            }
            // `objectivesDone` MONOTONİK sürüm damgası (rakip): yalnızca İLERİ.
            if (rivalServerDone !== undefined && rivalServerDone >= rivalLocalDone) {
              merged.objectivesDone = rivalServerDone
            }
            if (!rivalObjectiveChanged) {
              merged.missionDone = Boolean(player.missionDone || server.missionDone)
            }
          }
          return merged
        })
        // Faz tek yönlü ilerler: yerel olarak `battle`'a geçtiysek sunucu
        // henüz `countdown` döndürüyor olsa bile geri düşürmeyiz. Aksi halde
        // `duo_advance_phase` commit edene kadar faz ileri-geri zıplar.
        const serverPhase = data.phase ?? prev.phase
        const phase =
          prev.phase === 'battle' && serverPhase === 'countdown' ? prev.phase : serverPhase
        // COIN OTORİTESİ (CANLI): sunucu artık coinlerin TEK otoritesidir.
          // `duo_spawn_coins` istemcinin `spawnCoins()` algoritmasını birebir
          // yansıtır; bu yüzden sunucu konumları/renkleri istemciyle AYNIDIR ve
          // güvenle uygulanabilir. Sunucu ayrıca `respawn_at`'i döndürür ve
          // okuma sırasında süresi dolan coinleri tembel olarak canlandırır.
          //
          // Yeni tur başladığında (round değiştiğinde) sunucu listesini TAM
          // olarak benimseriz; aksi halde yerel listeyle BİRLEŞTİRİRİZ. Birleştirme
          // şart: snapshot ~1 sn gecikmeli gelir; yerel oyuncu bir coini yeni
          // topladıysa ve sunucu henüz işlemediyse, doğrudan uygulamak coini bir
          // anlığına geri getirir ("coin geri geldi / titredi" hatası).
          const serverCoins = toLocalCoins(data.coins, myId, toLocal)
          // TUR MONOTONİKLİĞİ (KÖK SORUN: "beni başlangıç konumuma ışınlıyor"):
          // Sunucu bir anlığına BAYAT bir `round` döndürebilir (replica gecikmesi
          // / eşzamanlı `duo_next_round`). Eski kod `data.round`'u koşulsuz
          // uyguluyordu; tur geri gelince `useGameLoop` konumu SPAWN'a yeniden
          // tohumluyor, sonraki yoklama turu düzeltince oyuncu geri dönüyordu
          // ("ışınla → geri gel"). Turu YALNIZCA ileri yönde kabul ederiz.
          const serverRound = typeof data.round === 'number' ? data.round : prev.round
          const nextRound = serverRound > prev.round ? serverRound : prev.round
          const roundChanged = nextRound !== prev.round
          const coins = !serverCoins
            ? prev.coins
            : roundChanged
              ? serverCoins
              : mergeCoins(prev.coins, serverCoins, myId)
          // TUR SONU SKOR BİRİKİMİ: `battle`'dan çıkıyorsak (results/matchover)
          // o turun `roundScore`'larını kümülatif `matchScores`'a ekleriz. Bu
          // yol faz geçişini `advancePhase`'ten önce yakalayabilir; biriktirme
          // yapmazsak kazanan eksik skordan hesaplanır.
          // SKOR OTORİTESİ: `duo_tick` artık çağrıldığı için sunucu
          // `round_scores`/`match_scores`/`winner` alanlarını GERÇEKTEN
          // hesaplar. Bu yüzden bunları sunucudan alırız; istemci-taraflı
          // biriktirme/kazanan hesabı kaldırıldı. Sunucu değeri yoksa (eski
          // oda / geçiş anı) yerel birikime geri düşeriz.
          // SLOT EŞLEME: Sunucu skorları SUNUCU slotlarıyla anahtarlıdır;
          // yerel state YEREL slot bekler. `mapScores` ile çeviririz.
          const serverMatchScores =
            data.matchScores && Object.keys(data.matchScores).length > 0
              ? mapScores(data.matchScores, myId)
              : null
          // TUR SKORU: `advancePhase` yolunda uygulanıyordu ama canlı savaş
          // yoklamasında atlanıyordu. Sunucu `round_scores`'u hesapladığı için
          // burada da uygularız; aksi halde tur skoru istemcide bayat kalır.
          const serverRoundScores =
            data.roundScores && Object.keys(data.roundScores).length > 0
              ? mapScores(data.roundScores, myId)
              : null
          const leavingBattle = prev.phase === 'battle' && phase !== 'battle'
          const matchScores =
            serverMatchScores ??
            (leavingBattle ? accumulateMatchScores(prev.matchScores, players) : prev.matchScores)
          const roundScores = serverRoundScores ?? prev.roundScores
          // KAZANAN: Sunucunun `winner` alanı artık güvenilirdir (skor sunucuda
          // tutulur). Sunucu bir kazanan döndürdüyse onu kullanırız; yoksa
          // `matchover`'da yerel skorlardan hesaplarız.
          //
          // ÖNEMLİ (SLOT EŞLEME): Sunucu `winner`'ı SUNUCU slotuyla döndürür
          // ('p1'/'p2'); yerel state ise YEREL slot bekler. `mapPlayerId` ile
          // çeviririz; aksi halde p2 istemcisi rakibin kazandığını "ben
          // kazandım" sanar (iki taraf da "Victory!").
          const winner =
            (data.winner ? mapPlayerId(data.winner, myId) : undefined) ??
            (phase === 'matchover' ? winnerFromScores(matchScores) : prev.winner)
          return {
            ...prev,
            phase,
            // Tur MONOTONİK ilerler (yukarıdaki `nextRound`); bayat/geri tur
            // uygulanmaz.
            round: nextRound,
            endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
            countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
            winner,
            roundScores,
            matchScores,
            coins,
            players,
          }
      })
      // Sunucu chaos olayını `chaosEvent` + `chaosEventEndsAt` (sunucu epoch ms)
      // olarak döndürür. Bitiş anını yerel saate çevirip uygularız; aksi halde
      // saat farkı yüzünden sayaç yanlış görünür.
      if (data.chaosEvent?.id) {
        chaos.sync({ id: data.chaosEvent.id, endsAt: toLocal(data.chaosEventEndsAt) })
      } else {
        chaos.clear()
      }
    }

    const intervalMs = state.phase === 'countdown' ? POLL_MS.countdown : POLL_MS.battle
    let timer = 0

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return
        // Sekme arka plandaysa istek atma; görünür olunca devam et.
        if (typeof document !== 'undefined' && document.hidden) {
          schedule()
          return
        }
        await pull()
        schedule()
      }, intervalMs)
    }

    void pull()
    schedule()

    const onVisibility = () => {
      if (!document.hidden) void pull()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [chaos, noteServerNow, room.code, room.playerId, room.token, setState, state.phase, toLocal])

  // FAZ UZLAŞMASI (phase reconciliation).
  //
  // Kök sorun: oyun döngüsü yalnızca `countdown`/`battle` fazlarında çalışır ve
  // süre dolduğunda `advancePhase` ile sunucuya haber verir. Ancak bu çağrı
  // başarısız olursa (ağ hatası, `not_ready`, sekme arka plana düşmesi) istemci
  // `battle`'da takılı kalır; sunucuya ulaşabilen rakip ise `results`'a geçer.
  // Sonuç: "biri ready waiting for rival ekranındayken diğeri oyunda olabiliyor".
  //
  // Çözüm: `results`/`matchover` fazlarında (ve güvenlik ağı olarak aktif
  // fazlarda) sunucunun OTORİTE fazını periyodik olarak çekeriz. Sunucu fazı
  // yerelden ileriyse ona uyarız; böylece iki istemci de yakınsar.
  useEffect(() => {
    const code = room.code
    if (!code) return
    const phase = state.phase
    const reconcilable =
      phase === 'results' || phase === 'matchover' || phase === 'battle' || phase === 'countdown'
    if (!reconcilable) return
    const myToken = room.token ?? room.playerId
    const myId = room.playerId
    let cancelled = false
    const pull = async () => {
      let data: PublicSnapshot | null = null
      try {
        data = await callRef.current<PublicSnapshot>('duo_public_state', { p_token: myToken })
      } catch {
        return
      }
      if (cancelled || !data?.phase) return
      noteServerNow(data.serverNow)
      const localEndsAt = toLocal(data.endsAt)
      const localCountdownEndsAt = toLocal(data.countdownEndsAt)
      setState((prev) => {
        const serverRound = typeof data.round === 'number' ? data.round : prev.round
        const serverPhase = data.phase as Phase
        // A rematch resets round 3 -> 1 while transitioning matchover -> lobby.
        // Do not mistake that authoritative reset for a stale public snapshot.
        if (
          shouldIgnoreStalePhaseSnapshot(
            prev.phase,
            prev.round,
            serverPhase,
            serverRound,
          )
        ) {
          return prev
        }
        // Faz geçişleri. Döngüsel bir akış vardır: bir tur bittiğinde
        // `results`'a, yeni tur başladığında TEKRAR `countdown`'a döneriz.
        // Bu yüzden düz bir "rank" karşılaştırması YETMEZ: `results` (rank 4)
        // → `countdown` (rank 2) geçişi "geriye dönük" görünür ve misafir
        // oyuncu sonsuza dek "Both ready — starting…" ekranında takılı kalır.
        //
        // Kök sorun buydu: host `duo_start_round` çağırınca sunucu fazı
        // `countdown`'a çekiyor; ancak misafirin uzlaşma mantığı bunu
        // reddediyordu. Çözüm: geçerli İLERİ geçişleri açıkça tanımlarız.
        const order: Phase[] = ['home', 'lobby', 'countdown', 'battle', 'results', 'matchover']
        const rank = (p: Phase) => order.indexOf(p)
        const forward = (from: Phase, to: Phase) => {
          if (from === to) return false
          // Yeni tur: sonuç ekranından tekrar geri sayıma dönüş geçerlidir.
          if (from === 'results' && to === 'countdown') return true
          // Maç bitti → rövanş: `matchover` → `lobby`/`countdown` geçerlidir.
          if (from === 'matchover' && (to === 'lobby' || to === 'countdown')) return true
          // Aksi halde yalnızca ileri yönlü geçişler kabul edilir.
          return rank(to) > rank(from)
        }
        const nextPhase = forward(prev.phase, serverPhase) ? serverPhase : prev.phase
        // COIN UZLAŞMASI (güvenlik ağı): faz değişmese bile coinleri sunucuyla
        // yakınsarız. Bu, paket kaybı / sekme arka plana düşmesi / geç katılma
        // sonrası oluşan "bende var, onda yok" uyumsuzluğunu kalıcı olarak
        // onarır. Sunucu `duo_spawn_coins` ile istemciyle AYNI düzeni üretir ve
        // okuma sırasında süresi dolan coinleri tembel olarak canlandırır.
        const serverCoins = toLocalCoins(data.coins, myId, toLocal)
        // TUR MONOTONİKLİĞİ: bayat/geri sunucu turu UYGULANMAZ (bkz. battle poll
        // açıklaması). Aksi halde `useGameLoop` konumu spawn'a yeniden tohumlar ve
        // oyuncu "ışınlanıp geri gelir".
        const nextRound = serverRound > prev.round ? serverRound : prev.round
        const roundChanged = nextRound !== prev.round
        const coins = !serverCoins
          ? prev.coins
          : roundChanged
            ? serverCoins
            : mergeCoins(prev.coins, serverCoins, myId)
        const phaseChanged = nextPhase !== prev.phase
        const coinsChanged = coins !== prev.coins
        // SKOR OTORİTESİ: sunucu `match_scores`/`round_scores`/`winner` alanlarını
        // hesaplar (bkz. battle poll). Sunucu değeri varsa onu kullanırız.
        // SLOT EŞLEME: Sunucu skorları SUNUCU slotlarıyla anahtarlıdır;
        // yerel state YEREL slot bekler. `mapScores` ile çeviririz.
        const serverMatchScores =
          data.matchScores && Object.keys(data.matchScores).length > 0
            ? mapScores(data.matchScores, myId)
            : null
        const serverRoundScores =
          data.roundScores && Object.keys(data.roundScores).length > 0
            ? mapScores(data.roundScores, myId)
            : null
        const leavingBattle = prev.phase === 'battle' && nextPhase !== 'battle'
        const matchScores =
          serverMatchScores ??
          (leavingBattle ? accumulateMatchScores(prev.matchScores, prev.players) : prev.matchScores)
        const roundScores = serverRoundScores ?? prev.roundScores
        // OYUNCU SKORLARI + TUR İSTATİSTİKLERİ (ÇELİŞKİLİ SONUÇ EKRANI
        // DÜZELTMESİ): Sunucu `duo_tick` tur bitişinde her oyuncunun
        // `score`/`round_score`/`total_score` alanlarını hesaplar; ayrıca
        // `duo_collect`/`duo_steal` tur boyunca `round_coins`/`round_stolen`
        // sayaçlarını GERÇEKTEN artırır (bkz. 0027_round_stats_authority.sql).
        //
        // KÖK SORUN (İKİ İSTEMCİ FARKLI SONUÇ GÖRÜYOR): Bu effect
        // `results`/`matchover` fazlarında çalışır — yani SONUÇ EKRANI
        // görünürken. Eski kod YALNIZCA `score`/`roundScore`/`totalScore`
        // uyguluyordu; `roundCoins`/`roundStolen`/`coins`/`stolen`/
        // `collectedTypes` UYGULAMIYORDU. Savaş yoklaması (bunları uygulayan
        // tek yer) faz `battle`'dan çıkınca DURUR. Sonuç: sonuç ekranı, her
        // istemcinin savaş sırasında biriktirdiği İYİMSER (ıraksayan) tur
        // istatistiklerini gösteriyordu → Melih 🪙50 görürken PLAYER 2 Melih'i
        // 🪙42 görüyordu. Skorlar sunucudan geldiği için tutarlıydı ama tur
        // istatistikleri desenkrondu.
        //
        // ÇÖZÜM: Burada da `roundCoins`/`roundStolen`/`coins`/`stolen`/
        // `collectedTypes` alanlarını SUNUCUDAN uygularız. Sunucu tek
        // otoritedir; iki istemci de AYNI değerleri görür. Yalnızca sunucu
        // sayısal/nesne bir değer döndürdüğünde uygularız (aksi halde mevcut
        // değeri koruruz).
        const players =
          data.players && data.players.length > 0
            ? prev.players.map((player) => {
                const server = data.players?.find(
                  (item) => mapPlayerId(String(item.id), myId) === player.id,
                )
                if (!server) return player
                const next = { ...player }
                // SKOR MONOTONİKLİĞİ (KÖK SORUN DÜZELTMESİ: "1080 → 1030").
                //
                // Bu yoklama BAYAT olabilir (replica gecikmesi / yazma öncesi
                // okuma). Eski kod `next.score = server.score` ile KOŞULSUZ
                // uyguluyordu; bayat bir snapshot (eski skor) yeni skoru EZİYOR
                // ve skor GERİ DÜŞÜYORDU. Skor, MAÇ boyunca MONOTONİKTİR:
                // hiçbir yazar (bayat snapshot, gecikmiş RPC, yoklama) değeri
                // DÜŞÜREMEZ. Tek meşru sıfırlama YENİ MAÇTADIR; o da
                // `resetMatch`/`blankPlayer` ile yapılır (bu yoklama değil).
                // Bu yüzden `Math.max` uygularız.
                if (typeof server.score === 'number') {
                  next.score = Math.max(player.score ?? 0, server.score)
                }
                if (typeof server.roundScore === 'number') {
                  next.roundScore = Math.max(player.roundScore ?? 0, server.roundScore)
                }
                if (typeof server.totalScore === 'number') {
                  next.totalScore = Math.max(player.totalScore ?? 0, server.totalScore)
                }
                // TUR İSTATİSTİKLERİ (SUNUCU OTORİTESİ): sonuç ekranı bunları
                // okur; sunucu değeri geldiğinde AYNEN uygula (max YOK).
                if (typeof server.roundCoins === 'number') next.roundCoins = server.roundCoins
                if (typeof server.roundStolen === 'number') next.roundStolen = server.roundStolen
                if (typeof server.coins === 'number') next.coins = server.coins
                if (typeof server.stolen === 'number') next.stolen = server.stolen
                if (server.collectedTypes) next.collectedTypes = server.collectedTypes
                // GÖREV İLERLEMESİ (SUNUCU OTORİTESİ + MONOTONİK + BAYAT KORUMASI):
                // sonuç ekranı da doğru ilerlemeyi gösterir. Bu yoklama BAYAT
                // olabilir; `objectivesDone` geride ise snapshot ÖNCEKİ göreve
                // aittir ve TAMAMEN yok sayılır. Aksi halde görev kimliği
                // DEĞİŞMEDİĞİ sürece ilerlemeyi DÜŞÜREMEZ (monotonik). Yalnızca
                // görev GERÇEKTEN değiştiyse (sunucu yeni görev atadı) sunucu
                // değerini AYNEN alırız. Böylece "4/4 → 3/4" olmaz.
                const serverDone =
                  typeof server.objectivesDone === 'number' ? server.objectivesDone : undefined
                const localDone = typeof player.objectivesDone === 'number' ? player.objectivesDone : 0
                const staleSnapshot = serverDone !== undefined && serverDone < localDone
                if (!staleSnapshot) {
                  const serverObjectiveId = server.objective?.id ?? null
                  const localObjectiveId = player.objective?.id ?? null
                  const objectiveChanged =
                    serverObjectiveId !== null && serverObjectiveId !== localObjectiveId
                  if (typeof server.objectiveProgress === 'number') {
                    next.objectiveProgress = objectiveChanged
                      ? server.objectiveProgress
                      : Math.max(player.objectiveProgress ?? 0, server.objectiveProgress)
                  }
                  if (objectiveChanged && server.objective) next.objective = server.objective
                }
                // `objectivesDone` MONOTONİK sürüm damgası: yalnızca İLERİ alınır.
                // Koşulsuz uygulanırsa bayat bir snapshot (geride kalan damga)
                // yerel değeri DÜŞÜRÜR ve bir sonraki yoklamada `staleSnapshot`
                // koruması YANLIŞ çalışır (gerçek bayat snapshot'ı taze sanır).
                if (serverDone !== undefined && serverDone >= localDone) {
                  next.objectivesDone = serverDone
                }
                return next
              })
            : prev.players
        // ÖNEMLİ (SLOT EŞLEME): Sunucu `winner`'ı SUNUCU slotuyla döndürür;
        // yerel state YEREL slot bekler. `mapPlayerId` ile çeviririz.
        const winner =
          (data.winner ? mapPlayerId(data.winner, myId) : undefined) ??
          (nextPhase === 'matchover' ? winnerFromScores(matchScores) : prev.winner)
        // Skor/kazanan değişimi de "değişiklik" sayılır; aksi halde faz ve coin
        // sabitken sunucunun hesapladığı kazanan/skor uygulanmaz ve istemci
        // bayat sonuç ekranında takılı kalırdı. Oyuncu satırlarındaki skor
        // değişimi de (maç sonu toplamı) buraya dahildir.
        const playersChanged = players !== prev.players
        const scoresChanged =
          matchScores !== prev.matchScores ||
          roundScores !== prev.roundScores ||
          winner !== prev.winner ||
          playersChanged
        if (!phaseChanged && !coinsChanged && !scoresChanged) return prev
        // GERİ SAYIM GÜVENCESİ: Faz `countdown`'a geçtiği halde sunucu
        // deadline'ı yoksa/geçmişse yerel bir 3 sn'lik pencere kurarız. Aksi
        // halde `countdownLeft <= 0` olur ve 3-2-1 hiç görünmez (yalnızca bir
        // oyuncuda geri sayım görünmesinin bir diğer nedeni).
        const enteringCountdown = nextPhase === 'countdown' && prev.phase !== 'countdown'
        const nowMs = Date.now()
        const effectiveCountdown = enteringCountdown
          ? localCountdownEndsAt > nowMs
            ? localCountdownEndsAt
            : nowMs + COUNTDOWN_MS
          : localCountdownEndsAt > 0
            ? localCountdownEndsAt
            : prev.countdownEndsAt
        return {
          ...prev,
          phase: nextPhase,
          winner,
          roundScores,
          matchScores,
          round: nextRound,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          countdownEndsAt: effectiveCountdown,
          coins,
          players,
        }
      })
    }
    void pull()
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void pull()
    }, 1_500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [noteServerNow, room.code, room.playerId, room.token, setState, state.phase, toLocal])

  // YENİ TUR SENKRONU (misafir tarafı).
  //
  // Host `duo_start_round` çağırdığında sunucu `round`'u artırır ve fazı
  // `countdown`'a çeker. Host kendi tarafında `resetRound` çağırıp coin/görev
  // düzenini yeniden tohumlar; ancak MİSAFİR bunu yapmaz — yalnızca faz
  // uzlaşması ile `phase`'i ilerletir. Sonuç: misafir yeni turda ESKİ coin
  // düzenini ve ESKİ görevleri görür (iki taraf farklı oyun oynar).
  //
  // Çözüm: sunucu `round` değeri yerel `round`'dan ileri geçtiğinde misafir de
  // `resetRound` ile aynı seed'den coin/görev düzenini yeniden üretir. Seed
  // oda koduna bağlı olduğu için iki taraf BİREBİR aynı düzeni görür.
  const syncedRoundRef = useRef<number | null>(null)
  useEffect(() => {
    if (state.phase !== 'countdown' && state.phase !== 'battle') return
    if (syncedRoundRef.current === state.round) return
    // İlk senkronu atla: tur zaten `startGame`/`beginNextRound` ile kuruldu.
    if (syncedRoundRef.current === null) {
      syncedRoundRef.current = state.round
      return
    }
    // Sunucu turu ilerletti → misafir de aynı seed'den yeniden tohumla.
    if (state.round > syncedRoundRef.current) {
      syncedRoundRef.current = state.round
      resetRound(state.round, roundSeedFor(room.code, state.round))
      setNextReady(false)
      setRivalNextReady(false)
      // Yeni turda rakibin ESKİ broadcast konumunu bırak. Aksi halde rakip
      // henüz hareket etmemişse eski konumda "asılı" kalır ve iki oyuncu aynı
      // noktada başlıyormuş gibi görünür. Sunucu spawn konumu devralır.
      remotePos.current.clear()
      // ÖNEMLİ: `resetRound` `countdownEndsAt`/`endsAt`'i SIFIRLAR. Misafirin
      // geri sayımı silinmesin diye sunucudan gelen EN SON deadline'ları hemen
      // geri yazarız. Aksi halde misafir "3-2-1" görmeden tur başlıyordu.
      //
      // KÖK SORUN ("bir oyuncuda geri sayım var, diğerinde yok"): Bu effect
      // `state.round` değiştiği ANDA çalışır. Ancak `serverDeadlineRef` yalnızca
      // `duo_public_state` yanıtı geldiğinde doldurulur. Faz uzlaşması turu
      // ilerlettiği anda yeni turun `countdown_ends_at` değeri henüz ref'e
      // yazılmamış olabilir (özellikle host `duo_next_round` çağırıp sunucu
      // `countdown`'a geçtiğinde, misafirin bir sonraki poll'u 1.5 sn sonradır).
      // Bu durumda `countdownEndsAt` 0 kalır → misafir `countdown` fazına girer
      // ama `countdownLeft <= 0` olduğu için 3-2-1 HİÇ görünmez ve doğrudan
      // battle'a düşer. Host ise `duo_next_round` yanıtındaki deadline ile
      // sayar → "birinde geri sayım var, birinde yok" hatası.
      //
      // ÇÖZÜM: Sunucu deadline'ı yoksa/geçmişse YEREL bir 3 sn'lik pencere
      // kurarız. Böylece misafir de HER ZAMAN 3-2-1 görür. Sunucu deadline'ı
      // mevcutsa (normal durum) onu kullanırız; iki taraf senkron kalır.
      const { countdownEndsAt, endsAt } = serverDeadlineRef.current
      const now = Date.now()
      const effectiveCountdown =
        countdownEndsAt > now ? countdownEndsAt : now + COUNTDOWN_MS
      setState((prev) => ({
        ...prev,
        countdownEndsAt: effectiveCountdown,
        endsAt: endsAt > now ? endsAt : prev.endsAt,
      }))
    }
  }, [resetRound, room.code, setState, state.phase, state.round])

  // Lobi yoklaması.
  //
  // Realtime presence rakibin kanalı bağlandığı anda `true` olur; ancak
  // `duo_join_room` satırı henüz commit edilmemiş olabilir. Bu yüzden lobide
  // sunucudan gerçek oyuncu satırlarını çekeriz: hem `playerCount` (Start
  // butonu kilidi) hem de oyuncu adları buradan gelir. Böylece rakip odaya
  // katıldığında adı her iki tarafta da görünür. Sadece lobide ve sekme
  // görünürken çalışır (maliyet düşük).
  //
  // ÖNEMLİ: Host `duo_start_round` çağırdığında sunucu fazı `countdown`'a
  // çeker. Misafir oyuncu bunu yalnızca bu yoklama ile öğrenir; bu yüzden
  // `phase` (ve ilgili zaman alanları) da burada senkronlanır. Aksi halde
  // misafir lobide takılı kalır.
  useEffect(() => {
    const code = room.code
    if (!code) return
    const myId = room.playerId
    const myToken = room.token ?? room.playerId
    let cancelled = false
    const pull = async () => {
      // Yalnızca lobide ağ isteği yap. Effect oda boyunca bağlı kalır (faz
      // değişiminde sökülmez), ama countdown/battle'da bu yoklama gereksizdir;
      // o fazların kendi uzlaşma effect'i vardır.
      if (stateRef.current.phase !== 'lobby') return
      let data: PublicSnapshot | null = null
      try {
        data = await callRef.current<PublicSnapshot>('duo_public_state', { p_token: myToken })
      } catch {
        /* oda silinmiş olabilir — sessizce geç */
        return
      }
      if (cancelled || !data) return
      if (typeof data.playerCount === 'number') setServerPlayerCount(data.playerCount)
      // Sunucu saat farkını güncelle, sonra deadline'ları yerel saate çevir.
      noteServerNow(data.serverNow)
      const localEndsAt = toLocal(data.endsAt)
      const localCountdownEndsAt = toLocal(data.countdownEndsAt)
      // Oyuncu adlarını (ve varsa diğer alanları) sunucudan uygula. Yerel
      // oyuncunun adı boşsa mevcut adı koru; rakip adı geldiğinde göster.
      // Ayrıca host oyunu başlattıysa fazı da burada ilerlet.
      // Faz geçişini GÜNCELLEYİCİ DIŞINDA tespit et. `setState` güncelleyicisi
      // SAF olmalıdır; broadcast/ref yazımı gibi yan etkiler orada yapılamaz.
      // Fazı `stateRef` üzerinden oku: bu effect YALNIZCA oda/token değişince
      // yeniden kurulur. `state.phase`'i bağımlılığa koyarsak her faz
      // değişiminde (ve her `setState` render'ında) effect sökülüp yeniden
      // kurulur; bu da uçuştaki `pull()` isteğini `cancelled` ile iptal eder ve
      // `playerCount` hiç uygulanmaz → misafir ~10 sn "rakip yok" görür.
      const currentPhase = stateRef.current.phase
      const leavingLobby = currentPhase === 'lobby' && Boolean(data.phase) && data.phase !== 'lobby'
      if (leavingLobby) {
        // Misafir lobiden çıkıp maça katıldığını rakibe HEMEN bildirsin.
        // Host, misafirin presence'ı geçiş sırasında dalgalandığı için
        // yanlışlıkla "rakip ayrıldı" görebiliyordu; bu `hello` broadcast'i
        // host'un `rivalLeft` bayrağını temizler ve oyunu kaldığı yerden
        // sürdürür. `self: false` olduğu için kendimize gitmez.
        broadcastRef.current('hello', { by: room.playerId })
        // Maç başlangıç damgasını misafir tarafında da kur (grace penceresi).
        setMatchStartAt(Date.now())
        remotePos.current.clear()
      }
      setState((prev) => {
        // Sunucu fazı lobiden çıktıysa (host başlattı) yerel fazı da ilerlet.
        // ÖNEMLİ: `nextPhase` skor otoritesi kararında (`scoresAreAuthoritative`)
        // kullanıldığı için oyuncu birleştirmesinden ÖNCE tanımlanmalıdır.
        const nextPhase = data.phase && data.phase !== 'lobby' ? data.phase : prev.phase
        const players =
          data.players && data.players.length > 0
            ? prev.players.map((player) => {
                const server = data.players?.find(
                  (item) => mapPlayerId(String(item.id), myId) === player.id,
                )
                if (!server) return player
                const serverName =
                  typeof server.name === 'string' && server.name.trim() ? server.name : player.name
                const merged = { ...player, ...server, id: player.id, name: serverName } as Player
                // GÖREV ÜÇLÜSÜNÜ GERİ AL (ATOMİK): ham yayılım sunucunun
                // `objective`/`objectiveProgress`/`objectivesDone` alanlarını
                // KOŞULSUZ uygular. Bu üç alan birbirine BAĞLIDIR; ham yayılım
                // bunları AYRIŞTIRIR ("görev A ama ilerleme B"). Aşağıda
                // `objective`'i yerel değerle koruruz; `objectiveProgress` ve
                // `objectivesDone` de yerel değerlerinde kalır (lobi yoklaması
                // bunları güncellemez; savaş/sonuç yoklamaları günceller).
                merged.objective = player.objective
                merged.objectiveProgress = player.objectiveProgress
                merged.objectivesDone = player.objectivesDone
                // SKOR OTORİTESİ (ÇELİŞKİLİ MAÇ SONU SKORU DÜZELTMESİ):
                // Sunucu `duo_tick` tur bitişinde `score`/`round_score`/
                // `total_score` alanlarını GERÇEKTEN hesaplar ve `duo_public_state`
                // bunları döndürür. Önceden bu alanları koşulsuz olarak yerel
                // değerle EZİYORDUK; bu yüzden `player.totalScore` istemcide
                // bayat kalıyor ve iki istemci maç sonunda FARKLI toplam
                // gösteriyordu ("değerler birbirini tutmuyor"). Artık sunucu
                // anlamlı bir değer döndürdüğünde (sayı ve > 0 ya da tur
                // ilerlemişse) sunucu değerini UYGULARIZ; yalnızca lobide/geri
                // yüklemede (sunucu henüz 0 dönerken) yerel değeri koruruz.
                const serverScore = typeof server.score === 'number' ? server.score : undefined
                const serverRoundScore =
                  typeof server.roundScore === 'number' ? server.roundScore : undefined
                const serverTotalScore =
                  typeof server.totalScore === 'number' ? server.totalScore : undefined
                // Lobide (`lobby`) sunucu skoru henüz 0'dır; geri yüklenen skoru
                // korumak için yerel değeri tutarız. Maç başladıktan sonra
                // (countdown/battle/results/matchover) sunucu değeri otoritedir.
                const scoresAreAuthoritative = nextPhase !== 'lobby'
                // SKOR MONOTONİKLİĞİ (KÖK SORUN DÜZELTMESİ: "1080 → 1030"):
                // otoriter olduğunda bile BAYAT bir snapshot skoru DÜŞÜREMEZ.
                // `Math.max` uygularız; tek meşru sıfırlama yeni maçtadır.
                merged.score =
                  scoresAreAuthoritative && serverScore !== undefined
                    ? Math.max(player.score ?? 0, serverScore)
                    : player.score
                merged.roundScore =
                  scoresAreAuthoritative && serverRoundScore !== undefined
                    ? Math.max(player.roundScore ?? 0, serverRoundScore)
                    : player.roundScore
                merged.totalScore =
                  scoresAreAuthoritative && serverTotalScore !== undefined
                    ? Math.max(player.totalScore ?? 0, serverTotalScore)
                    : player.totalScore
                merged.trail = player.trail
                merged.emote = player.emote
                // AVATAR: yerel oyuncunun avatarı `cosmetics.avatar`'dan
                // (anlık seçim), rakibinki broadcast'ten gelir. Sunucu
                // snapshot'ı yalnızca tur başında tohumlanan değeri taşır;
                // bu yüzden yerel değeri koruruz.
                merged.avatar = player.avatar
                merged.coins = player.coins
                merged.stolen = player.stolen
                merged.collectedTypes = player.collectedTypes
                merged.objectivesDone = player.objectivesDone
                merged.missionDone = player.missionDone
                merged.objective = player.objective
                // Konum ve yavaşlama da client'a aittir: sunucu x/y'si gecikmeli,
                // `slowed_until` ise sunucu saatiyle damgalıdır (saat farkı
                // yüzünden yanlış yorumlanıp oyuncuyu kalıcı yavaşlatabilir).
                merged.x = player.x
                merged.y = player.y
                merged.slowedUntil = player.slowedUntil
                return merged
              })
            : prev.players
        // ÖNEMLİ: Misafir lobiden ÇIKARKEN turu yeniden tohumlamalı. Aksi halde
        // misafir ilk turda `initialState`'in varsayılan coin/görev düzenini
        // korur; host ise `duo_start_round` seed'iyle (`CODE:1`) farklı bir düzen
        // üretir → "iki taraf farklı oyun oynuyor". Ayrıca rakibin eski broadcast
        // konumu temizlenmezse "ikisi aynı noktada başlıyor" hatası oluşur.
        //
        // DİKKAT: `resetRound`'u bu `setState` güncelleyicisinin İÇİNDE
        // ÇAĞIRMAYIZ. `resetRound` kendi `setState`'ini tetikler; iç içe
        // güncelleyicilerde dıştakine verilen `prev` reset ÖNCESİ durumdur ve
        // döndürdüğümüz nesne reset'in `coins`/`players`/`objective` değişimini
        // EZER. Bu yüzden reset alanlarını doğrudan burada hesaplayıp tek bir
        // güncellemede uygularız (yarış yok, kayıp yok).
        if (leavingLobby) {
          const round = data.round ?? prev.round
          const roundSeed = roundSeedFor(room.code, round)
          const [first, second] = generateObjectivePair(roundSeed)
          const { countdownEndsAt, endsAt } = serverDeadlineRef.current
          // SPAWN SLOTU: Gerçek spawn konumu SUNUCU slotuna (`room.playerId`)
          // göre belirlenir. Yerel slot 0 = "ben" → benim sunucu slotum; yerel
          // slot 1 = "rakip" → karşı slot. `blankPlayer(player.id)` kullanırsak
          // misafir (sunucu slotu p2) yanlışlıkla SOLDA (p1) başlar; bu da
          // "biri sağda biri solda başlamalı" kuralını bozar.
          const mySlot = room.playerId
          return {
            ...prev,
            phase: nextPhase,
            round,
            // Coin/görev düzenini tur seed'inden yeniden üret (host ile birebir).
            coins: spawnCoins(roundSeed),
            chaosEvent: undefined,
            chaosEventEndsAt: undefined,
            winner: undefined,
            // TUR SKORU: Yeni maçta `roundScores` sıfırlanır (bkz. `resetRound`).
            // `matchScores` kümülatif olduğu için burada sıfırlanmaz.
            roundScores: { p1: 0, p2: 0 },
            endsAt: localEndsAt > 0 ? localEndsAt : endsAt > 0 ? endsAt : prev.endsAt,
            countdownEndsAt:
              localCountdownEndsAt > 0
                ? localCountdownEndsAt
                : countdownEndsAt > 0
                  ? countdownEndsAt
                  : prev.countdownEndsAt,
            players: prev.players.map((player, index) => {
              const spawnId = index === 0 ? mySlot : mySlot === 'p1' ? 'p2' : 'p1'
              return {
                ...blankPlayer(player.id as 'p1' | 'p2', spawnId),
                name: player.name,
                xp: player.xp,
                level: player.level,
                title: player.title,
                trail: player.trail,
                objective: index === 0 ? first : second,
              }
            }),
          }
        }
        // SKOR OTORİTESİ (LOBİ): Sunucu `match_scores`/`round_scores` alanlarını
        // GERÇEKTEN hesaplar. Yeniden bağlanma sonrası lobide beklerken bu
        // değerleri uygulamazsak kümülatif maç skoru kaybolur ("yeniden
        // bağlanınca skor 0"). Sunucu anlamlı bir değer döndürdüğünde uygularız;
        // boş/0 ise yerel değeri koruruz (yeni maç başlangıcı).
        const lobbyServerMatchScores =
          data.matchScores && Object.keys(data.matchScores).length > 0
            ? mapScores(data.matchScores, myId)
            : null
        const lobbyServerRoundScores =
          data.roundScores && Object.keys(data.roundScores).length > 0
            ? mapScores(data.roundScores, myId)
            : null
        const nextMatchScores = lobbyServerMatchScores ?? prev.matchScores
        return {
          ...prev,
          phase: nextPhase,
          round: data.round ?? prev.round,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
          matchScores: nextMatchScores,
          roundScores: lobbyServerRoundScores ?? prev.roundScores,
          // Lobi/geri sayım fazında kazanan YOKTUR; sunucunun (skoru hep 0
          // olduğu için daima 'p1' dönen) `winner` alanını UYGULAMAYIZ.
          winner: nextPhase === 'matchover' ? winnerFromScores(nextMatchScores) : undefined,
          players,
        }
      })
    }
    void pull()
    // Hızlı yoklama: host oyunu başlattığında misafir ~700ms içinde fark eder.
    // Eski 1500ms değeri, misafirin "waiting for rival start" ekranında ~5 sn
    // takılı kalmasına yol açıyordu (host çoktan oynamaya başlamışken).
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void pull()
    }, POLL_MS.lobby)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
    // DİKKAT: `state.phase` bilinçli olarak bağımlılıkta DEĞİL. Fazı
    // `stateRef` üzerinden okuruz; aksi halde her faz/render değişiminde effect
    // yeniden kurulur ve uçuştaki istek iptal edilir (senkron gecikmesi).
  }, [noteServerNow, room.code, room.playerId, room.token, setState, toLocal])

  // Maç sonunda XP ver.
  const awarded = useRef(false)
  useEffect(() => {
    if (state.phase !== 'matchover' || awarded.current) return
    awarded.current = true
    const won = state.winner === 'p1'
    playSound(won ? 'win' : 'lose')
    void progress.award({ won, rounds: state.round, missions: won ? 1 : 0 })
  }, [progress, state.phase, state.round, state.winner])

  useEffect(() => {
    if (state.phase !== 'matchover') awarded.current = false
  }, [state.phase])

  const createRoom = useCallback(
    async (name?: string) => {
      setBusy(true)
      setError(null)
      unlockAudio()
      try {
        const code = makeCode()
        const displayName = resolvePlayerName(name, readName(), room.name)
        // Her oyuncu BENZERSİZ bir token kullanmalı. Aksi halde iki taraf da
        // `t-${code}` gönderir ve `duo_join_room` token eşleşmesinden dolayı
        // ikinci oyuncuyu "yeniden bağlanan host" sanıp slot 1'e oturtur.
        const myToken = makeToken()
        const data = await room.call<{ token?: string; name?: string }>('duo_create_room', {
          p_code: code,
          p_token: myToken,
          p_name: displayName || null,
        })
        const token = data?.token ?? myToken
        const myName = (data?.name ?? displayName).trim()
        saveToken(code, token)
        await room.connect(code, 'p1', token, myName)
        resetMatch()
        // Kendi adımızı yerel duruma da yaz; lobide hemen görünsün.
        if (myName) updatePlayer('p1', { name: myName })
        setPhase('lobby')
        // Adres çubuğunu paylaşılabilir davet linkiyle eşitle.
        syncUrl(`/play/${code}`)
        playSound('join')
      } catch (err) {
        setError(friendlyError(err, 'We could not create the game. Please try again.'))
      } finally {
        setBusy(false)
      }
    },
    [resetMatch, room, setPhase, updatePlayer],
  )

  const joinRoom = useCallback(
    async (code: string, name?: string) => {
      setBusy(true)
      setError(null)
      unlockAudio()
      const normalized = code.trim().toUpperCase()
      try {
        const displayName = resolvePlayerName(name, readName(), room.name)
        // ÖNEMLİ: Bu odaya daha önce katıldıysak KAYITLI token'ı kullanırız.
        // Aksi halde her yeniden girişte yeni bir token üretilir; oyuncunun
        // eski satırı hâlâ duruyorsa `duo_join_room` "room_full" fırlatır
        // (kullanıcının "linke tekrar girdiğimde room full diyor" şikâyeti).
        const saved = readToken(normalized)
        const myToken = saved ?? makeToken()
        const data = await room.call<{ token?: string; name?: string; player_id?: string }>(
          'duo_join_room',
          {
            p_code: normalized,
            p_token: myToken,
            p_name: displayName || null,
          },
        )
        const token = data?.token ?? myToken
        const myName = (data?.name ?? displayName).trim()
        // Sunucu bize hangi slotu verdiyse onu kullan (reconnect'te p1 olabilir).
        const slot: 'p1' | 'p2' = data?.player_id === 'p1' ? 'p1' : 'p2'
        saveToken(normalized, token)
        await room.connect(normalized, slot, token, myName)
        resetMatch()
        // Kendi adımızı yerel duruma da yaz; lobide hemen görünsün.
        if (myName) updatePlayer('p1', { name: myName })
        setPhase('lobby')
        // Adres çubuğunu paylaşılabilir davet linkiyle eşitle.
        syncUrl(`/play/${normalized}`)
        playSound('join')
      } catch (err) {
        setError(friendlyError(err, 'We could not join that game. Please try again.'))
      } finally {
        setBusy(false)
      }
    },
    [resetMatch, room, setPhase, updatePlayer],
  )

  /**
   * Kayıtlı token ile odaya yeniden bağlanır (sayfa yenilendiğinde / linke
   * tekrar girildiğinde). Token yoksa `false` döner ve çağıran taraf normal
   * `joinRoom` akışına düşer.
   */
  const restore = useCallback(
    async (code: string): Promise<boolean> => {
      const normalized = code.trim().toUpperCase()
      const token = readToken(normalized)
      if (!token) return false
      // KÖK SORUN (kullanıcı raporu: "davet linkiyle katılınca eski ad
      // kullanılıyor"): Burada sunucunun döndürdüğü `data.name` (önceki
      // oturumdan kalan BAYAT ad) yerel adı EZİYORDU. Ayrıca sunucuya hiç
      // `p_name` göndermediğimiz için satır da güncellenmiyordu.
      //
      // ÇÖZÜM: Güncel adı doğrudan localStorage'dan da okuruz. URL effect'i
      // isim hidrasyonundan önce çalışabileceği için `room.name` henüz boş
      // veya eski olabilir; persisted değer önce gelir.
      const localName = resolvePlayerName(readName(), room.name)
      try {
        // Sunucudan hangi slotta olduğumuzu öğren (p1 mi p2 mi?). Güncel adı
        // da göndeririz; sunucu satırı tazeler ve yanıtta güncel adı döner.
        const data = await room.call<{ player_id?: string; name?: string }>('duo_join_room', {
          p_code: normalized,
          p_token: token,
          p_name: localName || null,
        })
        const slot: 'p1' | 'p2' = data?.player_id === 'p1' ? 'p1' : 'p2'
        // Yerel (açıkça girilen) ad ÖNCELİKLİDİR; yoksa sunucu adı kullanılır.
        const resolvedName = localName || (data?.name ?? '').trim()
        await room.connect(normalized, slot, token, resolvedName || undefined)
        // KÖK SORUN (kullanıcı raporu: "yeniden bağlanınca skor 0 oluyor"):
        // Eski kod burada KOŞULSUZ `resetMatch()` çağırıp fazı `lobby`'ye
        // çekiyordu. Bu, sunucudaki GERÇEK skoru/turu/fazı SİLİYORDU. Lobi
        // yoklaması da lobide skoru otoriter saymadığı (`scoresAreAuthoritative
        // = nextPhase !== 'lobby'`) ve `matchScores`'u hiç geri yüklemediği
        // için skor 0'da kalıyordu.
        //
        // ÇÖZÜM: Sunucu otoritesini KORU. `duo_public_state`'ten gerçek faz,
        // tur, `matchScores`/`roundScores` ve oyuncu skorlarını çekip uygularız.
        // Böylece yeniden bağlanan oyuncu kaldığı yerden devam eder; oyuncu
        // satırı YENİDEN OLUŞTURULMAZ/SIFIRLANMAZ (sunucu satırı zaten var).
        const snapshot = await room
          .call<PublicSnapshot>('duo_public_state', { p_token: token })
          .catch(() => null)
        if (snapshot) {
          noteServerNow(snapshot.serverNow)
          const localEndsAt = toLocal(snapshot.endsAt)
          const localCountdownEndsAt = toLocal(snapshot.countdownEndsAt)
          if (localCountdownEndsAt > 0) serverDeadlineRef.current.countdownEndsAt = localCountdownEndsAt
          if (localEndsAt > 0) serverDeadlineRef.current.endsAt = localEndsAt
          const serverMatchScores = mapScores(snapshot.matchScores, slot)
          const serverRoundScores = mapScores(snapshot.roundScores, slot)
          const serverPhase = snapshot.phase ?? 'lobby'
          const serverRound = typeof snapshot.round === 'number' ? snapshot.round : 1
          setState((prev) => {
            const players = prev.players.map((player) => {
              const server = snapshot.players?.find(
                (item) => mapPlayerId(String(item.id), slot) === player.id,
              )
              if (!server) return player
              const serverName =
                typeof server.name === 'string' && server.name.trim() ? server.name : player.name
              return {
                ...player,
                name: serverName,
                // SUNUCU OTORİTESİ: gerçek skorları geri yükle (sıfırlama YOK).
                score: typeof server.score === 'number' ? server.score : player.score,
                roundScore:
                  typeof server.roundScore === 'number' ? server.roundScore : player.roundScore,
                totalScore:
                  typeof server.totalScore === 'number' ? server.totalScore : player.totalScore,
              }
            })
            return {
              ...prev,
              phase: serverPhase,
              round: serverRound,
              matchScores: serverMatchScores ?? prev.matchScores,
              roundScores: serverRoundScores ?? prev.roundScores,
              endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
              countdownEndsAt:
                localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
              players,
            }
          })
        } else {
          // Snapshot alınamadı (geçici ağ hatası): yerel durumu SIFIRLAMAYIZ;
          // yalnızca lobiye düşeriz. Yoklama gelince gerçek durum uygulanır.
          setPhase('lobby')
        }
        if (resolvedName) updatePlayer('p1', { name: resolvedName })
        syncUrl(`/play/${normalized}`)
        return true
      } catch {
        // Token geçersiz (oda silinmiş / oyuncu atılmış) → normal katılmaya düş.
        return false
      }
    },
    [noteServerNow, room, setPhase, setState, toLocal, updatePlayer],
  )

  const startGame = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await room.call<{
        ok?: boolean
        reason?: string
        serverNow?: number
        countdownEndsAt?: number
        endsAt?: number
      }>('duo_start_round', { p_token: room.token ?? room.playerId })
      // Sunucu artık hata fırlatmak yerine yumuşak sonuç döndürür. Rakip
      // satırı henüz commit edilmediyse kullanıcıya anlaşılır bir mesaj ver.
      if (res && res.ok === false) {
        setError(friendlyError(res.reason, 'We could not start the match. Please try again.'))
        return
      }
      resetRound(1, roundSeedFor(room.code, 1))
      // Yeni maçta rakibin eski broadcast konumunu bırak.
      remotePos.current.clear()
      // Maç başlangıç damgasını kur: bundan sonraki kısa pencerede presence
      // düşüşü "rakip ayrıldı" sayılmaz (bkz. MATCH_PRESENCE_GRACE_MS).
      setMatchStartAt(Date.now())
      // Yeni maçta eski "rakip ayrıldı" bayrağını temizle; aksi halde önceki
      // maçtan kalan bayrak yeni maçı anında sonlandırırdı.
      setRivalLeft(false)
      // Sunucu deadline'larını yerel saate çevir (saat farkı düzeltmesi).
      noteServerNow(res?.serverNow)
      const localCountdown = toLocal(res?.countdownEndsAt)
      if (localCountdown > 0) serverDeadlineRef.current.countdownEndsAt = localCountdown
      setPhase('countdown', {
        countdownEndsAt: localCountdown > 0 ? localCountdown : Date.now() + COUNTDOWN_MS,
      })
    } catch (err) {
      setError(friendlyError(err, 'We could not start the match. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [noteServerNow, resetRound, room, setPhase, toLocal])

  /**
   * Sonraki turu GERÇEKTEN başlatır. Yalnızca iki oyuncu da onayladığında
   * (aşağıdaki effect) çağrılır. Host'un tek başına başlatması engellenir.
   *
   * ÖNEMLİ (TUR SENKRONU): Burada `duo_start_round` DEĞİL, `duo_next_round`
   * çağırırız. Sunucu tur numarasını YALNIZCA `duo_next_round` artırır
   * (`round = round + 1`), ardından `duo_start_round`'u çağırır.
   * `duo_start_round` doğrudan çağrılırsa sunucu turu ARTMAZ; istemci yerelde
   * `round + 1`'e geçerken sunucu eski turda kalır → coin/görev düzeni ve tur
   * sayacı iki tarafta UYUŞMAZ ("turlar tutmuyor" hatası).
   *
   * NEDEN `duo_advance_phase` DEĞİL? `duo_advance_phase` artık yalnızca
   * `countdown -> battle` ve `battle -> results` geçişlerini yapar; tur
   * bitişini `duo_tick` de yapabildiği için `results` fazında idempotenttir
   * (no-op). Sonraki tura geçiş AYRI bir RPC ile (`duo_next_round`) yapılır;
   * böylece "turu bitir" ile "sonraki tura geç" niyetleri karışmaz ve
   * `duo_tick` ile yarışan bir çağrı sonuç ekranını ATLAMAZ.
   */
  const beginNextRound = useCallback(async () => {
    setBusy(true)
    try {
      const res = await room.call<{
        serverNow?: number
        countdownEndsAt?: number
        round?: number
      }>('duo_next_round', { p_token: room.token ?? room.playerId })
      // Sunucunun ilerlettiği tur numarasını esas al; yoksa yerel +1'e düş.
      const nextRound = typeof res?.round === 'number' ? res.round : state.round + 1
      resetRound(nextRound, roundSeedFor(room.code, nextRound))
      noteServerNow(res?.serverNow)
      const localCountdown = toLocal(res?.countdownEndsAt)
      // Yeni turda rakibin eski broadcast konumunu bırak (iki oyuncu aynı
      // noktada başlamasın).
      remotePos.current.clear()
      // Yeni turda da grace penceresini tazele ve eski "ayrıldı" bayrağını
      // temizle (tur geçişinde presence kısa süre dalgalanabilir).
      setMatchStartAt(Date.now())
      setRivalLeft(false)
      // Sunucu deadline'ını sakla; misafir tarafı da aynı değeri kullanır.
      if (localCountdown > 0) serverDeadlineRef.current.countdownEndsAt = localCountdown
      // Yeni tur başlarken onay bayraklarını sıfırla; bir sonraki sonuç
      // ekranı temiz başlasın.
      setNextReady(false)
      setRivalNextReady(false)
      setPhase('countdown', {
        countdownEndsAt: localCountdown > 0 ? localCountdown : Date.now() + COUNTDOWN_MS,
      })
    } finally {
      setBusy(false)
    }
  }, [noteServerNow, resetRound, room, setPhase, state.round, toLocal])

  // Realtime işleyicilerinin güncel fonksiyona/değere erişebilmesi için
  // ref'leri senkronla.
  useEffect(() => {
    beginNextRoundRef.current = beginNextRound
  }, [beginNextRound])

  useEffect(() => {
    nextReadyRef.current = nextReady
  }, [nextReady])

  // Güncel tur numarasını ref'e yaz; `offNextReady` işleyicisi onay paketini
  // bu değerle doğrular (gecikmiş/eski tur paketlerini yok sayar).
  useEffect(() => {
    roundRef.current = state.round
  }, [state.round])

  /**
   * YENİ TUR ONAY BAYRAKLARINI SIFIRLA.
   *
   * Kök sorun: `nextReady`/`rivalNextReady` yalnızca `beginNextRound` içinde
   * sıfırlanıyordu. Bir turun el sıkışması tamamlandıktan sonra bu bayraklar
   * `true` kalıyor ve BİR SONRAKİ turun sonuç ekranına taşınıyordu. O ekranda
   * iki oyuncudan biri "next round"a bastığı anda host'un `offNextReady`
   * işleyicisi `nextReadyRef.current === true` (bayat) gördüğü için turu
   * ANINDA başlatıyordu — diğer oyuncu hiç onay vermeden. Bu da "biri next
   * diyor bekliyor, diğerinde tur kendiliğinden başlıyor" hatasına yol açıyordu.
   *
   * Çözüm: Sonuç ekranı her YENİ tur için göründüğünde onay bayraklarını
   * sıfırla. Böylece her turda el sıkışma baştan yapılır.
   */
  const readyRoundRef = useRef<number | null>(null)
  // `startedRoundRef`: aşağıdaki "her iki onay da hazır → host başlatır"
  // effect'inin AYNI tur için ÇİFT başlatmasını engeller. Yeni bir sonuç ekranı
  // göründüğünde (yeni tur) sıfırlanır.
  const startedRoundRef = useRef<number | null>(null)
  useEffect(() => {
    if (state.phase !== 'results') return
    if (readyRoundRef.current === state.round) return
    readyRoundRef.current = state.round
    // Yeni sonuç ekranı: onay bayraklarını VE "başlatıldı" mandalını sıfırla.
    startedRoundRef.current = null
    setNextReady(false)
    setRivalNextReady(false)
  }, [state.phase, state.round])

  /**
   * "Next round" butonu: yalnızca YEREL onayı kaydeder ve rakibe bildirir.
   * Tur, iki taraf da onaylayınca başlar. Böylece bir oyuncu hazır olmadan
   * diğeri turu zorla başlatamaz.
   *
   * NOT: Tur başlatma bir effect İÇİNDE yapılmaz — `react-hooks/set-state-in-effect`
   * kuralı effect gövdesinde senkron `setState` çağrısını yasaklar. Bunun
   * yerine onay bir olay işleyicisinden (buton tıklaması / rakip broadcast'i)
   * verilir ve iki onay da hazır olduğunda tur burada başlatılır.
   */
  const approveNextRound = useCallback(() => {
    setNextReady(true)
    // Onayı TURA bağlarız: rakip, paketin `round` alanı kendi turuyla
    // eşleşmezse yok sayar. Böylece önceki turdan gecikmiş bir onay yeni turu
    // erken başlatamaz.
    room.broadcast('next-ready', { by: room.playerId, round: state.round })
    // Rakip zaten onaylamışsa ve host bizsek turu hemen başlat.
    if (rivalNextReady && room.playerId === 'p1') {
      void beginNextRound()
    }
  }, [beginNextRound, rivalNextReady, room, state.round])

  // NEXT-READY HEARTBEAT: Yerel oyuncu onayladıysa ama rakip hâlâ onaylamadıysa
  // onayımızı periyodik olarak yeniden yayınlarız. Tek bir `next-ready` paketi
  // kaybolursa host turu hiç başlatmaz ve bir oyuncu "waiting for rival"
  // ekranında takılı kalırdı. Heartbeat bu el sıkışmayı yakınsar.
  //
  // KÖK SORUN ("Waiting for your rival to accept… ikiside kabul ettiği halde"):
  // Bu effect'in bağımlılığında `room` vardı. `room` her render'da YENİ bir nesne
  // kimliği taşır (useRoom dönüşü memoize edilmemiş — bkz. yukarıdaki `callRef`
  // notu). Bu yüzden effect HER render'da sökülüp yeniden kuruluyor ve interval
  // 1.5 sn'ye ulaşmadan sıfırlanıyordu → heartbeat HİÇ ateşlenmiyordu. Tek bir
  // `next-ready` broadcast'i kaybolduğunda (Supabase broadcast best-effort'tur)
  // el sıkışma asla tamamlanmıyor ve İKİ taraf da "rakip bekleniyor" ekranında
  // takılı kalıyordu. Çözüm: `broadcastRef` kullanıp `room`'u bağımlılıktan
  // çıkarırız; böylece interval kararlı kalır ve gerçekten periyodik çalışır.
  //
  // EK GÜVENCE: Heartbeat yalnızca `!rivalNextReady` iken çalışır. İki taraf da
  // onayladığında heartbeat DURUR. Eğer host, rakibin onayını aldığı anda
  // `nextReadyRef.current` henüz `true` değilse (effect flush gecikmesi), tur
  // hiç başlamaz ve iki heartbeat de durduğu için İKİ taraf sonsuza dek takılı
  // kalır. Bu yüzden aşağıdaki "her iki onay da hazır → host başlatır" effect'i
  // STATE'e bağlıdır ve bu yarışı kesin olarak kapatır.
  useEffect(() => {
    if (!nextReady || rivalNextReady) return
    if (state.phase !== 'results') return
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      broadcastRef.current('next-ready', { by: room.playerId, round: state.round })
    }, 1_500)
    return () => window.clearInterval(id)
  }, [nextReady, rivalNextReady, room.playerId, state.phase, state.round])

  /**
   * HER İKİ ONAY DA HAZIR → HOST TURU BAŞLATIR (STATE TABANLI, YARIŞSIZ).
   *
   * KÖK SORUN ("İKİ oyuncu da Next Round'a bastı ama ikisi de 'Waiting for your
   * rival to accept…' ekranında takılı kaldı"):
   *
   *   Tur başlatma yalnızca OLAY İŞLEYİCİLERİNE bağlıydı:
   *     - `approveNextRound` (buton) → `rivalNextReady` STATE'ini okur,
   *     - `offNextReady` (rakip paketi) → `nextReadyRef.current` REF'ini okur.
   *
   *   `nextReadyRef.current` bir effect içinde güncellenir; yani host "Ready"e
   *   bastıktan SONRA, effect flush olmadan rakibin `next-ready` paketi gelirse
   *   `nextReadyRef.current` hâlâ `false` olur → host turu BAŞLATMAZ. Aynı anda
   *   rakibin de `rivalNextReady`'si `true` olduğu için HER İKİ heartbeat de
   *   durur (ikisi de `!rivalNextReady` bekler). Sonuç: hiçbir mekanizma turu
   *   başlatmaz ve iki oyuncu da kalıcı olarak takılı kalır.
   *
   * ÇÖZÜM: Tur başlatmayı STATE'e bağlarız. `nextReady` VE `rivalNextReady`
   * ikisi de `true` olduğunda (ve host isek) turu başlatırız. Effect yalnızca
   * `beginNextRoundRef.current` (ref) çağırır — `set-state-in-effect` kuralına
   * takılmaz. `startedRoundRef` ile aynı tur için ÇİFT başlatmayı engelleriz
   * (hem bu effect hem `offNextReady` işleyicisi tetiklenebilir).
   */
  useEffect(() => {
    if (state.phase !== 'results') return
    if (!nextReady || !rivalNextReady) return
    if (room.playerId !== 'p1') return
    // Aynı tur için yalnızca BİR kez başlat.
    if (startedRoundRef.current === state.round) return
    startedRoundRef.current = state.round
    void beginNextRoundRef.current?.()
  }, [nextReady, rivalNextReady, room.playerId, state.phase, state.round])

  /**
   * RÖVANŞ (rematch) — İKİ OYUNCUNUN DA ONAYI GEREKİR.
   *
   * Kök sorun: Eski `rematch` sunucuya `duo_rematch` çağırıp HEMEN yerel fazı
   * `lobby`'ye çekiyordu. Ancak sunucu odayı yalnızca İKİ oyuncu da hazır
   * olduğunda `lobby`'ye çeker. Tek başına basıldığında sunucu `matchover`
   * kalır; faz uzlaşması da istemciyi tekrar `matchover`'a çekerdi — bu da
   * "rematch'e basınca yine sonuç ekranına dönüyorum" hatasıydı.
   *
   * Çözüm: Yerel onayı kaydedip rakibe `rematch-ready` yayınlarız. Sunucu
   * iki onayı da görünce odayı `lobby`'ye çeker; istemci faz uzlaşmasıyla
   * oraya geçer ve `resetMatch` bu geçişte uygulanır.
   */
  const rematch = useCallback(async () => {
    setBusy(true)
    try {
      setRematchReady(true)
      room.broadcast('rematch-ready', { by: room.playerId })
      await room.call('duo_rematch', { p_token: room.token ?? room.playerId })
      // Fazı BURADA değiştirmeyiz; sunucu iki onayı görünce `lobby`'ye çeker
      // ve uzlaşma effect'i geçişi yapar (aşağıdaki effect'e bakınız).
    } finally {
      setBusy(false)
    }
  }, [room])

  // RÖVANŞ ONAY HEARTBEAT: Yerel onay verildiyse sunucuya idempotent onayı,
  // matchover fazı sunucudan değişene kadar yeniden göndeririz.
  //
  // NOT: `next-ready` heartbeat'iyle AYNI düzeltme — `room` bağımlılığı her
  // render'da interval'i sıfırlayıp heartbeat'i ölü bırakıyordu. `broadcastRef`
  // kullanırız ve `room`'u bağımlılıktan çıkarırız.
  //
  // Broadcast yalnızca UI göstergesidir; sunucuya hazır olunduğunu kanıtlamaz.
  // Rakibin broadcast'i gelse bile onun RPC çağrısı başarısız olmuş olabilir.
  // Bu nedenle `rivalRematchReady` heartbeat'i durdurmamalı; her istemci kendi
  // idempotent duo_rematch RPC'sini faz sunucuda lobby olana kadar yineler.
  // Böylece kayıp/başarısız bir ilk RPC, iki tarafın "Both ready" durumunda
  // sonsuza dek kalmasına neden olmaz.
  useEffect(() => {
    if (!shouldRetryRematch(state.phase, rematchReady)) return
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      broadcastRef.current('rematch-ready', { by: room.playerId })
      void callRef.current('duo_rematch', { p_token: room.token ?? room.playerId }).catch((error: unknown) => {
        console.warn('Failed to sync rematch readiness', error)
      })
    }, 1_500)
    return () => window.clearInterval(id)
  }, [rematchReady, room.playerId, room.token, state.phase])

  // RÖVANŞ BAYRAKLARINI SIFIRLA: Sonuç ekranı her yeni maç için göründüğünde
  // onay bayraklarını temizle. (Aynı desen `readyRoundRef` için de kullanılır.)
  const rematchRoundRef = useRef<string | null>(null)
  useEffect(() => {
    if (state.phase !== 'matchover') return
    if (rematchRoundRef.current === 'matchover') return
    rematchRoundRef.current = 'matchover'
    setRematchReady(false)
    setRivalRematchReady(false)
  }, [state.phase])

  // RÖVANŞ GEÇİŞİ: Sunucu iki onayı da görüp odayı `lobby`'ye çektiğinde
  // (faz uzlaşması `matchover` → `lobby` geçişini zaten kabul eder) yerel
  // maç durumunu sıfırlarız. Böylece iki oyuncu da AYNI anda lobiye döner.
  //
  // NOT: `setState`-in-effect lint kuralına takılmamak için bayrak sıfırlama
  // yerine yalnızca `resetMatch` (harici sistem güncellemesi) yapılır; onay
  // bayrakları bir sonraki `matchover` girişinde sıfırlanır.
  const rematchAppliedRef = useRef(false)
  useEffect(() => {
    if (state.phase !== 'lobby') {
      rematchAppliedRef.current = false
      return
    }
    if (rematchAppliedRef.current) return
    // Yalnızca gerçek bir rövanş sonrası (onay verilmişken) uygula; normal
    // ilk lobi girişinde `resetMatch` zaten çağrılmıştır.
    if (!rematchReady && !rivalRematchReady) return
    rematchAppliedRef.current = true
    resetMatch()
  }, [resetMatch, rivalRematchReady, rematchReady, state.phase])

  const leaveGame = useCallback(async () => {
    // Rakibe "ayrıldım" sinyali yayınla; oyunu duraklatıp bilgilendirsin.
    // (Broadcast best-effort; kanal kapanmadan hemen önce gönderilir.)
    room.broadcast('leave', { by: room.playerId })
    // Önce sunucudan ayrılmayı dene (best-effort). Hata olsa bile yerel
    // durumu mutlaka temizle, aksi halde kullanıcı odada takılı kalır.
    try {
      await room.call('duo_leave', { p_token: room.token ?? room.playerId })
    } catch {
      /* yoksay — yerel çıkış yine de gerçekleşmeli */
    }
    await room.disconnect()
    resetMatch()
    setRivalLeft(false)
    setPhase('home')
    // Adres çubuğunu kök yola döndür; aksi halde `/play/CODE` kalır ve
    // sayfa yenilendiğinde eski odaya tekrar katılmaya çalışır.
    syncUrl('/')
  }, [resetMatch, room, setPhase])

  const setName = useCallback(
    (next: string) => {
      const trimmed = next.trim().slice(0, 16)
      if (!trimmed) return
      room.setName(trimmed)
      // Yerel oyuncu (index 0) adını hemen güncelle.
      updatePlayer('p1', { name: trimmed })
      // Sunucuya da yaz (best-effort).
      if (room.code) {
        void room.call('duo_set_name', { p_token: room.token ?? room.playerId, p_name: trimmed })
      }
    },
    [room, updatePlayer],
  )

  /**
   * AVATAR SEÇİMİ (isim değiştirme ile aynı desen).
   *
   * 1. `cosmetics.setAvatar` → yerel seçim + `duo_set_cosmetics` (kalıcı) +
   *    rakibe `avatar` broadcast'i.
   * 2. Yerel oyuncu satırını (index 0) hemen güncelle ki arena/HUD anında
   *    yeni hayvan yüzünü göstersin.
   * 3. Oda içindeyse seçimi oyuncu satırına da kopyala (`duo_apply_cosmetics`)
   *    ki rakip, sunucu snapshot'ından da doğru avatarı görsün.
   */
  const setAvatar = useCallback(
    (id: AvatarId) => {
      cosmetics.setAvatar(id)
      updatePlayer('p1', { avatar: id })
      if (room.code) {
        void room
          .call('duo_apply_cosmetics', {
            p_code: room.code,
            p_token: room.token ?? room.playerId,
            p_emote: cosmetics.emote,
            p_trail: cosmetics.trail,
            p_avatar: id,
          })
          .catch(() => undefined)
      }
    },
    [cosmetics, room, updatePlayer],
  )

  const copyInvite = useCallback(async () => {
    if (!room.code) return
    const url = `${window.location.origin}/play/${room.code}`
    try {
      await navigator.clipboard.writeText(url)
      toast.push('Invite link copied to clipboard.', 'success')
    } catch {
      // Clipboard API can be blocked (insecure context / permissions).
      // Fall back to an in-app toast instead of a native prompt.
      toast.push(`Copy this link: ${url}`, 'info')
    }
  }, [room.code, toast])

  const secondsLeft = state.phase === 'battle' ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0

  // Lobi hazır mı? Sunucudaki gerçek oyuncu sayısı 2 ise evet. Presence'a
  // güvenmek yanlış pozitif üretiyordu (rakip bağlı ama satırı yok).
  const lobbyReady = serverPlayerCount >= 2

  // Rakip ayrıldı mı? KARAR ARTIK SUNUCUYA DAYANIR.
  //
  // KÖK SORUN (kullanıcı raporu: "hareketler laglı, sonra rakip ayrıldı diyor,
  // oysa rakip oyunda"): Eski mantık `!room.opponentPresent` (Supabase
  // presence) + "canlı yayın yok" kombinasyonuna dayanıyordu. Presence
  // GÜVENİLMEZDİR: kanal yeniden abone olurken, sekme arka plana düşünce veya
  // ağ dalgalanmasında boş `sync` döner. Aynı anda rakibin `move` paketleri de
  // düşerse (tam da "laglı" senaryo) `rivalAliveAt` bayatlar ve YANLIŞ
  // "rakip ayrıldı" popup'ı çıkar. TTL'leri büyütmek semptomu hafifletir ama
  // kökü çözmez.
  //
  // ÇÖZÜM: Otoriteyi sunucuya veririz. `duo_public_state` her yoklamada
  // `playerCount` (odadaki GERÇEK oyuncu satırı sayısı) döndürür. Sunucu hâlâ
  // 2 oyuncu görüyorsa rakip KESİNLİKLE oyundadır — presence/broadcast ne
  // derse desin popup GÖSTERİLMEZ. Yalnızca:
  //   1. Rakip açıkça `leave` yayınladıysa (temiz çıkış), VEYA
  //   2. Sunucu oyuncu sayısını 2'nin altına düşürdüyse (satır silindi),
  // "rakip ayrıldı" deriz. Presence yalnızca İKİNCİL bir teyit sinyalidir.
  const inActiveMatch = state.phase === 'countdown' || state.phase === 'battle'
  const withinMatchGrace =
    matchStartAt > 0 && now - matchStartAt < MATCH_PRESENCE_GRACE_MS
  // RAKİP CANLI MI? Rakip son `RIVAL_ALIVE_TTL_MS` içinde bir yayın
  // (move/collect/steal/score/trail) gönderdiyse KESİNLİKLE oyundadır.
  const rivalAliveRecently = rivalAliveAt > 0 && now - rivalAliveAt < RIVAL_ALIVE_TTL_MS
  // SUNUCU ONAYI: Sunucu 2 oyuncu görüyorsa rakip oyundadır. `serverPlayerCount`
  // 0 ise (henüz yoklanmadı) bu sinyale GÜVENMEYİZ; yalnızca tam olarak 1
  // olduğunda "sunucu rakibi görmüyor" deriz.
  const serverConfirmsRivalGone = serverPlayerCount === 1
  // Presence İKİNCİL teyit: presence düştü VE sunucu da rakibi görmüyor.
  const presenceConfirmsGone = room.presenceReady && !room.opponentPresent
  // `leave` broadcast'i de TEK BAŞINA yeterli DEĞİLDİR: Supabase kanalı
  // yeniden abone olurken sahte bir `leave` üretebiliyor (kullanıcı raporu:
  // host, misafir hâlâ oynarken "rakip ayrıldı" gördü). Bu yüzden `leave`'i
  // yalnızca SUNUCU da rakibi görmüyorsa dikkate alırız. Böylece hem temiz
  // çıkış (satır silinir → playerCount=1) hem de gerçek kopma yakalanır;
  // sahte `leave` ise sunucu hâlâ 2 oyuncu gördüğü için YOK SAYILIR.
  const leaveConfirmed = rivalLeft && serverConfirmsRivalGone
  const rivalGone =
    Boolean(room.code) &&
    !withinMatchGrace &&
    !rivalAliveRecently &&
    (leaveConfirmed || (inActiveMatch && serverConfirmsRivalGone && presenceConfirmsGone))

  return {
    state,
    room,
    // Bağlantı durumu: `recovering` iken UI küçük, rahatsız etmeyen bir
    // "Yeniden bağlanılıyor…" göstergesi çizebilir. Oyuncu sayfayı elle
    // yenilemek zorunda kalmaz; `useRoom` arka planda kendini onarır.
    connection: room.status,
    progress,
    chaos,
    cosmetics,
    toast,
    busy,
    error,
    secondsLeft,
    lobbyReady,
    serverPlayerCount,
    rivalLeft: rivalGone,
    onJoystick,
    livePos,
    liveRivalPos,
    celebrateRef,
    diamondPopRef,
    comboRef,
    scorePopRef,
    shakeRef,
    createRoom,
    joinRoom,
    restore,
    startGame,
    approveNextRound,
    nextReady,
    rivalNextReady,
    rematch,
    rematchReady,
    rivalRematchReady,
    leaveGame,
    setName,
    setAvatar,
    copyInvite,
    triggerEmote: () => cosmetics.triggerEmote(),
  }
}

export { BATTLE_MS }
