'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  BATTLE_MS,
  BUMP_SLOW_MS,
  BUMP_SPEED_MULTIPLIER,
  COIN_RESPAWN_MS,
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  MOVE_HEARTBEAT_MS,
  MOVE_SEND_MS,
  MOVE_SPEED,
  PHASE_TICK_MS,
  REMOTE_HARD_TTL_MS,
  REMOTE_POS_TTL,
  REMOTE_SMOOTHING_K,
  STEAL_COOLDOWN_MS,
  STEAL_RADIUS,
  getCoinValue,
} from './config'
import { objectiveSatisfied } from './display'
import { resolveMove } from './movement'
import { playSound } from './sound'
import type { Coin, Player, State } from './types'

/** Rakip interpolasyonunun "oturduğu" eşik (arena %). Altındaysa yazmayız. */
const REMOTE_SETTLE = 0.25

/**
 * Görev tamamlandığında gösterilen kutlama penceresinin süresi (ms).
 *
 * ÖNEMLİ: Yeni görev ARTIK bu süre beklenmeden, tamamlanma anında HEMEN
 * atanır. Bu süre yalnızca "Görev tamamlandı! +25" kutlama katmanının ne
 * kadar görüneceğini belirler; oyun akışını bloklamaz.
 */
const OBJECTIVE_CELEBRATE_MS = 1_400

/**
 * COMBO (ardışık toplama serisi) penceresi (ms).
 *
 * İki toplama arası bu süreden kısaysa seri artar; aksi halde sıfırlanır.
 * Amaç: oyuncuyu hızlı ve sürekli toplamaya teşvik eden, tatmin edici bir
 * "ritim" hissi vermek. Seri yalnızca GÖRSEL/SES geri bildirimidir; puan
 * hesabı tamamen sunucuya aittir (combo puanı ÜRETMEZ).
 */
const COMBO_WINDOW_MS = 2_200
/** Bu seri uzunluğuna ulaşınca "streak" fanfarı çalar (görsel vurgu). */
const COMBO_STREAK_AT = 5
/** Bir toplama olayında gösterilecek en fazla uçan puan rozeti. */
const SCORE_POP_MAX = 4
/** Uçan puan rozetinin ekranda kalma süresi (ms). */
export const SCORE_POP_MS = 900

