'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  ACTION_MS,
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
  REMOTE_POS_TTL,
  REMOTE_SMOOTHING_K,
  REMOTE_SNAP_DISTANCE,
  STEAL_COOLDOWN_MS,
  STEAL_RADIUS,
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
  const lastAction = useRef(0)
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
  // Sanal joystick vektörü. `VirtualJoystick` `setJoystick` ile buraya yazar;
  // böylece her pointer hareketinde React render tetiklenmez (yalnızca RAF okur).
  const joystick = useRef<JoystickVector>({ x: 0, y: 0 })

  /**
   * Joystick vektörünü günceller. Ref'i doğrudan dışarı vermek yerine bir
   * setter sunarız; bu, `react-hooks/immutability` kuralına uyar ve çağıran
   * tarafın hook dönüşünü mutasyona uğratmasını engeller.
   */
  const setJoystick = useCallback((x: number, y: number) => {
    joystick.current.x = x
    joystick.current.y = y
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
    if (lastRound.current !== state.round) {
      lastRound.current = state.round
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
      // KÖK SORUN ("hareket ediyorum, sonra birden başlangıç konumuna gidiyor"):
      // Broadcast bayatladığında (rakip durdu, paket kaybı) hedefi sunucu
      // snapshot'ına (`rivalTarget.x/y`) düşürüyorduk. Sunucu x/y'si `duo_move`
      // yalnızca hareket sırasında yazıldığı için BAYAT olabilir (hatta spawn);
      // bu da rakibi geriye zıplatıyordu. Bu turda bir kez canlı broadcast
      // gördüysek son bilinen konumu KORURUZ; sunucu konumuna yalnızca hiç
      // broadcast görülmediyse (geç katılma / yeniden bağlanma) düşeriz.
      //
      // EK GÜVENCE: `broadcast` varsa (taze olmasa bile) onu sunucu
      // snapshot'ına TERCİH EDERİZ. Sunucu x/y'si yalnızca hiç broadcast
      // görülmediyse (geç katılma / yeniden bağlanma) kullanılır. Böylece
      // rakip durduğunda bile son bilinen konumda kalır; spawn'a zıplamaz.
      const hasBroadcast = rivalBroadcast !== undefined
      const goalX = hasBroadcast ? rivalBroadcast.x : rivalTarget.x
      const goalY = hasBroadcast ? rivalBroadcast.y : rivalTarget.y
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
        // ANİ ZIPLAMA YALNIZCA GERÇEK IŞINLANMADA: Taze broadcast varken büyük
        // fark, dead-reckoning aşırı sapmasından (paket kaybı) kaynaklanır;
        // anında hizalamak rakibi ileri-geri zıplatır ("birden başlangıç
        // konumuna gidiyor" hissi). Bu yüzden taze veri varken asla anında
        // atlamayız; yalnızca veri YOKKEN (yeniden bağlanma / respawn) hizalarız.
        if (dist > REMOTE_SNAP_DISTANCE && !fresh) {
          // Çok büyük fark + taze veri yok: ışınlanma / yeniden bağlanma.
          remote.x = leadX
          remote.y = leadY
          remoteVel.current = { x: 0, y: 0 }
        } else if (dist > REMOTE_SETTLE) {
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

    // --- Toplama (zaman kapılı). ---
    // Puan hesabı YOK: yalnızca hangi coinlerin toplandığını belirler ve
    // sunucuya bildiririz. Değer/çeşitlilik sunucuda (`duo_collect`) işlenir.
    let collectedIds: number[] = []
    if (now - lastAction.current >= ACTION_MS) {
      lastAction.current = now
      const nearby = state.coins.filter(
        (coin) => !coin.collectedBy && Math.hypot(coin.x - nextX, coin.y - nextY) <= COLLECT_RADIUS,
      )
      if (nearby.length > 0) {
        collectedIds = nearby.map((coin) => coin.id)
        playSound('collect')
      }
    }
    const collectedSet = new Set(collectedIds)

    // --- Çalma (zaman kapılı). ---
    let stealing = false
    if (
      rivalTarget &&
      now - lastSteal.current >= STEAL_COOLDOWN_MS &&
      Math.hypot(rivalTarget.x - nextX, rivalTarget.y - nextY) <= STEAL_RADIUS
    ) {
      lastSteal.current = now
      stealing = true
      playSound('steal')
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
    const collectedTypes = state.coins
      .filter((coin) => collectedSet.has(coin.id))
      .reduce<Partial<Record<Coin['type'], number>>>(
        (counts, coin) => ({ ...counts, [coin.type]: (counts[coin.type] ?? 0) + 1 }),
        { ...(me.collectedTypes ?? {}) },
      )

    // Görev tamamlanma kararı: toplama/çalma uygulandıktan SONRAKİ varsayımsal
    // duruma göre değerlendirilir. `!me.missionDone` guard'ı şart: görev
    // tamamlandıktan sonra `collectedTypes` yeni görev verilene kadar hedefi
    // karşılamaya devam eder; guard olmadan her karede tekrar tetiklenir.
    const projected: Player = {
      ...me,
      coins: me.coins + collectedIds.length,
      stolen: me.stolen + (stealing ? 1 : 0),
      collectedTypes,
    }
    const objectiveDone = !me.missionDone && objectiveSatisfied(projected)

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
      const nextCoins = prev.coins.map((coin) => {
        if (collectedSet.has(coin.id)) {
          changed = true
          return { ...coin, collectedBy: 'p1' as const, respawnAt: now + COIN_RESPAWN_MS }
        }
        if (coin.collectedBy && coin.respawnAt && now >= coin.respawnAt) {
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
          // Yerel görsel geri bildirim: toplanan coin sayısı ve görev ilerlemesi
          // anında güncellenir. SKOR'a DOKUNMAYIZ — skor sunucudan gelir.
          if (collectedIds.length > 0) {
            changed = true
            next = {
              ...next,
              coins: next.coins + collectedIds.length,
              collectedTypes,
            }
          }
          if (stealing) {
            changed = true
            next = {
              ...next,
              stolen: next.stolen + 1,
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
    if (collectedIds.length > 0 || stealing) {
      void call('duo_move', { p_token: token, p_x: nextX, p_y: nextY }).catch(() => undefined)
    }
    if (collectedIds.length > 0) {
      // `respawnAt`'i de yayınlarız: rakip coinleri TAM AYNI anda canlandırsın.
      // Aksi halde iki taraf farklı zamanlarda canlandırır ve "bende var, onda
      // yok" uyumsuzluğu oluşur.
      broadcast('collect', { ids: collectedIds, by: playerId, respawnAt: now + COIN_RESPAWN_MS })
      // Sunucuya TOPLANAN HER coini bildir. Önceden yalnızca ilk coin
      // (`collectedIds[0]`) gönderiliyordu; aynı karede birden fazla coin
      // toplandığında sunucu yalnızca birini işliyor ve skor/görev ilerlemesi
      // istemci ile sunucu arasında ayrışıyordu.
      for (const coinId of collectedIds) {
        void call('duo_collect', { p_token: token, p_coin_id: coinId }).catch(() => undefined)
      }
    }
    if (stealing) {
      broadcast('steal', { by: playerId })
      void call('duo_steal', { p_token: token }).catch(() => undefined)
    }
    // SKOR YAYINI YOK: puan artık sunucunun tekelindedir. İstemci skoru ne
    // üretir ne de rakibe yayınlar; her iki taraf da `duo_public_state`
    // yoklamasından aynı mutlak skoru okur. Böylece çift sayma ve "bende
    // farklı, onda farklı" uyumsuzluğu tamamen ortadan kalkar.
  }, [])

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

  return { keys, setJoystick, livePos, liveRivalPos, celebrateRef }
}

export { COUNTDOWN_MS, PHASE_TICK_MS }
