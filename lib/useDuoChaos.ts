'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BATTLE_MS,
  COIN_RESPAWN_MS,
  COUNTDOWN_MS,
  MATCH_ROUNDS,
  POLL_MS,
  REMOTE_POS_TTL,
  generateObjectivePair,
  spawnCoins,
} from './config'
import { friendlyError } from './errors'
import { playSound, unlockAudio } from './sound'
import { useChaos } from './useChaos'
import { useCosmetics } from './useCosmetics'
import { useGameLoop } from './useGameLoop'
import { blankPlayer, useGameState } from './useGameState'
import { useProgress } from './useProgress'
import { useRoom, readToken, saveToken } from './useRoom'
import { useScout } from './useScout'
import { useToast } from './useToast'
import type { Coin, EmoteId, Phase, Player, State, TrailId } from './types'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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

/**
 * Skor kalıcılığı. `duo_tick` çağrılmadığı için sunucu skoru saklamaz; sayfa
 * yenilendiğinde yerel skor sıfırlanıyordu ("yenileyince puanım sıfırlanıyor").
 * Skoru oda bazında localStorage'da tutarız; `restore` sırasında geri yükleriz.
 */
const scoreKey = (code: string) => `duo-chaos:score:${code}`

const readScores = (code: string): { p1: number; p2: number } | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(scoreKey(code))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { p1?: number; p2?: number }
    return { p1: Number(parsed.p1) || 0, p2: Number(parsed.p2) || 0 }
  } catch {
    return null
  }
}

const writeScores = (code: string, scores: { p1: number; p2: number }) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(scoreKey(code), JSON.stringify(scores))
  } catch {
    // Kota dolu / gizli mod — sessizce yoksay.
  }
}

