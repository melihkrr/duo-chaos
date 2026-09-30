'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BATTLE_MS,
  COIN_RESPAWN_MS,
  COUNTDOWN_MS,
  MATCH_ROUNDS,
  POLL_MS,
  REMOTE_POS_TTL,
} from './config'
import { friendlyError } from './errors'
import { playSound, unlockAudio } from './sound'
import { useChaos } from './useChaos'
import { useCosmetics } from './useCosmetics'
import { useGameLoop } from './useGameLoop'
import { useGameState } from './useGameState'
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
  coins?: Coin[]
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
  const remotePos = useRef<Map<string, { x: number; y: number; at: number }>>(new Map())
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
      remotePos.current.set(data.by ?? 'rival', { x: data.x, y: data.y, at: Date.now() })
    })

    const offCollect = room.on('collect', (payload) => {
      const data = payload as { ids?: number[]; by?: string }
      if (!data || data.by === room.playerId || !data.ids) return
      const ids = new Set(data.ids)
      // Rakip topladığında da coin AYNI konumda, 3 sn sonra yeniden doğar.
      // `respawnAt` yazmazsak coin sonsuza dek toplanmış kalır ve bir daha
      // görünmez; bu da "coin kayboldu" hissi verir.
      const respawnAt = Date.now() + COIN_RESPAWN_MS
      setState((prev) => ({
        ...prev,
        coins: prev.coins.map((coin) =>
          ids.has(coin.id) ? { ...coin, collectedBy: 'p2', respawnAt } : coin,
        ),
        players: prev.players.map((player, index) =>
          index === 1 ? { ...player, coins: player.coins + ids.size } : player,
        ),
      }))
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
      const data = payload as { by?: string }
      if (!data || data.by === room.playerId) return
      setRivalNextReady(true)
      // Host, rakibin onayını alınca ve kendisi de onaylamışsa turu başlatır.
      // (Effect yerine olay işleyicisinde başlatırız; lint kuralı gereği.)
      if (nextReadyRef.current && room.playerId === 'p1') {
        void beginNextRoundRef.current?.()
      }
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
            const remote = remotePos.current.get('rival') ?? remotePos.current.get('p2')
            if (remote && Date.now() - remote.at < REMOTE_POS_TTL) {
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
        return {
          ...prev,
          phase,
          round: data.round ?? prev.round,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
          winner: data.winner ?? prev.winner,
          // COIN OTORİTESİ: coinlerin yeniden doğması tamamen client tarafında
          // yönetilir (aynı konum + 3 sn). Sunucu snapshot'ı `duo_tick`
          // çağrılmadığı için coinleri hiç canlandırmaz; onu uygularsak coinler
          // her yoklamada "yok olup tekrar çıkar" ve renkleri zıplar. Bu yüzden
          // coinleri yalnızca YENİ bir tur başladığında (round değiştiğinde)
          // sunucudan alırız; aksi halde client'ın kendi listesini koruruz.
          coins:
            data.coins && data.coins.length > 0 && (data.round ?? prev.round) !== prev.round
              ? data.coins
              : prev.coins,
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
        // Faz yalnızca İLERİ gider: `home → lobby → countdown → battle →
        // results → matchover`. Sunucu geriye dönük bir faz döndürürse
        // (gecikmeli yanıt) yok sayarız; aksi halde oyun geriye zıplar.
        const order: Phase[] = ['home', 'lobby', 'countdown', 'battle', 'results', 'matchover']
        const rank = (p: Phase) => order.indexOf(p)
        const nextPhase = rank(serverPhase) > rank(prev.phase) ? serverPhase : prev.phase
        if (nextPhase === prev.phase && !data.winner) return prev
        return {
          ...prev,
          phase: nextPhase,
          winner: data.winner ?? prev.winner,
          round: data.round ?? prev.round,
          endsAt: localEndsAt > 0 ? localEndsAt : prev.endsAt,
          countdownEndsAt: localCountdownEndsAt > 0 ? localCountdownEndsAt : prev.countdownEndsAt,
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
  }, [noteServerNow, room.code, room.playerId, room.token, setState, state.phase, toLocal])

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
      resetRound(1, room.code ?? 'round-1')
      scout.reset()
      // Sunucu deadline'larını yerel saate çevir (saat farkı düzeltmesi).
      noteServerNow(res?.serverNow)
      const localCountdown = toLocal(res?.countdownEndsAt)
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
      resetRound(nextRound, room.code ?? `round-${nextRound}`)
      scout.reset()
      noteServerNow(res?.serverNow)
      const localCountdown = toLocal(res?.countdownEndsAt)
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
    room.broadcast('next-ready', { by: room.playerId })
    // Rakip zaten onaylamışsa ve host bizsek turu hemen başlat.
    if (rivalNextReady && room.playerId === 'p1') {
      void beginNextRound()
    }
  }, [beginNextRound, rivalNextReady, room])

  // NEXT-READY HEARTBEAT: Yerel oyuncu onayladıysa ama rakip hâlâ onaylamadıysa
  // onayımızı periyodik olarak yeniden yayınlarız. Tek bir `next-ready` paketi
  // kaybolursa host turu hiç başlatmaz ve bir oyuncu "waiting for rival"
  // ekranında takılı kalırdı. Heartbeat bu el sıkışmayı yakınsar.
  useEffect(() => {
    if (!nextReady || rivalNextReady) return
    if (state.phase !== 'results') return
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      room.broadcast('next-ready', { by: room.playerId })
    }, 1_500)
    return () => window.clearInterval(id)
  }, [nextReady, rivalNextReady, room, state.phase])

  const rematch = useCallback(async () => {
    setBusy(true)
    try {
      await room.call('duo_rematch', { p_token: room.token ?? room.playerId })
      resetMatch()
      scout.reset()
      setPhase('lobby')
    } finally {
      setBusy(false)
    }
  }, [resetMatch, room, scout, setPhase])

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

  /**
   * Rakip ayrıldıktan sonra "Bekle" seçeneği: uyarıyı kapatır ve oyunu
   * duraklatılmış halde bırakır. Rakip geri gelirse (presence yeniden
   * görünürse) oyun kaldığı yerden devam eder.
   */
  const waitForRival = useCallback(() => {
    setRivalLeft(false)
  }, [])

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
  const inActiveMatch = state.phase === 'countdown' || state.phase === 'battle'
  const rivalGone = rivalLeft || (inActiveMatch && Boolean(room.code) && !room.opponentPresent)

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
    leaveGame,
    waitForRival,
    setName,
    copyInvite,
    triggerEmote: () => cosmetics.triggerEmote(),
  }
}

export { BATTLE_MS }