type LoopDeps = {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
  /**
   * Yerel oyuncunun sunucu slotu (`'p1'`/`'p2'`). Yayınlanan `collect`/`steal`/
   * `score` olaylarında `by` alanına yazılır. Önceden `'p1'` sabit kodluydu;
   * misafir oyuncu (`p2`) kendi yayınını "rakipten geldi" sanıp kendi skorunu
   * rakip slotuna yazıyordu.
   */
  playerId: 'p1' | 'p2'
  /** Oyuncunun sunucu token'ı (RPC kimlik doğrulaması). */
  token: string | null
  /** Yerel oyuncunun pozisyonunu yayınlar. */
  publishMove: (x: number, y: number) => void
  /** Toplama/çalma olayını yayınlar. */
  broadcast: (event: string, payload: unknown) => void
  /** Sunucu RPC'si. */
  call: (fn: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Chaos bilgisini senkronize eder. */
  syncChaos: (input: { id?: string; endsAt?: number }) => void
  /** Faz ilerletme (sunucu). */
  advancePhase: (from: State['phase']) => Promise<void>
  /**
   * Rakibin en son broadcast edilen HEDEF konumu. Realtime `move` olayı buraya
   * yazar; döngü her karede bu hedefe yumuşakça yaklaşır. Böylece 60Hz paket
   * başına render tetiklenmez ve hareket akıcı kalır.
   */
  remotePos: React.RefObject<Map<string, { x: number; y: number; at: number }>>
}

const keys = { up: false, down: false, left: false, right: false }

/**
 * Sanal joystick vektörü (-1..1). Klavye ile aynı anda kullanılabilir;
 * ikisi toplanır ve normalize edilir. `useGameLoop` bu nesneyi dışarı verir,
 * `VirtualJoystick` `onChange` ile buraya yazar.
 */
export type JoystickVector = { x: number; y: number }

/**
 * Ana oyun döngüsü: girdi → hareket → toplama/çalma → faz geçişi.
 * Client iyimser çalışır; skor/kazanan sunucudan doğrulanır.
 */
export const useGameLoop = (deps: LoopDeps) => {
  const depsRef = useRef(deps)

  // Ref'i render sırasında değil, commit sonrası senkronize et.
  useEffect(() => {
    depsRef.current = deps
  }, [deps])

  const lastSend = useRef(0)
  const lastHeartbeat = useRef(0)
  const lastSteal = useRef(0)
  const lastPhase = useRef<State['phase']>('home')
  const lastRound = useRef<number>(-1)
  // Rakip için yumuşatılmış (interpolasyonlu) konum. Broadcast hedefi ile
  // bu değer arasında her karede yumuşak geçiş yapılır.
  const remoteTarget = useRef<{ x: number; y: number } | null>(null)
  // Rakibin son broadcast örneği (hız tahmini / dead-reckoning için).
  const remoteSample = useRef<{ x: number; y: number; at: number } | null>(null)
  // Rakibin tahmini hızı (arena %/s). Paketler arasında hedefi ileri taşır.
  const remoteVel = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  // Yerel oyuncunun ANLIK konumu. React render'ını beklemeden her karede
  // güncellenir; böylece `state` bir kare geride kalsa bile hareket akıcı kalır
  // ("donma + birden ilerleme" sorununun kökü buydu: döngü, commit edilmemiş
  // eski `state.players[0]`'dan hesapladığı için ilerleme kaybediyordu).
  const localPos = useRef<{ x: number; y: number } | null>(null)
  // Yerel oyuncunun EKRANA basılan konumu. `Battle` bu ref'i doğrudan DOM
  // transform'una yazar; böylece 60Hz hareket React render'ı TETİKLEMEZ.
  // Bu, "hareket donuyor / birden ilerliyor" sorununun asıl çözümüdür:
  // render döngüsü artık kare hızına bağlı değil.
  // NOT: Başlangıçta `null`. `Battle` bu değer `null` iken DOM'a YAZMAZ; aksi
  // halde ilk karede avatar (0,0) köşesine ışınlanıp sonra spawn'a zıplıyordu
  // ("ilk girdiğimizde garip hareket ediyoruz" şikâyeti). Değer, döngünün ilk
  // `step`'inde gerçek spawn konumundan tohumlanır.
  const livePos = useRef<{ x: number; y: number } | null>(null)
  // Rakibin ekrana basılan konumu. Aynı şekilde doğrudan DOM'a yazılır.
  const liveRivalPos = useRef<{ x: number; y: number } | null>(null)
  // Görev tamamlandığında kutlama katmanının görüneceği son zaman (epoch ms).
  // 0 = kutlama yok. Yalnızca görseldir; yeni görev ANINDA atanır.
  const objectiveHold = useRef(0)
  // Son görev tamamlanma anı (epoch ms). `Battle` bu değeri izleyerek küçük
  // kutlama animasyonunu (konfeti + "+25") tetikler.
  const celebrateRef = useRef(0)
  // ELMAS (JACKPOT) GERİ BİLDİRİMİ: yerel oyuncu elması topladığında konumunu
  // ve zamanını buraya yazarız. `Battle` bu değeri izleyerek elmasın üstünde
  // uçan "+50" rozetini gösterir. `null` = gösterilecek bir ödül yok.
  const diamondPopRef = useRef<{ x: number; y: number; at: number } | null>(null)
  // COMBO (ardışık toplama serisi): son toplama anı ve güncel seri uzunluğu.
  // `Battle` bu değeri izleyerek HUD'da "x3 COMBO" rozetini gösterir.
  const comboRef = useRef<{ count: number; at: number }>({ count: 0, at: 0 })
  // UÇAN PUAN ROZETLERİ: her toplamada coinin konumunda "+5/+15/+25/+50"
  // rozetleri belirir. `Battle` bu diziyi izleyip ekrana basar. Dizi kısa
  // tutulur (SCORE_POP_MAX) ki ekran kalabalıklaşmasın.
  const scorePopRef = useRef<Array<{ id: number; x: number; y: number; value: number; at: number }>>([])
  // EKRAN SARSINTISI (juice): çalma/çarpışma anında artan bir zaman damgası.
  // `Battle` değer değiştiğinde arena'ya kısa bir shake animasyonu uygular.
  const shakeRef = useRef<{ at: number; kind: 'steal' | 'bump' } | null>(null)
  // Sanal joystick vektörü. `VirtualJoystick` `setJoystick` ile buraya yazar;
  // böylece her pointer hareketinde React render tetiklenmez (yalnızca RAF okur).
  const joystick = useRef<JoystickVector>({ x: 0, y: 0 })
  // GÖREV KİMLİĞİ: sunucu bir görev tamamlanınca yeni bir görev atar ve
  // `collected_types`'ı SIFIRLAR. İstemci iyimser ilerlemeyi `me.objectiveProgress`
  // tabanından biriktirir; görev değiştiğinde taban hâlâ ESKİ görevin sayısını
  // taşır. Bu ref, görev `id`'si değiştiğinde iyimser tabanı sıfırlar.
  //
  // NOT (0033): Eskiden burada `countedCoinIdsRef` adlı KALICI bir Set vardı ve
  // coin id'lerini "bir kez sayıldı" diye işaretliyordu. Ancak coinler 3 sn
  // sonra AYNI id ile yeniden doğar; oyuncu aynı coini ikinci kez topladığında
  // istemci onu ATLIYOR, sunucu ise `collected_types`'ı YENİDEN artırıyordu.
  // Sonuç: istemci 2, sunucu 3 gösteriyordu ("3 topladım 2 gösteriyor").
  // Bu Set KALDIRILDI; iyimser ilerleme artık doğrudan sunucu sayaçlarından
  // (`collected_types` + bu karenin coinleri) türetilir ve respawn sonrası
  // yeniden toplanan coin de SAYILIR — istemci/sunucu birebir uyuşur.
  const objectiveIdRef = useRef<string | null>(null)

  /**
   * Joystick vektörünü günceller. Ref'i doğrudan dışarı vermek yerine bir
   * setter sunarız; bu, `react-hooks/immutability` kuralına uyar ve çağıran
   * tarafın hook dönüşünü mutasyona uğratmasını engeller.
   */
  const setJoystick = useCallback((x: number, y: number) => {
    joystick.current.x = x
    joystick.current.y = y
  }, [])

  /**
   * OTORİTE DURUM UYGULAYICI (0035).
   *
   * `duo_collect` / `duo_steal` yanıtındaki `state` alanını yerel oyuncuya
   * (index 0) AYNEN uygular. Bu, görev ilerlemesi için TEK OTORİTE KAYNAĞIDIR:
   * istemci artık ilerlemeyi kendi üretmez; sunucunun onayladığı değeri
   * (görev tamamlanması + yeni görev ataması dahil) ANINDA yansıtır.
   *
   * Böylece:
   *   * "3 topladım 2 gösteriyor" → sunucu 3 diyorsa 3 gösterilir.
   *   * "3 gösterip sonra 1'e düşme" → istemci sunucuyu geçemez; `Math.max`
   *     kilitlenmesi olmaz.
   *   * "yeni görev uzun süre gelmiyor" → yeni görev, yoklamayı beklemeden
   *     RPC yanıtıyla ANINDA gelir.
   */
  const applyServerState = useCallback((response: unknown) => {
    const res = response as
      | {
          ok?: boolean
          state?: {
            objective?: Player['objective']
            objectiveProgress?: number
            collectedTypes?: Player['collectedTypes']
            coins?: number
            stolen?: number
            roundCoins?: number
            roundStolen?: number
            missionDone?: boolean
            objectivesDone?: number
            score?: number
            roundScore?: number
          }
        }
      | null
    if (!res || res.ok !== true || !res.state) return
    const s = res.state
    depsRef.current.setState((prev) => {
      const players = prev.players.map((player, index) => {
        if (index !== 0) return player
        // GÖREV: sunucu yeni görev atadıysa (reroll) burada ANINDA gelir.
        const nextObjective = s.objective ?? player.objective
        const objectiveChanged = (nextObjective?.id ?? null) !== (player.objective?.id ?? null)
        // MONOTONİKLİK (KÖK SORUN DÜZELTMESİ): `objectiveProgress`'e birden çok
        // yazar var (bu taze RPC yanıtı + `duo_public_state` yoklaması). Gecikmiş
        // bir RPC yanıtı (ör. daha eski bir collect) yeni değeri EZMEMELİ.
        // Görev kimliği DEĞİŞMEDİĞİ sürece ilerleme asla düşmez; yalnızca artar.
        // Tek meşru sıfırlama görev değişimindedir (sunucu yeni görev atar).
        const serverProgress =
          typeof s.objectiveProgress === 'number' && Number.isFinite(s.objectiveProgress)
            ? s.objectiveProgress
            : undefined
        const localProgress =
          typeof player.objectiveProgress === 'number' && Number.isFinite(player.objectiveProgress)
            ? player.objectiveProgress
            : 0
        const objectiveProgress = objectiveChanged
          ? (serverProgress ?? 0)
          : serverProgress === undefined
            ? localProgress
            : Math.max(localProgress, serverProgress)
        // SKOR MONOTONİKLİĞİ (KÖK SORUN DÜZELTMESİ: "1080 → 1030").
        //
        // Gecikmiş bir RPC yanıtı (ör. daha eski bir collect) YENİ skoru
        // EZMEMELİ. Skor, maç boyunca MONOTONİKTİR; yalnızca ARTABİLİR. Tek
        // meşru sıfırlama yeni maçtadır (`resetMatch`/`blankPlayer`), bu yol
        // değil. Bu yüzden `Math.max` uygularız.
        const serverScore =
          typeof s.score === 'number' && Number.isFinite(s.score) ? s.score : undefined
        const serverRoundScore =
          typeof s.roundScore === 'number' && Number.isFinite(s.roundScore)
            ? s.roundScore
            : undefined
        return {
          ...player,
          objective: nextObjective,
          objectiveProgress,
          collectedTypes: s.collectedTypes ?? player.collectedTypes,
          coins: s.coins ?? player.coins,
          stolen: s.stolen ?? player.stolen,
          roundCoins: s.roundCoins ?? player.roundCoins,
          roundStolen: s.roundStolen ?? player.roundStolen,
          missionDone: s.missionDone ?? player.missionDone,
          objectivesDone: s.objectivesDone ?? player.objectivesDone,
          score: serverScore === undefined ? player.score : Math.max(player.score ?? 0, serverScore),
          roundScore:
            serverRoundScore === undefined
              ? player.roundScore
              : Math.max(player.roundScore ?? 0, serverRoundScore),
        }
      })
      return { ...prev, players }
    })
  }, [])

  // Klavye girdisi.
  useEffect(() => {
    // Klavye kısayolları yalnızca oyun alanında geçerli olmalı. Bir metin
    // alanına (ör. oda kodu girişi) yazarken `w/a/s/d` tuşlarını yutmamalıyız;
    // aksi halde kullanıcı kod içine `S` gibi harfleri giremez.
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      )
    }
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'w' || key === 'arrowup') keys.up = true
      else if (key === 's' || key === 'arrowdown') keys.down = true
      else if (key === 'a' || key === 'arrowleft') keys.left = true
      else if (key === 'd' || key === 'arrowright') keys.right = true
      else return
      event.preventDefault()
    }
    const up = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'w' || key === 'arrowup') keys.up = false
      else if (key === 's' || key === 'arrowdown') keys.down = false
      else if (key === 'a' || key === 'arrowleft') keys.left = false
      else if (key === 'd' || key === 'arrowright') keys.right = false
    }
    const blur = () => {
      keys.up = keys.down = keys.left = keys.right = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const step = useCallback((now: number, dt: number) => {
    const {
      state,
      setState,
      token,
      playerId,
      publishMove,
      broadcast,
      call,
      syncChaos,
      advancePhase,
      remotePos,
    } = depsRef.current

    // Faz geçişleri.
    if (state.phase === 'countdown' && state.countdownEndsAt > 0 && now >= state.countdownEndsAt) {
      playSound('start')
      setState((prev) => ({ ...prev, phase: 'battle', endsAt: now + BATTLE_MS }))
      // Sunucuya da bildir. `advancePhase` hata durumunda yeniden dener; böylece
      // saat farkından dolayı erken tetiklenip `not_ready` alsak bile sunucu
      // fazı eninde sonunda `battle`'a geçer.
      void advancePhase('countdown')
      return
    }
    if (state.phase === 'battle' && state.endsAt > 0 && now >= state.endsAt) {
      void advancePhase('battle')
      return
    }

    if (state.phase !== 'battle') {
      // Savaş dışındayken yerel konum ref'ini bırak; yeni turda `state`'ten
      // yeniden tohumlanır (oyuncu doğru başlangıç noktasına döner).
      localPos.current = null
      return
    }

    // YEREL STATE SIRASI: `state.players[0]` HER ZAMAN "ben", `[1]` HER ZAMAN
    // "rakip"tir (bkz. `useGameState`/`mapPlayerId`). `player.id` sunucu slotu
    // DEĞİL, yerel slottur (`'p1'` = ben, `'p2'` = rakip). Bu yüzden index
    // tabanlı erişim doğrudur ve iki istemcide de tutarlıdır.
    const me = state.players[0]
    if (!me) return

    // Yeni tur: konum ref'ini ve görev bekleme sayacını sıfırla.
    //
    // KÖK SORUN ("bazen beni başlangıç konumuma ışınlıyor sonra tekrar yerime
    // getiriyor"): `state.round` SAVAŞ SIRASINDA geçici olarak yanlış
    // ayarlanabiliyordu. Savaş yoklaması her turda `round: data.round ?? prev.round`
    // yazar; sunucu bir anlığına bayat/yanlış bir tur döndürürse yerel tur
    // değişir. Bu blok da konumu `me.x/me.y`'den (SPAWN) yeniden tohumlar →
    // oyuncu spawn'a ışınlanır, sonraki `duo_move` heartbeat'i spawn'ı sunucuya
    // gönderir (rakip de ışınlanmayı görür), yoklama turu düzeltince oyuncu geri
    // döner. Yani "ışınla → geri gel" tam olarak buradan çıkıyordu.
    //
    // ÇÖZÜM: Yeniden tohumlamayı YALNIZCA tur İLERİ gittiğinde (gerçek yeni tur)
    // yaparız. Tur GERİ gelirse (bayat snapshot düzeltmesi) konumu KORURUZ;
    // yalnızca `lastRound` işaretçisini güncelleriz. Böylece geçici bir yanlış
    // tur oyuncuyu spawn'a ışınlamaz.
    //
    // NOT: Bu noktada `state.phase` zaten `'battle'`'dır (yukarıdaki erken
    // `return`), bu yüzden `countdown` kontrolü gereksizdir.
    if (lastRound.current !== state.round) {
      const roundAdvanced = state.round > lastRound.current
      lastRound.current = state.round
      if (roundAdvanced) {
        localPos.current = { x: me.x, y: me.y }
        // Ekrana basılacak konumu da spawn'dan tohumla (ilk karede (0,0)
        // görünmesini engeller).
        livePos.current = { x: me.x, y: me.y }
        objectiveHold.current = 0
        // Rakip interpolasyon durumunu sıfırla: yeni turda eski hız/örnek
        // kalırsa rakip yanlış yöne "sürüklenir" (dead-reckoning artığı).
        remoteTarget.current = null
        remoteSample.current = null
        remoteVel.current = { x: 0, y: 0 }
        // Yeni turda combo serisini ve uçan puan rozetlerini sıfırla.
        comboRef.current = { count: 0, at: 0 }
        scorePopRef.current = []
      }
      // Tur geri geldiyse (bayat snapshot düzeltmesi): konumu KORU.
    }

    // --- Girdi: klavye + sanal joystick birleşir. ---
    let dx = 0
    let dy = 0
    if (keys.up) dy -= 1
    if (keys.down) dy += 1
    if (keys.left) dx -= 1
    if (keys.right) dx += 1
    dx += joystick.current.x
    dy += joystick.current.y

    // AYNALAMA YOK: Girdi ve hareket aynı (ekran = dünya) koordinat
    // uzayındadır. Ekranda sağa gitmek gerçek `x`'i artırır; render da
    // doğrudan `x`'i kullanır. Böylece joystick/klavye yönü her zaman doğal.

    // --- Hareket (yerel, iyimser). ---
    //
    // Konumu `state`'ten değil, `localPos` ref'inden okuruz. `state` yalnızca
    // React commit edildikten sonra güncellenir; döngü 60Hz çalıştığı için
    // aradaki karelerde eski konumdan hesaplamak ilerleme kaybettirir ve
    // "donma + birden ilerleme" yaratır. `localPos` her karede anında güncellenir.
    if (!localPos.current) localPos.current = { x: me.x, y: me.y }
    const fromX = localPos.current.x
    const fromY = localPos.current.y
    let nextX = fromX
    let nextY = fromY
    const moving = Math.hypot(dx, dy) > 0.01
    if (moving) {
      const length = Math.hypot(dx, dy) || 1
      const slowed = (me.slowedUntil ?? 0) > now
      const speed = MOVE_SPEED * (slowed ? BUMP_SPEED_MULTIPLIER : 1)
      const targetX = fromX + (dx / length) * speed * dt
      const targetY = fromY + (dy / length) * speed * dt
      const resolved = resolveMove(fromX, fromY, targetX, targetY)
      nextX = resolved.x
      nextY = resolved.y
    }
    // Ref'i hemen güncelle — bir sonraki kare bu değerden devam eder.
    localPos.current = { x: nextX, y: nextY }
    // Ekrana basılacak konumu da her karede güncelle. `Battle` bunu doğrudan
    // DOM'a yazar; React render'ı beklemez → akıcı hareket.
    livePos.current = { x: nextX, y: nextY }

    // --- Rakip interpolasyonu (profesyonel, kare hızından bağımsız). ---
    //
    // Hedef önceliği: taze broadcast konumu (`remotePos`) > sunucu snapshot'ı
    // (`state.players[1]`). Broadcast 60Hz geldiği için asıl akıcılık kaynağı
    // odur; snapshot yalnızca broadcast kesildiğinde (yeniden bağlanma) devreye
    // girer.
    //
    // NEDEN ESKİ YÖNTEM LAGLIYDI:
    //   1. `remote.x += (goalX - remote.x) * 0.35` SABİT bir katsayı kullanıyordu;
    //      kare hızı düşünce (mobil, arka plan sekmesi) yakınsama yavaşlıyor,
    //      yükselince titriyordu. Kare hızından BAĞIMSIZ olmalı.
    //   2. Hız (velocity) extrapolasyonu yoktu: rakip hep hedefin GERİSİNDE
    //      kalıyordu (smoothing gecikmesi). Bu da "rakip laglı hareket ediyor"
    //      hissinin ana kaynağıydı.
    //
    // ÇÖZÜM:
    //   - Üstel yumuşatma katsayısını `dt` ile ölçekleriz:
    //     `alpha = 1 - exp(-k * dt)` → her kare hızında AYNI yakınsama süresi.
    //   - Son iki broadcast örneğinden hızı tahmin edip hedefi ileri taşırız
    //     (dead-reckoning). Böylece rakip, paketler arasında da akıcı ilerler.
    const rivalTarget = state.players[1]
    if (rivalTarget) {
      // ÖNEMLİ: `move` broadcast'i gönderenin SLOTU ile anahtarlanır (`p1`/`p2`).
      // Yerel oyuncu `p2` olduğunda rakip `p1`'dir; eski kod yalnızca `'rival'`
      // veya `'p2'` aradığı için `p1` anahtarını ASLA bulamıyordu → "rakip
      // hareketi bende hiç görünmüyor" hatası. Artık rakibin GERÇEK slotuyla
      // ararız; `'rival'` anahtarı yalnızca geriye dönük uyumluluk içindir.
      const rivalSlot = rivalTarget.id
      // DİKKAT: Bu değişken adı `broadcast` OLAMAZ — `step` başındaki
      // `broadcast` FONKSİYONUNU gölgeler ve aşağıdaki `broadcast('collect')`
      // çağrılarını bozar. Bu yüzden `rivalBroadcast` adını kullanırız.
      const rivalBroadcast =
        remotePos.current?.get(rivalSlot) ??
        remotePos.current?.get('rival') ??
        remotePos.current?.get(rivalSlot === 'p1' ? 'p2' : 'p1')
      const fresh = rivalBroadcast && now - rivalBroadcast.at < REMOTE_POS_TTL
      // HEDEF SEÇİMİ — İKİ KADEMELİ (KÖK SORUNLAR: "rakip donuyor" VE "rakip
      // ışınlanıyor"):
      //
      //  1. TAZE broadcast (≤ REMOTE_POS_TTL): hedef = broadcast konumu. Akıcı.
      //  2. KISA kopma (REMOTE_POS_TTL < yaş ≤ REMOTE_HARD_TTL_MS): hedef = SON
      //     BİLİNEN broadcast konumu. Rakip kısa süre durur ama IŞINLANMAZ.
      //     (Sunucu snapshot'ı ~1 sn gecikmeli olduğu için burada ona düşmek
      //     rakibi geriye çekip ileri-geri zıplatıyordu.)
      //  3. UZUN kopma (> REMOTE_HARD_TTL_MS): hedef = sunucu snapshot'ı. Gerçek
      //     kopma/yeniden bağlanma; sunucunun son bildiği konuma yumuşakça oturur.
      //
      // NOT: Bayat veriyle dead-reckoning YAPMAYIZ (aşağıda `vel` `fresh`'e bağlı).
      const broadcastAge = rivalBroadcast ? now - rivalBroadcast.at : Infinity
      const hardStale = broadcastAge > REMOTE_HARD_TTL_MS
      const goalX = rivalBroadcast && !hardStale ? rivalBroadcast.x : rivalTarget.x
      const goalY = rivalBroadcast && !hardStale ? rivalBroadcast.y : rivalTarget.y
      const remote = remoteTarget.current
      if (!remote) {
        remoteTarget.current = { x: goalX, y: goalY }
      } else {
        // --- Hız tahmini (dead-reckoning) ---
        // Yeni bir broadcast örneği geldiyse hızı güncelle; aksi halde son
        // bilinen hızı koru (paket gecikmesinde de akıcı kalsın).
        const prevSample = remoteSample.current
        if (fresh && rivalBroadcast && (!prevSample || rivalBroadcast.at !== prevSample.at)) {
          const dtSample = prevSample
            ? Math.max(1, rivalBroadcast.at - prevSample.at) / 1000
            : 0
          if (prevSample && dtSample > 0) {
            // Ani ışınlanmalarda (respawn) sahte hız üretmemek için sınırla.
            const rawVx = (rivalBroadcast.x - prevSample.x) / dtSample
            const rawVy = (rivalBroadcast.y - prevSample.y) / dtSample
            const speed = Math.hypot(rawVx, rawVy)
            const maxSpeed = MOVE_SPEED * 1.6
            const scale = speed > maxSpeed ? maxSpeed / speed : 1
            remoteVel.current = { x: rawVx * scale, y: rawVy * scale }
          }
          remoteSample.current = { x: rivalBroadcast.x, y: rivalBroadcast.y, at: rivalBroadcast.at }
        }
        // Hedefi hız ile ileri taşı (yalnızca taze veri varken).
        const vel = fresh ? remoteVel.current : { x: 0, y: 0 }
        const leadX = goalX + vel.x * dt
        const leadY = goalY + vel.y * dt
        const dist = Math.hypot(remote.x - leadX, remote.y - leadY)
        // KÖK SORUN ("bazen rakip bir başka konuma ışınlanıyor"):
        // Eskiden `dist > REMOTE_SNAP_DISTANCE && !fresh` iken rakibi ANINDA
        // hedefe zıplatıyorduk. Bu, "gerçek respawn/yeniden bağlanma" için
        // düşünülmüştü; ancak artık bayat broadcast'te hedef SUNUCU snapshot'ına
        // düştüğü için (bkz. yukarıdaki HEDEF SEÇİMİ), sunucu konumu bir an
        // geride kaldığında bu dal NORMAL HAREKET sırasında tetikleniyor ve
        // rakibi ileri-geri IŞINLIYORDU. Sunucu snapshot'ı ~1 sn gecikmeli
        // olduğundan fark kolayca 18 birimi aşıyordu.
        //
        // ÇÖZÜM: Ani zıplamayı TAMAMEN kaldırırız; her zaman yumuşak yaklaşırız.
        // Gerçek respawn/yeni tur zaten `remoteTarget.current = null` ile
        // sıfırlanır (aşağıdaki tur değişimi bloğu) ve bir sonraki kare hedefi
        // doğrudan tohumlar — yani ışınlanma orada, doğru yerde olur. Burada
        // yumuşatma (`REMOTE_SMOOTHING_K = 12`) büyük düzeltmeleri bile ~250 ms'de
        // sindirir; kullanıcı zıplama değil hızlı bir kayma görür.
        if (dist > REMOTE_SETTLE) {
          // Kare hızından bağımsız üstel yumuşatma.
          const alpha = 1 - Math.exp(-REMOTE_SMOOTHING_K * dt)
          remote.x += (leadX - remote.x) * alpha
          remote.y += (leadY - remote.y) * alpha
        } else if (dist > 0) {
          // Hedefe çok yakın: otur.
          remote.x = leadX
          remote.y = leadY
        }
      }
      // Rakip konumunu da doğrudan DOM'a yazarız (state'e değil) — böylece
      // rakip hareketi de 60Hz render tetiklemez.
      const settled = remoteTarget.current
      if (settled) {
        liveRivalPos.current = { x: settled.x, y: settled.y }
      }
    }

    // --- Toplama (ZAMAN KAPISI YOK — KÖK SORUN DÜZELTMESİ). ---
    // Puan hesabı YOK: yalnızca hangi coinlerin toplandığını belirler ve
    // sunucuya bildiririz. Değer/çeşitlilik sunucuda (`duo_collect`) işlenir.
    //
    // KÖK SORUN ("Collect 2 Red → 1/2"): Burada eskiden `now - lastAction >=
    // ACTION_MS` (90 ms) GLOBAL bir zaman kapısı vardı. İki geçerli toplama
    // FARKLI karelerde ama 90 ms içinde gerçekleştiğinde (ör. iki kırmızı coin
    // neredeyse aynı anda), ikinci karenin `collectedIds`'i ZORLA boş kalıyordu:
    // coin ne "toplandı" olarak işaretleniyor ne de sunucuya gönderiliyordu →
    // geçerli bir toplama KAYBOLUYORDU ve görev 1/2'de takılıyordu.
    //
    // Kapı GEREKSİZDİ: aynı coini her karede yeniden toplamayı zaten
    // `!coin.collectedBy` filtresi (aşağıda) ve `collectedSet` işaretlemesi
    // engeller. Kapı yalnızca GEÇERLİ toplamaları düşürüyordu. Bu yüzden
    // kaldırıldı: HER kare yakındaki toplanmamış coinleri değerlendirir.
    // Sunucu eşzamanlı toplamaları atomik serileştirir (0039), bu yüzden aynı
    // karede birden fazla coin göndermek güvenlidir.
    let collectedIds: number[] = []
    let collectedDiamond = false
    {
      const nearby = state.coins.filter(
        (coin) => !coin.collectedBy && Math.hypot(coin.x - nextX, coin.y - nextY) <= COLLECT_RADIUS,
      )
      if (nearby.length > 0) {
        collectedIds = nearby.map((coin) => coin.id)
        // ELMAS (JACKPOT) GERİ BİLDİRİMİ: elmas tek seferlik ve 50 puanlık
        // olduğundan normal "collect" sesinden AYRI, daha tatmin edici bir ses
        // çalarız. Böylece oyuncu büyük ödülü aldığını net hisseder.
        const diamondCoin = nearby.find((coin) => coin.type === 'diamond')
        collectedDiamond = Boolean(diamondCoin)
        // COMBO: iki toplama arası COMBO_WINDOW_MS'den kısaysa seri artar.
        // Seri yalnızca geri bildirimdir; puanı sunucu verir.
        const prevCombo = comboRef.current
        const comboCount = now - prevCombo.at <= COMBO_WINDOW_MS ? prevCombo.count + 1 : 1
        comboRef.current = { count: comboCount, at: now }
        // SES: elmas > combo/streak > normal toplama önceliğiyle çal.
        if (collectedDiamond) {
          playSound('jackpot')
        } else if (comboCount >= COMBO_STREAK_AT) {
          playSound('streak')
        } else if (comboCount >= 2) {
          playSound('combo')
        } else {
          playSound('collect')
        }
        // "+50" rozeti için elmasın konumunu ve anını kaydet. `Battle` bu
        // değeri izleyerek elmasın üstünde uçan rozeti gösterir.
        if (diamondCoin) {
          diamondPopRef.current = { x: diamondCoin.x, y: diamondCoin.y, at: now }
        }
        // UÇAN PUAN ROZETLERİ: her toplanan coin için değerini hesapla ve
        // coinin konumunda kısa süreliğine göster. Ekran kalabalıklaşmasın diye
        // en fazla SCORE_POP_MAX rozet tutarız (en yeniler öne gelir).
        const pops = nearby.slice(0, SCORE_POP_MAX).map((coin, index) => ({
          id: now + index,
          x: coin.x,
          y: coin.y,
          value: getCoinValue(coin.type, state.chaosEvent?.id, me.objective),
          at: now,
        }))
        scorePopRef.current = [...scorePopRef.current, ...pops].slice(-SCORE_POP_MAX)
      }
    }
    const collectedSet = new Set(collectedIds)

    // --- Çalma (zaman kapılı). ---
    //
    // KÖK SORUN ("steal çalışmıyor"): Menzil kontrolü `rivalTarget.x/y` (state)
    // üzerinden yapılıyordu. Ancak rakibin state konumu döngü boyunca
    // GÜNCELLENMEZ (yalnızca tur başında spawn'da doğrudur); canlı konum
    // `liveRivalPos.current` ref'inde tutulur ve doğrudan DOM'a yazılır. Bu
    // yüzden mesafe BAYAT konuma göre hesaplanıyor ve oyuncu rakibin üstünde
    // dursa bile `STEAL_RADIUS` içinde görünmüyordu → çalma neredeyse hiç
    // tetiklenmiyordu. Artık CANLI konumu (`liveRivalPos`) esas alırız; ref
    // henüz tohumlanmadıysa (ilk kare) state konumuna düşeriz.
    let stealing = false
    const rivalPos = liveRivalPos.current ?? rivalTarget
    if (
      rivalPos &&
      now - lastSteal.current >= STEAL_COOLDOWN_MS &&
      Math.hypot(rivalPos.x - nextX, rivalPos.y - nextY) <= STEAL_RADIUS
    ) {
      lastSteal.current = now
      stealing = true
      playSound('steal')
      // EKRAN SARSINTISI: çalma anında arena'ya kısa bir "vuruş" sarsıntısı
      // uygularız. `Battle` bu zaman damgasını izleyip CSS sınıfını tetikler.
      shakeRef.current = { at: now, kind: 'steal' }
    }

    // --- Tek `setState`: hareket + rakip + toplama + çalma + yeniden doğma. ---
    // Kare başına tek render hedefi; bu, hareketin akıcı kalmasını sağlar.
    //
    // ÖNEMLİ (SAFLIK): `setState` güncelleyicisi SAF olmalıdır. React onu
    // StrictMode'da (geliştirme) veya eşzamanlı render'da BİRDEN FAZLA kez
    // çağırabilir. Önceden skor bu güncelleyicinin İÇİNDE biriktiriliyor ve
    // `objectiveHold`/`celebrateRef`/`playSound('win')` gibi YAN ETKİLER de
    // burada tetikleniyordu. Sonuç: skor yayını iki katına çıkıyor, kutlama ve
    // "win" sesi mükerrer çalıyordu. Artık tüm kararları ve yan etkileri
    // güncelleyicinin DIŞINDA, mevcut `state` üzerinden hesaplıyoruz; güncelleyici
    // yalnızca saf bir dönüşüm yapar. SKOR ise tamamen sunucuya aittir.
    // ========================================================================
    // GÖREV İLERLEMESİ — TEK OTORİTE KAYNAĞI (0035).
    //
    // KÖK SORUN (önceki sürümler): İstemci HER KAREDE ilerlemeyi
    // `me.collectedTypes` (yalnızca ~1 sn'lik yoklamayla güncellenir) + bu
    // karenin coinlerinden YENİDEN İNŞA ediyor ve `state.players[0]
    // .objectiveProgress`'e yazıyordu. Ardından `mergeProgress`
    // (`lib/useDuoChaos.ts`) `Math.max(yerel, sunucu)` uyguluyordu. İstemcinin
    // BAYAT tabandan türeyen yeniden inşası YANLIŞ (fazla yüksek) değer
    // üretebiliyordu; `Math.max` bu yanlış değeri KALICI olarak kilitliyordu
    // (asla düşmediği için) → "3 gösterip sonra 1'e düşme" ve "3 topladım 2
    // gösteriyor" hataları.
    //
    // ÇÖZÜM: İstemci artık ilerlemeyi KAREDE ÜRETMEZ. İlerleme YALNIZCA
    // sunucudan gelir:
    //   * `duo_collect`/`duo_steal` yanıtındaki `state.objectiveProgress`
    //     (eylem sonrası ANLIK otorite — aşağıda uygulanır), ve
    //   * `duo_public_state` yoklaması (yakınsama/yedek).
    // Böylece istemci sunucuyu ASLA geçemez; `Math.max` kilitlenmesi ortadan
    // kalkar ve ilerleme deterministik olur.
    //
    // Burada yalnızca GÖREV KİMLİĞİNİ izleriz: sunucu yeni görev atadığında
    // (`objective.id` değiştiğinde) yerel kutlama durumunu temizleriz. İlerleme
    // DEĞERİNE dokunmayız — o sunucunun tekelindedir.
    const objectiveId = me.objective?.id ?? null
    const objectiveIdChanged = objectiveIdRef.current !== objectiveId
    if (objectiveIdChanged) {
      objectiveIdRef.current = objectiveId
    }

    const objective = me.objective
    const collectedCount = collectedIds.length

    // Bu karenin toplanan coinlerinin TÜRLERİ — yalnızca YEREL görsel geri
    // bildirim (uçan rozet, combo) ve `collectedTypes` iyimser toplamı için.
    // İLERLEME HESABINDA KULLANILMAZ (o sunucuya aittir).
    const freshCoins = state.coins.filter((coin) => collectedSet.has(coin.id))
    const freshTypes = freshCoins.reduce<Partial<Record<Coin['type'], number>>>(
      (counts, coin) => ({ ...counts, [coin.type]: (counts[coin.type] ?? 0) + 1 }),
      {},
    )

    // Görev tamamlanma kararı: YALNIZCA sunucunun onayladığı ilerleme hedefi
    // karşılıyorsa tamamlanmış sayılır. İstemci iyimser ilerleme ÜRETMEDİĞİ
    // için bu karar da sunucu değerine dayanır. `!me.missionDone` guard'ı şart:
    // görev tamamlandıktan sonra ilerleme yeni görev verilene kadar hedefi
    // karşılamaya devam eder; guard olmadan her karede tekrar tetiklenir.
    const objectiveDone = !me.missionDone && objectiveSatisfied(me)

    // SKOR ARTIK SUNUCUDA HESAPLANIR. İstemci yalnızca toplama/çalma olayını
    // sunucuya bildirir (`duo_collect` / `duo_steal`); puanı `duo_tick` +
    // `duo_public_state` yoklaması belirler. Burada yerel skor ÜRETMEYİZ ve
    // rakibe skor YAYINLAMAYIZ — aksi halde sunucu ile istemci çift sayar.

    // Yan etkiler (ses/kutlama) güncelleyicinin DIŞINDA, tam olarak bir kez.
    if (objectiveDone) {
      objectiveHold.current = now + OBJECTIVE_CELEBRATE_MS
      celebrateRef.current = now
      playSound('win')
    }

    setState((prev) => {
      let changed = false

      // Coinler: toplananları işaretle, süresi dolanları AYNI konum ve AYNI
      // renkte canlandır. Renk yuvaya (id'ye) bağlıdır; yalnızca yeni turda
      // yeniden dağıtılır. Böylece coinler "kendi kendine renk değiştirmez".
      //
      // ÖNEMLİ (ELMAS / JACKPOT): Elmas TEK SEFERLİK bir ödüldür. Sunucu
      // (`duo_respawn_coins`) elmasları ASLA canlandırmaz (`type <> 'diamond'`).
      // İstemci eskiden TÜR AYRIMI YAPMADAN `respawnAt` dolan her coini
      // canlandırıyordu; bu yüzden elmas toplandıktan 3 sn sonra YENİDEN
      // beliriyordu ("elması alsam bile hemen tekrar çıkıyor" hatası). Elması
      // bu mantığın DIŞINDA tutarız: toplandıysa kalıcı olarak toplanmış kalır.
      const nextCoins = prev.coins.map((coin) => {
        if (collectedSet.has(coin.id)) {
          changed = true
          if (coin.type === 'diamond') {
            // Tek seferlik: respawn planlama, kalıcı olarak toplanmış işaretle.
            return { ...coin, collectedBy: 'p1' as const, respawnAt: undefined }
          }
          return { ...coin, collectedBy: 'p1' as const, respawnAt: now + COIN_RESPAWN_MS }
        }
        if (
          coin.type !== 'diamond' &&
          coin.collectedBy &&
          coin.respawnAt &&
          now >= coin.respawnAt
        ) {
          changed = true
          // Konum VE renk sabit kalır — yalnızca "toplanmış" işareti kalkar.
          return { ...coin, collectedBy: undefined, respawnAt: undefined }
        }
        return coin
      })

      const nextPlayers = prev.players.map((player, index) => {
        // Yerel state'te index 0 = "ben", index 1 = "rakip" (iki istemcide de).
        if (index === 0) {
          let next = player
          // NOT: Yerel oyuncunun x/y'sini burada state'e YAZMAYIZ. Konum her
          // karede `livePos` ref'i üzerinden doğrudan DOM'a uygulanır; state'e
          // yazmak 60Hz render tetikler ve hareketi bozar. State'teki x/y
          // yalnızca tur başında (spawn) doğru olması yeterlidir.
          // Yerel görsel geri bildirim: toplanan coin sayısı ANINDA güncellenir
          // (uçan rozet, combo, HUD sayacı). SKOR'a ve GÖREV İLERLEMESİNE
          // DOKUNMAYIZ — ikisi de sunucunun tekelindedir (0035). İlerleme,
          // `duo_collect`/`duo_steal` yanıtındaki otorite durumdan uygulanır.
          if (collectedIds.length > 0) {
            changed = true
            next = {
              ...next,
              coins: next.coins + collectedIds.length,
              // TUR TOPLAMI: sonuç ekranı `roundCoins` okur; sunucu yoklaması
              // gelene kadar iyimser artırırız (sunucu değeri yine otoritedir).
              roundCoins: (next.roundCoins ?? 0) + collectedIds.length,
              // TOPLAM TÜRLER: yalnızca YEREL görsel türetim için (rakip HUD'u
              // `collectedTypes`'tan ilerleme gösterir). Sunucu yanıtı/yoklaması
              // geldiğinde otorite değerle ezilir.
              collectedTypes: {
                ...(next.collectedTypes ?? {}),
                ...Object.fromEntries(
                  Object.entries(freshTypes).map(([type, count]) => [
                    type,
                    (next.collectedTypes?.[type as Coin['type']] ?? 0) + (count ?? 0),
                  ]),
                ),
              },
            }
          }
          if (stealing) {
            changed = true
            next = {
              ...next,
              stolen: next.stolen + 1,
              // TUR TOPLAMI: sonuç ekranı `roundStolen` okur; iyimser artır.
              roundStolen: (next.roundStolen ?? 0) + 1,
            }
          }
          // Görev tamamlandıysa: yalnızca YEREL kutlama durumunu işaretle.
          //
          // ÖNEMLİ (SUNUCU OTORİTESİ): Yeni görevi BURADA ATAMAYIZ. Görev
          // zinciri sunucuya aittir (`duo_reroll_objective` → `duo_random_objective`).
          // İstemci `randomObjective()` ile yerel rastgele bir görev seçerse
          // sunucunun seçtiğinden FARKLI bir görev üretir; iki istemci ve sunucu
          // farklı görevler görür ("görevler uyuşmuyor" hatası). Yeni görev,
          // bir sonraki `duo_public_state` yoklamasında sunucudan gelir ve
          // yukarıdaki birleştirme (`{ ...player, ...server }`) ile uygulanır.
          //
          // Burada yalnızca `missionDone` bayrağını kaldırırız ki kutlama bir
          // kez gösterilsin; `coins`/`stolen`/`collectedTypes` sunucudan
          // tazelenene kadar korunur (sunucu görev değişiminde bunları sıfırlar).
          if (objectiveDone) {
            changed = true
            next = {
              ...next,
              missionDone: true,
            }
          }
          return next
        }

        if (index === 1) {
          let next = player
          // NOT: Rakibin x/y'sini de state'e YAZMAYIZ; konum `liveRivalPos`
          // üzerinden doğrudan DOM'a uygulanır. State'teki x/y yalnızca tur
          // başında (spawn) doğru olması yeterlidir.
          if (stealing) {
            changed = true
            next = { ...next, coins: Math.max(0, next.coins - 1), slowedUntil: now + BUMP_SLOW_MS }
          }
          return next
        }
        return player
      })

      if (!changed) return prev
      return { ...prev, coins: nextCoins, players: nextPlayers }
    })

    // Ağ yayınları (state dışı yan etkiler).
    //
    // HAREKET: 60Hz'de konum yayınla (rakip akıcı görünsün).
    // HEARTBEAT: Oyuncu HAREKETSİZ dursa bile periyodik olarak konum yayınla.
    //   Neden: `move` yayını aynı zamanda bir CANLILIK sinyalidir. Yalnızca
    //   hareket ederken yayın yaparsak, hareketsiz duran (ve coin toplamayan)
    //   bir oyuncudan rakibe HİÇ sinyal gitmez → rakibin `rivalAliveAt`'i
    //   bayatlar ve yanlış "rakip ayrıldı" popup'ı çıkar. Ayrıca seyrek de olsa
    //   konum tazelemesi, paket kaybı sonrası rakibin konumunun yakınsamasını
    //   sağlar (lag telafisi).
    const heartbeatDue = now - lastHeartbeat.current >= MOVE_HEARTBEAT_MS
    if ((moving && now - lastSend.current >= MOVE_SEND_MS) || heartbeatDue) {
      lastSend.current = now
      if (heartbeatDue) lastHeartbeat.current = now
      publishMove(nextX, nextY)
    }
    // KONUM TAZELEME (KRİTİK): Sunucu `duo_collect`/`duo_steal` menzilini
    // KENDİ sakladığı `x/y` ile doğrular. İstemci `duo_move`'u yalnızca
    // HAREKET ederken gönderir; oyuncu bir coinin üstünde DURURSA sunucudaki
    // konum bayatlar ve toplama `too_far` ile REDDEDİLİR → istemci skoru artar
    // ama sunucu skoru artmaz ("puanlar tutmuyor"). Bu yüzden toplama/çalma
    // öncesinde konumu MUTLAKA tazeleriz.
    //
    // KÖK SORUN ("Collect 2 Red → 1/2" — EŞZAMANLI TOPLAMA YARIŞI):
    //   Buradaki `duo_move` eskiden "fire-and-forget" (`void call(...)`) idi ve
    //   hemen ardından `duo_collect` çağrıları gönderiliyordu. İki geçerli
    //   toplama neredeyse aynı anda (oyuncu coinlerin üstüne yeni varmışken)
    //   yapıldığında, `duo_collect` sunucuya `duo_move`'dan ÖNCE ulaşabiliyordu.
    //   Sunucu menzili KENDİ sakladığı BAYAT `x/y` ile doğruladığı için toplama
    //   `too_far` ile REDDEDİLİYORDU. İstemci coini yine de YEREL olarak
    //   "toplandı" işaretlediği için oyuncu iki coini de toplamış GÖRÜYORDU,
    //   ama sunucu yalnızca birini sayıyordu → görev 1/2'de takılıyordu.
    //
    //   ÇÖZÜM: `duo_steal` yolunda zaten yapıldığı gibi, toplamadan ÖNCE konumu
    //   `await` ile tazele. Bu bir gecikme/debounce/retry DEĞİLDİR; iki bağımlı
    //   sunucu çağrısının DOĞRU SIRALAMASIDIR (önce konum, sonra toplama).
    //   Böylece sunucu her toplamayı GÜNCEL konumla doğrular ve iki geçerli
    //   toplama da atomik olarak (0039 kilidi) sayılır.
    if (collectedIds.length > 0 || stealing) {
      // `respawnAt`'i de yayınlarız: rakip coinleri TAM AYNI anda canlandırsın.
      // Aksi halde iki taraf farklı zamanlarda canlandırır ve "bende var, onda
      // yok" uyumsuzluğu oluşur.
      //
      // `diamond: true` bayrağı: rakip, elmasın alındığını bilir ve ona göre
      // geri bildirim verir (elmas tek seferliktir, canlandırılmaz).
      if (collectedIds.length > 0) {
        broadcast('collect', {
          ids: collectedIds,
          by: playerId,
          respawnAt: now + COIN_RESPAWN_MS,
          diamond: collectedDiamond,
        })
      }
      // Sunucuya TOPLANAN HER coini bildir. Önceden yalnızca ilk coin
      // (`collectedIds[0]`) gönderiliyordu; aynı karede birden fazla coin
      // toplandığında sunucu yalnızca birini işliyor ve skor/görev ilerlemesi
      // istemci ile sunucu arasında ayrışıyordu.
      //
      // OTORİTE DURUM (0035): `duo_collect` artık eylem sonrası TAM durumu
      // (`state`) döndürür. Yanıtı SIRAYLA uygularız; böylece aynı karede
      // birden fazla coin toplandığında bile ilerleme/sayaçlar sunucunun
      // onayladığı SON değere yakınsar ve görev tamamlanması + yeni görev
      // ataması ANINDA (yoklamayı beklemeden) yansır.
      void (async () => {
        // ÖNCE konumu tazele (await) — sunucu menzili bu konumla doğrular.
        try {
          await call('duo_move', { p_token: token, p_x: nextX, p_y: nextY })
        } catch {
          // Konum tazeleme başarısız olsa bile toplamayı yine de deneriz.
        }
        for (const coinId of collectedIds) {
          try {
            const res = await call('duo_collect', { p_token: token, p_coin_id: coinId })
            applyServerState(res)
          } catch {
            // Sunucu reddederse (too_far / already_collected) sessizce geç.
          }
        }
      })()
    }
    if (stealing) {
      broadcast('steal', { by: playerId })
      // YARIŞ ÖNLEME (KRİTİK): Sunucu `duo_steal` menzilini KENDİ sakladığı
      // `x/y` ile doğrular. Yukarıdaki `duo_move` çağrısı "fire-and-forget"
      // olduğundan, `duo_steal` ondan ÖNCE işlenirse sunucudaki konum BAYAT
      // kalır ve çalma `too_far` ile REDDEDİLİR → "steal çalışmıyor". Bu yüzden
      // önce konumu tazeleyip (await) SONRA çalmayı göndeririz.
      void (async () => {
        try {
          await call('duo_move', { p_token: token, p_x: nextX, p_y: nextY })
        } catch {
          // Konum tazeleme başarısız olsa bile çalmayı yine de deneriz.
        }
        try {
          const res = await call('duo_steal', { p_token: token })
          applyServerState(res)
        } catch {
          // Sunucu reddederse (too_far vb.) sessizce yut; yerel iyimser
          // geri bildirim zaten verildi, sunucu otoritesi sonraki yoklamada
          // düzeltir.
        }
      })()
    }
    // SKOR YAYINI YOK: puan artık sunucunun tekelindedir. İstemci skoru ne
    // üretir ne de rakibe yayınlar; her iki taraf da `duo_public_state`
    // yoklamasından aynı mutlak skoru okur. Böylece çift sayma ve "bende
    // farklı, onda farklı" uyumsuzluğu tamamen ortadan kalkar.
  }, [applyServerState])

  // Ana döngü yalnızca aktif fazlarda (countdown/battle) çalışır.
  // home/lobby/results'ta RAF tamamen durur — boşuna 60fps render yok.
  const phase = deps.state.phase
  const loopActive = phase === 'countdown' || phase === 'battle'

  useEffect(() => {
    if (!loopActive) return
    let raf = 0
    let last = performance.now()
    const tick = (perfNow: number) => {
      const dt = Math.min(0.05, (perfNow - last) / 1000)
      last = perfNow
      // `step` içindeki faz karşılaştırmaları (countdownEndsAt / endsAt) mutlak
      // epoch-ms değerleridir; bu yüzden `performance.now()` yerine `Date.now()`
      // geçiririz. `dt` ise monotonik `performance.now()` farkından gelir.
      step(Date.now(), dt)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [step, loopActive])

  // Faz değişiminde ses.
  useEffect(() => {
    if (deps.state.phase !== lastPhase.current) {
      if (deps.state.phase === 'countdown') playSound('countdown')
      lastPhase.current = deps.state.phase
    }
  }, [deps.state.phase])

  return {
    keys,
    setJoystick,
    livePos,
    liveRivalPos,
    celebrateRef,
    diamondPopRef,
    comboRef,
    scorePopRef,
    shakeRef,
  }
}

export { COUNTDOWN_MS, PHASE_TICK_MS }