const clearScores = (code: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(scoreKey(code))
  } catch {
    // yoksay
  }
}

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
const mergeCoins = (local: Coin[], server: Coin[]): Coin[] => {
  const byId = new Map(server.map((coin) => [coin.id, coin]))
  return local.map((coin) => {
    const remote = byId.get(coin.id)
    if (!remote) return coin
    // Sunucu toplanmış diyorsa otoritedir; değilse yerel "toplandı" kararını koru.
    const collectedBy = remote.collectedBy ?? coin.collectedBy
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
  const game = useGameState()
  const room = useRoom()
  const progress = useProgress()
  const chaos = useChaos()
  const scout = useScout(room.code, room.playerId, room.token)
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
  // Bu turda rakipten EN AZ BİR `move` broadcast'i aldık mı?
  //
  // KÖK SORUN ("hareket ediyorum, sonra birden başlangıç konumuna gidiyor"):
  // Rakibin konumu iki kaynaktan gelir: (1) 60Hz `move` broadcast'i — taze ve
  // akıcı; (2) 1 sn'de bir yoklanan sunucu snapshot'ı (`duo_public_state`) —
  // GECİKMELİ. `duo_move` yalnızca oyuncu HAREKET EDERKEN yazılır ve
  // `not_live`/ağ hatası durumunda sessizce düşer; bu yüzden sunucudaki x/y
  // sık sık eski (hatta spawn) konumda kalır. Eski kod, broadcast 600 ms'den
  // eskiyse sunucu değerini uyguluyordu; rakip durduğunda (yeni broadcast
  // gelmez) sunucunun BAYAT konumu devreye girip rakibi geriye/spawn'a
  // zıplatıyordu.
  //
  // ÇÖZÜM: Bu turda bir kez broadcast gördüysek, sunucu snapshot'ı ARTIK rakip
  // konumu için otorite DEĞİLDİR. Broadcast kesilse bile son bilinen konumu
  // koruruz (rakip donar ama asla geriye zıplamaz). Sunucu konumu yalnızca
  // HİÇ broadcast görülmediyse (geç katılma / yeniden bağlanma) kullanılır.
  // Tur değişiminde sıfırlanır.
  const rivalBroadcastSeenRef = useRef(false)
  // `room` her render'da yeni bir nesne kimliği taşır (useRoom dönüşü
  // memoize edilmemiş). Bu yüzden yoklama effect'lerinin bağımlılığı olarak
  // `room` kullanmak, effect'in her render'da yeniden kurulup interval'i
  // sıfırlamasına ve hiç ateşlenmemesine yol açıyordu. Çağrı fonksiyonunu
  // ref'te tutup effect'leri kararlı ilkel değerlere bağlarız.
  const callRef = useRef(room.call)
  useEffect(() => {
    callRef.current = room.call
  }, [room.call])

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

  const { state, setState, setPhase, resetRound, resetMatch, updatePlayer } = game

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

  // SKOR HEARTBEAT: Skorumuzu periyodik olarak MUTLAK değerle yeniden yayınlarız.
  // Skor değişiminde zaten anlık yayın yapılır (bkz. useGameLoop); ancak tek bir
  // paket kaybolursa rakip yanlış puan görür. Bu heartbeat her iki tarafın da
  // skorunu birkaç saniye içinde yakınsar ("puanlar birbirinden farklı görünüyor"
  // sorununun kalıcı çözümü). Yalnızca aktif fazlarda ve sekme görünürken çalışır.
  useEffect(() => {
    if (state.phase !== 'countdown' && state.phase !== 'battle') return
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      const myScore = stateRef.current.players[0]?.score ?? 0
      room.broadcast('score', { by: room.playerId, score: myScore })
    }, 2_000)
    return () => window.clearInterval(id)
  }, [room, state.phase])

  const cosmetics = useCosmetics(
    { emote: progress.progress.emote, trail: progress.progress.trail },
    (input) => void progress.setCosmetics(input),
    (id) => room.broadcast('emote', { by: room.playerId, id }),
    // İz (trail) seçimi değişince rakibe bildir; rakip `state.players[1].trail`
    // üzerinden bizim izimizi görsün.
    (id) => room.broadcast('trail', { by: room.playerId, id }),
  )

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

  useEffect(() => {
    if (!room.code) return
    const publish = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      room.broadcast('trail', { by: room.playerId, id: trailRef.current })
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
      // Sunucuya yazma "best-effort"tur. 60Hz'de yayın yaptığımız için
      // `duo_start_round` oyuncu satırını sıfırlarken bir `duo_move` yarışıp
      // `not_a_player` fırlatabilir; bu zararsızdır (sonraki kare başarılı olur).
      // Yakalanmazsa unhandled rejection → `pageerror` olur, bu yüzden yutarız.
      void room
        .call('duo_move', { p_token: room.token ?? room.playerId, p_x: x, p_y: y })
        .catch(() => undefined)
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
        setState((prev) => ({
          ...prev,
          phase: data.phase as Phase,
          winner: data.winner ?? prev.winner,
          roundScores: data.roundScores ?? prev.roundScores,
          matchScores: data.matchScores ?? prev.matchScores,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
        }))
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

  const loop = useGameLoop({
    state,
    setState,
    token: room.token,
    // Yerel oyuncunun sunucu slotu. Yayınlanan `collect`/`steal`/`score`
    // olaylarında `by` alanına yazılır; böylece karşı taraf kendi yayınını
    // doğru şekilde ayırt edebilir.
    playerId: room.playerId,
    publishMove,
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

  // Realtime olaylarını bağla.
  useEffect(() => {
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
      // Bu turda rakipten canlı konum aldık: artık sunucu snapshot'ı rakip
      // konumunu GERİYE ÇEKEMEZ (aşağıdaki poll merge'e bakınız).
      rivalBroadcastSeenRef.current = true
      // `useGameLoop`'a da "bu turda broadcast gördük" bilgisini taşı. Ayrı bir
      // prop eklemek yerine `remotePos` map'ine bir sentinel anahtar yazarız.
      remotePos.current.set('__seen__', { x: 0, y: 0, at })
    })

    const offCollect = room.on('collect', (payload) => {
      const data = payload as { ids?: number[]; by?: string; respawnAt?: number }
      if (!data || data.by === room.playerId || !data.ids || data.ids.length === 0) return
      const ids = new Set(data.ids)
      // Rakip topladığında da coin AYNI konumda, 3 sn sonra yeniden doğar.
      // `respawnAt` yazmazsak coin sonsuza dek toplanmış kalır ve bir daha
      // görünmez; bu da "coin kayboldu" hissi verir.
      //
      // ÖNEMLİ: `respawnAt`'i gönderen tarafın verdiği değerle (varsa) kurarız;
      // böylece iki istemci AYNI anda canlandırır. Yoksa yerel saatten türetiriz.
      const respawnAt =
        typeof data.respawnAt === 'number' && data.respawnAt > 0
          ? data.respawnAt
          : Date.now() + COIN_RESPAWN_MS
      setState((prev) => {
        // Zaten toplanmış coinleri TEKRAR saymayız (idempotent). Aksi halde
        // aynı `collect` paketi iki kez gelirse rakip skoru şişer.
        let newlyCollected = 0
        const coins = prev.coins.map((coin) => {
          if (!ids.has(coin.id)) return coin
          if (coin.collectedBy) return coin
          newlyCollected += 1
          return { ...coin, collectedBy: 'p2' as const, respawnAt }
        })
        if (newlyCollected === 0) return prev
        return {
          ...prev,
          coins,
          players: prev.players.map((player, index) =>
            index === 1 ? { ...player, coins: player.coins + newlyCollected } : player,
          ),
        }
      })
    })

    const offSteal = room.on('steal', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      playSound('bump')
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 0
            ? { ...player, coins: Math.max(0, player.coins - 1), slowedUntil: Date.now() + 400 }
            : { ...player, stolen: player.stolen + 1 },
        ),
      }))
    })

    const offEmote = room.on('emote', (payload) => {
      const data = payload as { by?: string; id?: EmoteId }
      if (!data || data.by === room.playerId || !data.id) return
      cosmetics.showRemoteEmote(data.id)
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, emote: data.id ?? null } : player,
        ),
      }))
    })

    // Rakip iz (trail) seçimini değiştirdiğinde anında yansıt.
    const offTrail = room.on('trail', (payload) => {
      const data = payload as { by?: string; id?: TrailId }
      if (!data || data.by === room.playerId || !data.id) return
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, trail: data.id ?? 'none' } : player,
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
    const offLeave = room.on('leave', (payload) => {
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      setRivalLeft(true)
      playSound('lose')
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
      // ("bir oyuncu next round demeden tur başladı" hatası). Artık paketin
      // `round` alanı yerel tur ile eşleşmiyorsa YOK SAYARIZ.
      const currentRound = roundRef.current
      if (typeof data.round === 'number' && data.round !== currentRound) return
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
      setRivalLeft(false)
    })

    // SKOR SENKRONU: Rakip MUTLAK skorunu yayınlar; biz de rakibin (index 1)
    // skorunu bu değere EŞİTLERİZ. Delta eklemek yerine eşitlemek, kaçan bir
    // paketin kalıcı sapmaya yol açmasını engeller (her yayın kendini düzeltir).
    // Geriye dönük uyumluluk için `delta` alanı da desteklenir.
    const offScore = room.on('score', (payload) => {
      const data = payload as { by?: string; score?: number; delta?: number }
      if (!data || data.by === room.playerId) return
      const absolute = typeof data.score === 'number' ? data.score : null
      const delta = typeof data.delta === 'number' ? data.delta : 0
      if (absolute === null && !delta) return
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) => {
          if (index !== 1) return player
          const nextScore = absolute !== null ? absolute : player.score + delta
          const diff = nextScore - player.score
          return {
            ...player,
            score: nextScore,
            roundScore: Math.max(0, (player.roundScore ?? 0) + diff),
          }
        }),
      }))
    })

    return () => {
      offNextReady()
      offRematchReady()
      offHello()
      offMove()
      offCollect()
      offSteal()
      offEmote()
      offTrail()
      offName()
      offLeave()
      offScore()
    }
  }, [cosmetics, room, setState])

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
      // Sunucu saat farkını güncelle, sonra deadline'ları yerel saate çevir.
      noteServerNow(data.serverNow)
      const localEndsAt = toLocal(data.endsAt)
      const localCountdownEndsAt = toLocal(data.countdownEndsAt)
      // En son sunucu deadline'larını sakla: misafir yeni turda `resetRound`
      // çağırınca bu değerler sıfırlanır; resetten sonra geri yazarız.
      if (localCountdownEndsAt > 0) serverDeadlineRef.current.countdownEndsAt = localCountdownEndsAt
      if (localEndsAt > 0) serverDeadlineRef.current.endsAt = localEndsAt
      setState((prev) => {
        const players = prev.players.map((player) => {
          const server = data.players?.find((item) => mapPlayerId(String(item.id), myId) === player.id)
          if (!server) return player
          // Sunucudan gelen adı koru; boşsa mevcut adı bırak.
          const serverName = typeof server.name === 'string' && server.name.trim() ? server.name : player.name
          const merged = { ...player, ...server, id: player.id, name: serverName } as Player
          // OYUN İLERLEMESİ OTORİTESİ (p1): `duo_tick` artık çağrılmadığı için
          // sunucu coin/görev ilerlemesini GÜNCELLEMEZ. Sunucu snapshot'ındaki
          // `objectivesDone`, `collectedTypes`, `coins`, `stolen`, `missionDone`,
          // `objective`, `score` alanları her zaman 0/boş gelir. Bunları
          // uygularsak her yoklamada (1 sn) oyuncunun ilerlemesi SIFIRLANIR:
          // "görevi tamamladım ama sayaç artmadı, yeni görev gelmedi" hatası
          // tam olarak buydu. Bu yüzden p1 için bu alanları client'tan koruruz.
          //
          // KONUM OTORİTESİ: yerel oyuncunun (p1) x/y'si de HER ZAMAN client'a
          // aittir. Sunucu snapshot'ı gecikmeli gelir; onu uygularsak oyuncu
          // her yoklamada geriye zıplar ("donma + birden ilerleme").
          //
          // `slowedUntil` de client'a aittir: sunucu bunu KENDİ saatiyle
          // damgalar; saat farkı yüzünden yanlış yorumlanıp oyuncuyu kalıcı
          // yavaşlatabilir. Yavaşlama zaten yerel olarak (steal anında) kurulur.
          if (player.id === 'p1') {
            merged.x = player.x
            merged.y = player.y
            merged.slowedUntil = player.slowedUntil
            merged.coins = player.coins
            merged.stolen = player.stolen
            merged.collectedTypes = player.collectedTypes
            merged.objectivesDone = player.objectivesDone
            merged.missionDone = player.missionDone
            merged.objective = player.objective
            merged.score = player.score
            merged.roundScore = player.roundScore
          }
          // Rakip (p2) verisi: sunucu `duo_tick` çağrılmadığı için skoru,
          // kozmetikleri ve adı GÜNCELLEMEZ (hep 0/boş döner). Bu alanları
          // sunucudan uygularsak rakip skoru her yoklamada 0'a düşer ve
          // "rakibim beni 0 görüyor" hatası oluşur. Bu yüzden rakip için de
          // client-authoritative alanları (broadcast ile gelen) koruruz.
          if (player.id === 'p2') {
            merged.score = player.score
            merged.roundScore = player.roundScore
            merged.totalScore = player.totalScore
            merged.trail = player.trail
            merged.emote = player.emote
            merged.name = player.name
            merged.objectivesDone = player.objectivesDone
            merged.missionDone = player.missionDone
            // Rakip konumu: taze bir `move` broadcast'i varsa sunucunun
            // gecikmeli x/y'si ile ezme; broadcast yoksa sunucu değeri
            // otoritedir (yeniden bağlanma / ışınlanma).
            //
            // ÖNEMLİ: `move` broadcast'i gönderenin SLOTU ile anahtarlanır.
            // Yerel oyuncu `p2` ise rakip `p1`'dir; eski kod yalnızca `'rival'`
            // veya `'p2'` aradığı için `p1` anahtarını bulamıyordu. Bu blok
            // yalnızca rakip (`p2`) için çalıştığından rakibin slotu `p2`'dir;
            // yine de `'rival'` geriye dönük anahtarını da deneriz.
            // Bu turda rakipten canlı broadcast aldıysak sunucu konumunu ASLA
            // uygulamayız: sunucu x/y'si gecikmeli/bayat olabilir ve rakibi
            // geriye (spawn'a) zıplatırdı. Yalnızca hiç broadcast görmediysek
            // (geç katılma / yeniden bağlanma) sunucu konumunu benimseriz.
            const remote = remotePos.current.get('p2') ?? remotePos.current.get('rival')
            if (rivalBroadcastSeenRef.current || (remote && Date.now() - remote.at < REMOTE_POS_TTL)) {
              merged.x = player.x
              merged.y = player.y
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
          const roundChanged = (data.round ?? prev.round) !== prev.round
          const coins = !serverCoins
            ? prev.coins
            : roundChanged
              ? serverCoins
              : mergeCoins(prev.coins, serverCoins)
          return {
            ...prev,
            phase,
            round: data.round ?? prev.round,
            endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
            countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
            winner: data.winner ?? prev.winner,
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
      const me = data.players?.find((item) => mapPlayerId(String(item.id), myId) === 'p1')
      if (me) {
        scout.sync({
          charges: me.scoutCharges,
          usedAt: me.scoutUsedAt,
          hint: me.revealedHint ?? null,
        })
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
  }, [chaos, noteServerNow, room.code, room.playerId, room.token, scout, setState, state.phase, toLocal])

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
        const serverPhase = data.phase as Phase
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
        const roundChanged = (data.round ?? prev.round) !== prev.round
        const coins = !serverCoins
          ? prev.coins
          : roundChanged
            ? serverCoins
            : mergeCoins(prev.coins, serverCoins)
        const phaseChanged = nextPhase !== prev.phase
        const coinsChanged = coins !== prev.coins
        if (!phaseChanged && !data.winner && !coinsChanged) return prev
        return {
          ...prev,
          phase: nextPhase,
          winner: data.winner ?? prev.winner,
          round: data.round ?? prev.round,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
          coins,
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
      scout.reset()
      setNextReady(false)
      setRivalNextReady(false)
      // Yeni turda rakibin ESKİ broadcast konumunu bırak. Aksi halde rakip
      // henüz hareket etmemişse eski konumda "asılı" kalır ve iki oyuncu aynı
      // noktada başlıyormuş gibi görünür. Sunucu spawn konumu devralır.
      remotePos.current.clear()
      // Yeni turda "broadcast gördük" mandalını da sıfırla: rakip henüz
      // hareket etmediyse sunucu spawn konumu otorite olmalı.
      rivalBroadcastSeenRef.current = false
      // ÖNEMLİ: `resetRound` `countdownEndsAt`/`endsAt`'i sıfırlar. Misafirin
      // geri sayımı silinmesin diye sunucudan gelen EN SON deadline'ları
      // hemen geri yazarız. Aksi halde misafir "3-2-1" görmeden ya da geç
      // başlıyordu. `setState` ile tek seferde uygularız (yarış yok).
      const { countdownEndsAt, endsAt } = serverDeadlineRef.current
      if (countdownEndsAt > 0 || endsAt > 0) {
        setState((prev) => ({
          ...prev,
          countdownEndsAt: countdownEndsAt > 0 ? countdownEndsAt : prev.countdownEndsAt,
          endsAt: endsAt > 0 ? endsAt : prev.endsAt,
        }))
      }
    }
  }, [resetRound, room.code, scout, setState, state.phase, state.round])

  // Skoru kalıcı hale getir. `duo_tick` çağrılmadığı için sunucu skoru
  // saklamaz; sayfa yenilendiğinde yerel skor sıfırlanıyordu. Burada skoru
  // oda bazında localStorage'a yazarız; `restore` bunu geri yükler.
  // Yalnızca aktif oyun fazlarında yazarız (home/lobby'de gereksiz yazma yok).
  useEffect(() => {
    const code = room.code
    if (!code) return
    if (state.phase !== 'countdown' && state.phase !== 'battle' && state.phase !== 'results' && state.phase !== 'matchover') {
      return
    }
    writeScores(code, { p1: state.players[0]?.score ?? 0, p2: state.players[1]?.score ?? 0 })
  }, [room.code, state.phase, state.players])

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
    if (!code || state.phase !== 'lobby') return
    const myId = room.playerId
    const myToken = room.token ?? room.playerId
    let cancelled = false
    const pull = async () => {
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
      setState((prev) => {
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
                // Sunucu `duo_tick` çağrılmadığı için skoru/kozmetikleri
                // güncellemez (hep 0/boş döner). Lobide de bu alanları
                // client'tan koruruz; aksi halde geri yüklenen skor ve seçilen
                // iz her yoklamada sıfırlanır.
                merged.score = player.score
                merged.roundScore = player.roundScore
                merged.totalScore = player.totalScore
                merged.trail = player.trail
                merged.emote = player.emote
                return merged
              })
            : prev.players
        // Sunucu fazı lobiden çıktıysa (host başlattı) yerel fazı da ilerlet.
        const nextPhase = data.phase && data.phase !== 'lobby' ? data.phase : prev.phase
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
        const leavingLobby = prev.phase === 'lobby' && nextPhase !== 'lobby'
        if (leavingLobby) {
          const round = data.round ?? prev.round
          const roundSeed = roundSeedFor(room.code, round)
          const [first, second] = generateObjectivePair(roundSeed)
          scout.reset()
          remotePos.current.clear()
          rivalBroadcastSeenRef.current = false
          const { countdownEndsAt, endsAt } = serverDeadlineRef.current
          return {
            ...prev,
            phase: nextPhase,
            round,
            // Coin/görev düzenini tur seed'inden yeniden üret (host ile birebir).
            coins: spawnCoins(roundSeed),
            chaosEvent: undefined,
            chaosEventEndsAt: undefined,
            winner: undefined,
            endsAt: localEndsAt > 0 ? localEndsAt : endsAt > 0 ? endsAt : prev.endsAt,
            countdownEndsAt:
              localCountdownEndsAt > 0
                ? localCountdownEndsAt
                : countdownEndsAt > 0
                  ? countdownEndsAt
                  : prev.countdownEndsAt,
            players: prev.players.map((player, index) => ({
              ...blankPlayer(player.id as 'p1' | 'p2'),
              name: player.name,
              xp: player.xp,
              level: player.level,
              title: player.title,
              trail: player.trail,
              objective: index === 0 ? first : second,
            })),
          }
        }
        return {
          ...prev,
          phase: nextPhase,
          round: data.round ?? prev.round,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
          winner: data.winner ?? prev.winner,
          players,
        }
      })
    }
    void pull()
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void pull()
    }, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [noteServerNow, room.code, room.playerId, room.token, scout, setState, state.phase, toLocal])

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
        const displayName = (name ?? room.name ?? '').trim()
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
        const displayName = (name ?? room.name ?? '').trim()
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
      try {
        // Sunucudan hangi slotta olduğumuzu öğren (p1 mi p2 mi?).
        const data = await room.call<{ player_id?: string; name?: string }>('duo_join_room', {
          p_code: normalized,
          p_token: token,
        })
        const slot: 'p1' | 'p2' = data?.player_id === 'p1' ? 'p1' : 'p2'
        await room.connect(normalized, slot, token, data?.name ?? room.name)
        resetMatch()
        if (data?.name) updatePlayer('p1', { name: data.name })
        // Skoru geri yükle: sayfa yenilendiğinde puan sıfırlanmasın.
        const saved = readScores(normalized)
        if (saved) {
          updatePlayer('p1', { score: saved.p1, roundScore: saved.p1 })
          updatePlayer('p2', { score: saved.p2, roundScore: saved.p2 })
        }
        setPhase('lobby')
        syncUrl(`/play/${normalized}`)
        return true
      } catch {
        // Token geçersiz (oda silinmiş / oyuncu atılmış) → normal katılmaya düş.
        return false
      }
    },
    [resetMatch, room, setPhase, updatePlayer],
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
      scout.reset()
      // Yeni maçta rakibin eski broadcast konumunu bırak.
      remotePos.current.clear()
      rivalBroadcastSeenRef.current = false
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
  }, [noteServerNow, resetRound, room, scout, setPhase, toLocal])

  /**
   * Sonraki turu GERÇEKTEN başlatır. Yalnızca iki oyuncu da onayladığında
   * (aşağıdaki effect) çağrılır. Host'un tek başına başlatması engellenir.
   */
  const beginNextRound = useCallback(async () => {
    setBusy(true)
    try {
      const nextRound = state.round + 1
      const res = await room.call<{ serverNow?: number; countdownEndsAt?: number }>(
        'duo_start_round',
        { p_token: room.token ?? room.playerId },
      )
      resetRound(nextRound, roundSeedFor(room.code, nextRound))
      scout.reset()
      noteServerNow(res?.serverNow)
      const localCountdown = toLocal(res?.countdownEndsAt)
      // Yeni turda rakibin eski broadcast konumunu bırak (iki oyuncu aynı
      // noktada başlamasın).
      remotePos.current.clear()
      rivalBroadcastSeenRef.current = false
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
  }, [noteServerNow, resetRound, room, scout, setPhase, state.round, toLocal])

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
  useEffect(() => {
    if (state.phase !== 'results') return
    if (readyRoundRef.current === state.round) return
    readyRoundRef.current = state.round
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
  useEffect(() => {
    if (!nextReady || rivalNextReady) return
    if (state.phase !== 'results') return
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      room.broadcast('next-ready', { by: room.playerId, round: state.round })
    }, 1_500)
    return () => window.clearInterval(id)
  }, [nextReady, rivalNextReady, room, state.phase, state.round])

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
   * oraya geçer ve `resetMatch`/`scout.reset` bu geçişte uygulanır.
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

  // RÖVANŞ ONAY HEARTBEAT: Yerel onay verildiyse ama rakip hâlâ onaylamadıysa
  // onayımızı periyodik olarak yeniden yayınlarız (tek paket kaybolursa
  // el sıkışma yakınsasın diye).
  useEffect(() => {
    if (!rematchReady || rivalRematchReady) return
    if (state.phase !== 'matchover') return
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      room.broadcast('rematch-ready', { by: room.playerId })
    }, 1_500)
    return () => window.clearInterval(id)
  }, [rematchReady, rivalRematchReady, room, state.phase])

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
  // yerine yalnızca `resetMatch`/`scout.reset` (harici sistem güncellemesi)
  // yapılır; onay bayrakları bir sonraki `matchover` girişinde sıfırlanır.
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
    scout.reset()
  }, [resetMatch, rivalRematchReady, rematchReady, scout, state.phase])

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
    // Odadan ayrılınca kayıtlı skoru temizle; yeni oyun sıfırdan başlasın.
    if (room.code) clearScores(room.code)
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

  // Rakip ayrıldı mı? İki sinyalden biri yeterli:
  //   1. `rivalLeft` — rakip 'leave' broadcast'i gönderdi (temiz çıkış).
  //   2. Presence düştü — rakip sekmesini kapatıp broadcast gönderemeden
  //      düştü. Yalnızca aktif bir maç sırasında dikkate alınır.
  //
  // ÖNEMLİ: Her iki sinyal de `!room.opponentPresent` ile kapılanır. Rakip
  // yeniden bağlanıp presence'da göründüğü anda `rivalGone` OTOMATİK olarak
  // `false` olur — böylece "rakip geri geldi ama popup hâlâ duruyor" hatası
  // (setState-in-effect kullanmadan) kökten çözülür.
  const inActiveMatch = state.phase === 'countdown' || state.phase === 'battle'
  const rivalGone =
    Boolean(room.code) &&
    !room.opponentPresent &&
    (rivalLeft || inActiveMatch)

  return {
    state,
    room,
    progress,
    chaos,
    scout,
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
    copyInvite,
    triggerEmote: () => cosmetics.triggerEmote(),
  }
}

export { BATTLE_MS }
