'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BATTLE_MS,
  BUMP_COOLDOWN_MS,
  CHAOS_EVENTS,
  COIN_RESPAWN_MS,
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  MATCH_ROUNDS,
  MOVE_SPEED,
  RISKY_COIN_ID_BASE,
  RISKY_COIN_LIFETIME_MS,
  RISKY_COIN_SPAWN_MS,
  generateObjectivePair,
  getCoinValue,
  isRiskyCoin,
  randomObjective,
  riskyCoinValue,
  spawnCoins,
} from './config'
import { objectiveSatisfied, progressOf } from './display'
import { installInputResetListeners, resetAllInput } from './inputReset'
import { computeBump, resolveMove } from './movement'
import { playSound } from './sound'
import { useChaos } from './useChaos'
import { useCosmetics } from './useCosmetics'
import { useProgress } from './useProgress'
import { useToast } from './useToast'
import { blankPlayer, initialState } from './useGameState'
import { createBotMemory, decideBot, type BotMemory } from './bot'
import { claimSinglePlayerPickupIds } from './singlePlayerPickup'
import type { Coin, CoinType, Objective, Player, State } from './types'

/**
 * TEK OYUNCULU "Play vs Bot" ORKESTRATÖRÜ.
 *
 * NEDEN AYRI BİR HOOK?
 * --------------------
 * Çok oyunculu mod TAMAMEN sunucu otoritelidir (Supabase RPC: `duo_collect`,
 * `duo_steal`, `duo_tick`, `duo_public_state`). Tek oyunculu modda sunucu YOKTUR;
 * bu yüzden aynı kuralları YEREL olarak uygulayan ayrı bir orkestratör gerekir.
 *
 * YENİDEN KULLANIM (kod tekrarını önleme):
 *   - Görev havuzu/coin düzeni/puan değerleri → `config.ts`
 *   - Görev ilerlemesi/tamamlanma kararı → `display.ts` (`progressOf`,
 *     `objectiveSatisfied`) — sunucudaki `duo_mission_*` ile BİREBİR aynı mantık.
 *   - Çarpışma/hareket → `movement.ts` (`resolveMove`)
 *   - Bot yapay zekâsı → `bot.ts`
 *   - Ses/kozmetik/ilerleme/chaos/toast → mevcut hook'lar
 *
 * ÇOK OYUNCULU MOD DEĞİŞMEZ: Bu hook yalnızca `app/page.tsx` içinde, kullanıcı
 * "Play vs Bot" seçtiğinde devreye girer. `useDuoChaos` ve sunucu akışına HİÇ
 * dokunulmaz.
 *
 * DÖNÜŞ ŞEKLİ: `useDuoChaos` ile aynı alanları (state, chaos, cosmetics, toast,
 * secondsLeft, onJoystick, livePos, liveRivalPos, ref'ler, nextReady, rematch…)
 * sağlar; böylece `Battle`/`Results` bileşenleri DEĞİŞTİRİLMEDEN kullanılır.
 */

const BOT_NAME = 'Bot'
const BOT_AVATAR = 'panda' as const

/** Skor pop rozetlerinin ekranda kalma süresi (Battle ile aynı). */
const SCORE_POP_MAX = 6
const COMBO_WINDOW_MS = 2_200
const COMBO_STREAK_AT = 4
const OBJECTIVE_CELEBRATE_MS = 1_400
/**
 * Risky coin doğuş noktaları (arena %). Çok oyunculu `duo_risky_spawn_point`
 * ile BİREBİR aynıdır: merkez + iki yan hot-spot rotasyonu.
 */
const RISKY_SPAWN_POINTS = [
  { x: 50, y: 50 },
  { x: 50, y: 22 },
  { x: 50, y: 78 },
]
/** Risky coin tipi rotasyonu (çok oyunculu `duo_risky_coin_type` ile aynı). */
const RISKY_TYPES: CoinType[] = ['gold', 'emerald', 'diamond']

export type BotGameApi = {
  state: State
  chaos: ReturnType<typeof useChaos>
  cosmetics: ReturnType<typeof useCosmetics>
  toast: ReturnType<typeof useToast>
  progress: ReturnType<typeof useProgress>
  busy: boolean
  error: string | null
  secondsLeft: number
  /** Tek oyunculu modda lobi yoktur; her zaman hazır. */
  lobbyReady: boolean
  rivalLeft: boolean
  onJoystick: (dx: number, dy: number) => void
  livePos: React.RefObject<{ x: number; y: number } | null>
  liveRivalPos: React.RefObject<{ x: number; y: number } | null>
  celebrateRef: React.RefObject<number>
  diamondPopRef: React.RefObject<{ x: number; y: number; at: number } | null>
  comboRef: React.RefObject<{ count: number; at: number }>
  scorePopRef: React.RefObject<Array<{ id: number; x: number; y: number; value: number; at: number }>>
  shakeRef: React.RefObject<{ at: number; kind: 'bump' } | null>
  /** Tek oyunculu maçı başlatır (isim verilir). */
  startBotGame: (name: string) => void
  /** Sonraki tura geç (tek oyuncuda anında). */
  approveNextRound: () => void
  nextReady: boolean
  rivalNextReady: boolean
  /** Rövanş (tek oyuncuda anında yeni maç). */
  rematch: () => void
  rematchReady: boolean
  rivalRematchReady: boolean
  /** Ana ekrana dön. */
  leaveGame: () => void
  setName: (next: string) => void
  setAvatar: (id: Player['avatar']) => void
  copyInvite: () => Promise<void>
  triggerEmote: () => void
}

export const useBotGame = (): BotGameApi => {
  const [state, setState] = useState<State>(() => {
    const base = initialState()
    return {
      ...base,
      // Tek oyunculu modda rakip her zaman bottur.
      players: [
        { ...blankPlayer('p1', 'p1'), name: 'You' },
        { ...blankPlayer('p2', 'p2'), name: BOT_NAME, avatar: BOT_AVATAR },
      ],
    }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [nextReady, setNextReady] = useState(false)
  const [rematchReady, setRematchReady] = useState(false)

  const chaos = useChaos()
  const toast = useToast()
  const progress = useProgress()
  const cosmetics = useCosmetics(
    { emote: progress.progress.emote, trail: progress.progress.trail, avatar: progress.progress.avatar },
    (input) => void progress.setCosmetics(input),
  )

  // --- Kareler arası ref'ler (60Hz döngü için; React render tetiklemez) ---
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const livePos = useRef<{ x: number; y: number } | null>(null)
  const liveRivalPos = useRef<{ x: number; y: number } | null>(null)
  const celebrateRef = useRef(0)
  const diamondPopRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const comboRef = useRef<{ count: number; at: number }>({ count: 0, at: 0 })
  const scorePopRef = useRef<Array<{ id: number; x: number; y: number; value: number; at: number }>>([])
  const shakeRef = useRef<{ at: number; kind: 'bump' } | null>(null)
  // PLAYER BUMP / KNOCKBACK — yerel bekleme (cooldown). Tek oyunculu modda
  // sunucu YOKTUR; bump tamamen yerel olarak `computeBump` ile çözülür. Aynı
  // çift için sürekli temasın her karede itmesini engeller.
  const bumpCooldownRef = useRef(0)

  const joystick = useRef({ x: 0, y: 0 })
  const keys = useRef({ up: false, down: false, left: false, right: false })
  const localPos = useRef<{ x: number; y: number } | null>(null)
  const botMemory = useRef<BotMemory>(createBotMemory(82, 50))
  /** Bir sonraki risky coin doğuş zamanı (epoch ms). */
  const nextRiskyAt = useRef(0)
  /** Risky coin rotasyon sayacı (doğuş noktası + tip seçimi). */
  const riskyIndex = useRef(0)
  const lastRound = useRef(1)
  const lastChaosSlot = useRef<number | null>(null)
  // stateRef updates after React commits; reserve coin IDs synchronously so
  // repeated RAF collision checks cannot enqueue the same pickup twice.
  const claimedPickupIds = useRef(new Map<number, number | null>())
  const lastPhase = useRef(state.phase)
  const objectiveIdRef = useRef<string | null>(null)
  // `chaos` nesnesi, canlı bir olay sürerken `secondsLeft` her 250 ms'de
  // değiştiği için KARARSIZ bir kimliğe sahiptir. Chaos senkron interval'ini
  // doğrudan `chaos`'a bağlarsak interval her 250 ms'de sıfırlanır ve olay
  // hiçbir zaman uygulanmaz (banner görünmez). Bu yüzden güncel `chaos`'u bir
  // ref üzerinden okuruz; interval yalnızca faz değişiminde yeniden kurulur.
  const chaosRef = useRef(chaos)
  useEffect(() => {
    chaosRef.current = chaos
  }, [chaos])

  const onJoystick = useCallback((dx: number, dy: number) => {
    joystick.current = { x: dx, y: dy }
  }, [])

  // --- Klavye girdisi (çok oyunculu modla aynı his) ---
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') keys.current.up = true
      if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') keys.current.down = true
      if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') keys.current.left = true
      if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') keys.current.right = true
    }
    const up = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') keys.current.up = false
      if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') keys.current.down = false
      if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') keys.current.left = false
      if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') keys.current.right = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    // Sekme arka plana atıldığında / pencere odağı kaybolduğunda basılı tuşlar
    // `keyup` almaz → "stuck key" oluşur. Görünürlük/odak değişiminde girdiyi
    // nötrle ki yeni tur eski girdiyle başlamasın.
    const removeResetListeners = installInputResetListeners(() => {
      resetAllInput({ keys: keys.current, joystick: joystick.current })
    })
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      removeResetListeners()
    }
  }, [])

  // --- Sayaç (HUD için) ---
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = stateRef.current
      if (s.phase === 'battle' && s.endsAt > 0) {
        setSecondsLeft(Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000)))
      } else if (s.phase === 'countdown' && s.countdownEndsAt > 0) {
        setSecondsLeft(Math.max(0, Math.ceil((s.countdownEndsAt - Date.now()) / 1000)))
      } else {
        setSecondsLeft(0)
      }
    }, 150)
    return () => window.clearInterval(id)
  }, [])

  /**
   * Yeni tur başlatır: görevleri, coinleri, sayaçları sıfırlar ve countdown'a
   * geçer. Çok oyunculu `resetRound` ile AYNI mantığı izler (aynı seed → aynı
   * coin düzeni/görev çifti).
   */
  const beginRound = useCallback(
    (round: number) => {
      const seed = `bot-round-${round}`
      const [first, second] = generateObjectivePair(seed)
      const now = Date.now()
      setState((prev) => ({
        ...prev,
        phase: 'countdown',
        round,
        coins: spawnCoins(seed),
        endsAt: 0,
        countdownEndsAt: now + COUNTDOWN_MS,
        chaosEvent: undefined,
        chaosEventEndsAt: undefined,
        winner: undefined,
        roundScores: { p1: 0, p2: 0 },
        players: prev.players.map((player, index) => ({
          ...blankPlayer(player.id as 'p1' | 'p2', index === 0 ? 'p1' : 'p2'),
          name: player.name,
          avatar: player.avatar,
          xp: player.xp,
          level: player.level,
          title: player.title,
          trail: player.trail,
          objective: index === 0 ? first : second,
        })),
      }))
      lastChaosSlot.current = null
      // Ref'leri sıfırla.
      // Girdi state'i (klavye + joystick + gamepad) yeni turda KESİNLİKLE
      // nötr olmalı; aksi halde önceki turda basılı kalan yön yeni turda
      // otomatik hareket ettirir.
      resetAllInput({ keys: keys.current, joystick: joystick.current })
      localPos.current = null
      livePos.current = null
      liveRivalPos.current = null
      botMemory.current = createBotMemory(82, 50)
      nextRiskyAt.current = 0
      riskyIndex.current = 0
      lastRound.current = round
      comboRef.current = { count: 0, at: 0 }
      scorePopRef.current = []
      objectiveIdRef.current = null
      claimedPickupIds.current.clear()
      setNextReady(false)
      setRematchReady(false)
    },
    [],
  )

  const startBotGame = useCallback(
    (name: string) => {
      const trimmed = name.trim() || 'You'
      setBusy(true)
      setError(null)
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) =>
          index === 0 ? { ...player, name: trimmed } : player,
        ),
      }))
      beginRound(1)
      setBusy(false)
    },
    [beginRound],
  )

  const approveNextRound = useCallback(() => {
    const s = stateRef.current
    if (s.phase !== 'results') return
    setNextReady(true)
    beginRound(s.round + 1)
  }, [beginRound])

  const rematch = useCallback(() => {
    setRematchReady(true)
    // Maçı sıfırla ve 1. turdan başla.
    setState((prev) => ({
      ...prev,
      round: 1,
      roundScores: { p1: 0, p2: 0 },
      matchScores: { p1: 0, p2: 0 },
      winner: undefined,
    }))
    beginRound(1)
  }, [beginRound])

  const leaveGame = useCallback(() => {
    setState((prev) => ({
      ...initialState(),
      players: [
        { ...blankPlayer('p1', 'p1'), name: prev.players[0]?.name ?? 'You' },
        { ...blankPlayer('p2', 'p2'), name: BOT_NAME, avatar: BOT_AVATAR },
      ],
    }))
    localPos.current = null
    livePos.current = null
    liveRivalPos.current = null
    setNextReady(false)
    setRematchReady(false)
  }, [])

  const setName = useCallback((next: string) => {
    const trimmed = next.trim().slice(0, 16)
    if (!trimmed) return
    setState((prev) => ({
      ...prev,
      players: prev.players.map((player, index) => (index === 0 ? { ...player, name: trimmed } : player)),
    }))
  }, [])

  const setAvatar = useCallback(
    (id: Player['avatar']) => {
      if (!id) return
      setState((prev) => ({
        ...prev,
        players: prev.players.map((player, index) => (index === 0 ? { ...player, avatar: id } : player)),
      }))
      void progress.setCosmetics({ avatar: id })
    },
    [progress],
  )

  const copyInvite = useCallback(async () => {
    toast.push('Single-player mode — no invite needed.', 'info')
  }, [toast])

  const triggerEmote = useCallback(() => {
    cosmetics.triggerEmote()
  }, [cosmetics])

  /**
   * Tur bitişi: tur skorlarını hesapla, maç skorlarını biriktir, kazananı
   * belirle ve `results`/`matchover` fazına geç. Çok oyunculu `duo_tick` ile
   * AYNI kurallar: tur kazananı = yüksek `score`; maç = en çok tur kazanan.
   */
  const endRound = useCallback(() => {
    setState((s) => {
      const [me, bot] = s.players
      if (!me || !bot) return s
      const meScore = me.score ?? 0
      const botScore = bot.score ?? 0
      const roundWinner = meScore === botScore ? undefined : meScore > botScore ? 'p1' : 'p2'
      const roundScores = { ...(s.roundScores ?? {}), p1: meScore, p2: botScore }
      const matchScores = {
        p1: (s.matchScores?.p1 ?? 0) + meScore,
        p2: (s.matchScores?.p2 ?? 0) + botScore,
      }
      const isLastRound = s.round >= MATCH_ROUNDS
      if (isLastRound) {
        const winner = matchScores.p1 === matchScores.p2 ? undefined : matchScores.p1 > matchScores.p2 ? 'p1' : 'p2'
        playSound(winner === 'p1' ? 'win' : winner === 'p2' ? 'lose' : 'roundwin')
        // XP ödülü (yalnızca kazanınca/maç sonunda).
        void progress.award({ won: winner === 'p1', rounds: MATCH_ROUNDS })
        return {
          ...s,
          phase: 'matchover',
          endsAt: 0,
          roundScores,
          matchScores,
          winner,
        }
      }
      playSound(roundWinner === 'p1' ? 'roundwin' : roundWinner === 'p2' ? 'lose' : 'roundwin')
      return {
        ...s,
        phase: 'results',
        endsAt: 0,
        roundScores,
        matchScores,
        winner: roundWinner,
      }
    })
  }, [progress])

  // `step` içinden `endRound`'a başvurmak için ref (döngüsel bağımlılığı kırar).
  const endRoundRef = useRef(endRound)
  useEffect(() => {
    endRoundRef.current = endRound
  }, [endRound])

  /**
   * Tek kare ilerleme. Çok oyunculu `useGameLoop.step` ile AYNI kuralları
   * uygular ama sunucu çağrısı YAPMAZ: toplama/çalma/görev/skor yerel olarak,
   * `display.ts` ve `config.ts` fonksiyonlarıyla hesaplanır.
   */
  const step = useCallback((now: number, dt: number) => {
    const prev = stateRef.current

    // --- Faz geçişleri ---
    if (prev.phase === 'countdown' && prev.countdownEndsAt > 0 && now >= prev.countdownEndsAt) {
      playSound('start')
      setState((s) => ({ ...s, phase: 'battle', endsAt: now + BATTLE_MS }))
      return
    }
    if (prev.phase === 'battle' && prev.endsAt > 0 && now >= prev.endsAt) {
      endRoundRef.current()
      return
    }
    if (prev.phase !== 'battle') {
      localPos.current = null
      // Savaş dışı fazlarda (countdown/results/matchover) girdiyi sürekli
      // nötrle: tur geçişi sırasında gelen keydown/keyup olayları yeni tura
      // yanlış state taşımasın.
      resetAllInput({ keys: keys.current, joystick: joystick.current })
      return
    }

    const me = prev.players[0]
    const bot = prev.players[1]
    if (!me || !bot) return

    // Yeni tur: konum ref'lerini spawn'dan tohumla.
    if (lastRound.current !== prev.round) {
      lastRound.current = prev.round
      // Tur ilerlediğinde girdiyi nötrle (çok oyunculu `useGameLoop` ile aynı
      // davranış) → yeni tur nötr girdiyle başlar.
      resetAllInput({ keys: keys.current, joystick: joystick.current })
      localPos.current = { x: me.x, y: me.y }
      livePos.current = { x: me.x, y: me.y }
      botMemory.current = createBotMemory(bot.x, bot.y)
      liveRivalPos.current = { x: bot.x, y: bot.y }
    }

    // --- Yerel oyuncu girdisi ---
    let dx = 0
    let dy = 0
    if (keys.current.up) dy -= 1
    if (keys.current.down) dy += 1
    if (keys.current.left) dx -= 1
    if (keys.current.right) dx += 1
    dx += joystick.current.x
    dy += joystick.current.y

    if (!localPos.current) localPos.current = { x: me.x, y: me.y }
    const fromX = localPos.current.x
    const fromY = localPos.current.y
    let nextX = fromX
    let nextY = fromY
    const moving = Math.hypot(dx, dy) > 0.01
    if (moving) {
      const length = Math.hypot(dx, dy) || 1
      const slowed = (me.slowedUntil ?? 0) > now
      const speed = MOVE_SPEED * (slowed ? 0.55 : 1)
      const targetX = fromX + (dx / length) * speed * dt
      const targetY = fromY + (dy / length) * speed * dt
      const resolved = resolveMove(fromX, fromY, targetX, targetY)
      nextX = resolved.x
      nextY = resolved.y
    }
    localPos.current = { x: nextX, y: nextY }
    livePos.current = { x: nextX, y: nextY }

    // --- Bot kararı ve hareketi ---
    const botDecision = decideBot(
      {
        me: bot,
        rival: { x: nextX, y: nextY },
        coins: prev.coins,
        now,
        chaosEventId: prev.chaosEvent?.id,
      },
      botMemory.current,
    )
    const botFromX = botMemory.current.x
    const botFromY = botMemory.current.y
    let botNextX = botFromX
    let botNextY = botFromY
    const botMoving = Math.hypot(botDecision.dx, botDecision.dy) > 0.01
    if (botMoving) {
      const length = Math.hypot(botDecision.dx, botDecision.dy) || 1
      const slowed = (bot.slowedUntil ?? 0) > now
      const speed = MOVE_SPEED * (slowed ? 0.55 : 1)
      const targetX = botFromX + (botDecision.dx / length) * speed * dt
      const targetY = botFromY + (botDecision.dy / length) * speed * dt
      const resolved = resolveMove(botFromX, botFromY, targetX, targetY)
      botNextX = resolved.x
      botNextY = resolved.y
    }
    botMemory.current.x = botNextX
    botMemory.current.y = botNextY
    liveRivalPos.current = { x: botNextX, y: botNextY }

    // --- PLAYER BUMP / KNOCKBACK (yerel, deterministik). ---
    //
    // Tek oyunculu modda sunucu yoktur; bump `computeBump` ile YEREL olarak
    // çözülür. Çok oyunculu `duo_bump` ile AYNI matematiği kullanır (yön =
    // merkezler arası normalize vektör, belirsizde +x yedeği, her iki oyuncu
    // `BUMP_KNOCKBACK` kadar itilir, arena sınırına kırpılır). Skor/coin/görev/
    // tur DEĞİŞMEZ. `BUMP_COOLDOWN_MS` sürekli temasın her karede itmesini
    // engeller.
    if (now - bumpCooldownRef.current >= BUMP_COOLDOWN_MS) {
      const contact = computeBump(nextX, nextY, botNextX, botNextY)
      if (contact.bumped) {
        bumpCooldownRef.current = now
        nextX = contact.me.x
        nextY = contact.me.y
        botNextX = contact.rival.x
        botNextY = contact.rival.y
        localPos.current = { x: nextX, y: nextY }
        livePos.current = { x: nextX, y: nextY }
        botMemory.current.x = botNextX
        botMemory.current.y = botNextY
        liveRivalPos.current = { x: botNextX, y: botNextY }
        shakeRef.current = { at: now, kind: 'bump' }
        playSound('bump')
      }
    }

    // --- Toplama: yerel oyuncu ---
    const meCandidates = prev.coins
      .filter((c) => !c.collectedBy && Math.hypot(c.x - nextX, c.y - nextY) <= COLLECT_RADIUS)
      .map((c) => c.id)
    const meCollectIds = claimSinglePlayerPickupIds(
      prev.coins,
      meCandidates,
      now,
      claimedPickupIds.current,
    )
    // --- Toplama: bot (aynı menzil) ---
    const botCandidates = prev.coins
      .filter((c) => !c.collectedBy && Math.hypot(c.x - botNextX, c.y - botNextY) <= COLLECT_RADIUS)
      .map((c) => c.id)
    const botCollectIds = claimSinglePlayerPickupIds(
      prev.coins,
      botCandidates,
      now,
      claimedPickupIds.current,
    )

    // --- RISKY COIN: periyodik yüksek puanlı bonus coin doğuşu ---
    // Çok oyunculu `duo_tick` + `duo_spawn_risky_coin` ile aynı davranış:
    // her RISKY_COIN_SPAWN_MS'de bir hot-spot'ta doğar; RISKY_COIN_LIFETIME_MS
    // içinde toplanmazsa kaybolur. Aynı anda tek risky coin olur.
    if (nextRiskyAt.current === 0) nextRiskyAt.current = now + RISKY_COIN_SPAWN_MS
    let riskySpawn: Coin | null = null
    if (now >= nextRiskyAt.current) {
      nextRiskyAt.current = now + RISKY_COIN_SPAWN_MS
      const index = riskyIndex.current
      riskyIndex.current += 1
      const point = RISKY_SPAWN_POINTS[index % RISKY_SPAWN_POINTS.length]
      riskySpawn = {
        id: RISKY_COIN_ID_BASE + (index % 1000),
        x: point.x,
        y: point.y,
        type: RISKY_TYPES[index % RISKY_TYPES.length],
        respawnAt: now + RISKY_COIN_LIFETIME_MS,
      }
    }

    // --- Görsel geri bildirim (yerel toplama) ---
    if (meCollectIds.length > 0) {
      const nearby = prev.coins.filter((c) => meCollectIds.includes(c.id))
      const diamondCoin = nearby.find((c) => c.type === 'diamond')
      const prevCombo = comboRef.current
      const comboCount = now - prevCombo.at <= COMBO_WINDOW_MS ? prevCombo.count + 1 : 1
      comboRef.current = { count: comboCount, at: now }
      if (diamondCoin) playSound('jackpot')
      else if (comboCount >= COMBO_STREAK_AT) playSound('streak')
      else if (comboCount >= 2) playSound('combo')
      else playSound('collect')
      if (diamondCoin) diamondPopRef.current = { x: diamondCoin.x, y: diamondCoin.y, at: now }
      const pops = nearby.slice(0, SCORE_POP_MAX).map((coin, index) => ({
        id: now + index,
        x: coin.x,
        y: coin.y,
        value: getCoinValue(coin.type, prev.chaosEvent?.id, me.objective),
        at: now,
      }))
      scorePopRef.current = [...scorePopRef.current, ...pops].slice(-SCORE_POP_MAX)
    }

    // --- Tek setState: coinler + oyuncular + skor + görev ---
    setState((s) => {
      let changed = false

      // Coinleri işaretle (yerel + bot). Elmas ve risky coin tek seferliktir
      // (respawn yok). Risky coinler süresi dolunca (toplanmadan) kaybolur.
      const collectedByMe = new Set(meCollectIds)
      const collectedByBot = new Set(botCollectIds)
      let nextCoins = s.coins
        .filter((coin) => {
          // Süresi dolmuş, toplanmamış risky coinleri kaldır (despawn).
          if (
            isRiskyCoin(coin.id) &&
            !coin.collectedBy &&
            coin.respawnAt &&
            now >= coin.respawnAt
          ) {
            changed = true
            return false
          }
          return true
        })
        .map((coin) => {
          const oneShot = coin.type === 'diamond' || isRiskyCoin(coin.id)
          if (collectedByMe.has(coin.id)) {
            changed = true
            if (oneShot) return { ...coin, collectedBy: 'p1', respawnAt: undefined }
            return { ...coin, collectedBy: 'p1', respawnAt: now + COIN_RESPAWN_MS }
          }
          if (collectedByBot.has(coin.id)) {
            changed = true
            if (oneShot) return { ...coin, collectedBy: 'p2', respawnAt: undefined }
            return { ...coin, collectedBy: 'p2', respawnAt: now + COIN_RESPAWN_MS }
          }
          if (
            coin.type !== 'diamond' &&
            !isRiskyCoin(coin.id) &&
            coin.collectedBy &&
            coin.respawnAt &&
            now >= coin.respawnAt
          ) {
            changed = true
            return { ...coin, collectedBy: undefined, respawnAt: undefined }
          }
          return coin
        })
      // Yeni risky coin doğduysa ekle (aynı anda tek risky coin).
      if (riskySpawn) {
        changed = true
        nextCoins = [
          ...nextCoins.filter((coin) => !isRiskyCoin(coin.id)),
          riskySpawn,
        ]
      }

      // Oyuncuları güncelle.
      const nextPlayers = s.players.map((player, index) => {
        const isMe = index === 0
        const collectIds = isMe ? meCollectIds : botCollectIds
        let next = player

        if (collectIds.length > 0) {
          changed = true
          const collectedCoins = s.coins.filter((c) => collectIds.includes(c.id))
          const freshTypes = collectedCoins.reduce<Partial<Record<CoinType, number>>>(
            (counts, coin) => ({ ...counts, [coin.type]: (counts[coin.type] ?? 0) + 1 }),
            {},
          )
          // PUAN TABANLI SKOR (çok oyunculu `duo_collect` ile BİREBİR aynı):
          // Her toplanan coin, `getCoinValue` kadar puan ekler. Önceden yalnızca
          // görev tamamlanınca puan ekleniyordu; bu yüzden tek oyunculu modda
          // "sadece görevlerden puan alabiliyorum" hatası vardı.
          const coinPoints = collectedCoins.reduce(
            (sum, coin) =>
              sum +
              (isRiskyCoin(coin.id)
                ? riskyCoinValue(coin.type)
                : getCoinValue(coin.type, s.chaosEvent?.id, next.objective)),
            0,
          )
          next = {
            ...next,
            coins: next.coins + collectIds.length,
            roundCoins: (next.roundCoins ?? 0) + collectIds.length,
            score: next.score + coinPoints,
            roundScore: (next.roundScore ?? 0) + coinPoints,
            totalScore: (next.totalScore ?? 0) + coinPoints,
            collectedTypes: {
              ...(next.collectedTypes ?? {}),
              ...Object.fromEntries(
                Object.entries(freshTypes).map(([type, count]) => [
                  type,
                  (next.collectedTypes?.[type as CoinType] ?? 0) + (count ?? 0),
                ]),
              ),
            },
          }
        }
        // GÖREV İLERLEMESİ (yerel otorite): `display.ts` ile SAYAÇLARDAN hesapla.
        //
        // ÖNEMLİ: `progressOf`, `objectiveProgress` alanı SAYI ise onu "sunucu
        // otoritesi" sayıp AYNEN döndürür. Tek oyunculu modda sunucu YOKTUR;
        // bu alan bizim önceki karede yazdığımız değerdir ve bayattır. Bu yüzden
        // ilerlemeyi hesaplarken `objectiveProgress`'i GEÇİCİ OLARAK kaldırırız;
        // böylece `progressOf` sayaçlardan (`collectedTypes`/`stolen`/`coins`)
        // türetir — çok oyunculu sunucunun `duo_mission_progress` ile aynı mantık.
        const countersOnly = { ...next, objectiveProgress: undefined }
        const progressValue = progressOf(countersOnly)
        if (progressValue !== next.objectiveProgress) {
          changed = true
          next = { ...next, objectiveProgress: progressValue }
        }

        // GÖREV TAMAMLANDI MI? `display.ts` ile (sunucuyla aynı mantık).
        // `objectiveSatisfied` de sayaçlardan türetilen ilerlemeyi görmeli;
        // bu yüzden `countersOnly` + güncel ilerleme ile kontrol ederiz.
        if (!next.missionDone && objectiveSatisfied(countersOnly)) {
          changed = true
          const objective = next.objective
          const reward = objective?.points ?? 0
          // Puan ödülü + yeni görev ata (aynı görev tekrar gelmesin).
          const replacement = randomObjective(objective?.id)
          next = {
            ...next,
            score: next.score + reward,
            roundScore: (next.roundScore ?? 0) + reward,
            totalScore: (next.totalScore ?? 0) + reward,
            objectivesDone: (next.objectivesDone ?? 0) + 1,
            missionDone: false,
            // Görev tamamlanınca sayaçlar sıfırlanır (sunucu davranışı).
            coins: 0,
            stolen: 0,
            collectedTypes: {},
            objectiveProgress: 0,
            objective: replacement,
          }
          if (isMe) {
            celebrateRef.current = now
            playSound('win')
          }
        }
        return next
      })

      if (!changed) return s
      return { ...s, coins: nextCoins, players: nextPlayers }
    })
  }, [])

  // ANA DÖNGÜ (RAF): `step`'i her karede çağırır. Yalnızca aktif fazlarda
  // (countdown/battle) çalışır; home/results/matchover'da tamamen durur.
  //
  // ÖNEMLİ: Bu döngü olmadan `step` HİÇ çağrılmaz → ne yerel oyuncu ne de bot
  // hareket eder. Çok oyunculu `useGameLoop` ile aynı desen: `step` içindeki
  // faz karşılaştırmaları mutlak epoch-ms olduğundan `Date.now()` geçiririz;
  // `dt` ise monotonik `performance.now()` farkından gelir.
  const loopActive = state.phase === 'countdown' || state.phase === 'battle'
  useEffect(() => {
    if (!loopActive) return
    let raf = 0
    let last = performance.now()
    const tick = (perfNow: number) => {
      const dt = Math.min(0.05, (perfNow - last) / 1000)
      last = perfNow
      step(Date.now(), dt)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [step, loopActive])

  // Faz değişiminde ses.
  useEffect(() => {
    if (state.phase !== lastPhase.current) {
      if (state.phase === 'countdown') playSound('countdown')
      lastPhase.current = state.phase
    }
  }, [state.phase])

  // Chaos olayı: tek oyunculu modda da tur içinde bir chaos olayı gösterelim
  // (görsel çeşitlilik). Sunucu olmadığından basit bir periyodik seçim yaparız.
  //
  // ÖNEMLİ: Bağımlılık YALNIZCA `state.phase`. `chaos`'a bağlarsak (canlı olay
  // sürerken `secondsLeft` her 250 ms'de değişir) interval sürekli sıfırlanır
  // ve chaos olayı hiç uygulanmaz → banner görünmez. Güncel `chaos`'u ref'ten
  // okuruz.
  useEffect(() => {
    if (state.phase !== 'battle') return
    const id = window.setInterval(() => {
      const s = stateRef.current
      if (s.phase !== 'battle') return
      // Her 15 sn'de bir yeni chaos olayı (config'teki periyotla uyumlu).
      const slot = Math.floor(Date.now() / 15_000)
      const nextEvent = CHAOS_EVENTS[slot % CHAOS_EVENTS.length]
      if (nextEvent && lastChaosSlot.current !== slot) {
        const endsAt = Date.now() + 15_000
        lastChaosSlot.current = slot
        chaosRef.current.sync({ id: nextEvent.id, endsAt })
        setState((prev) => {
          let next = { ...prev, chaosEvent: nextEvent, chaosEventEndsAt: endsAt }
          if (nextEvent.id === 'swap' && prev.players.length >= 2) {
            const [first, second] = prev.players
            next = {
              ...next,
              players: prev.players.map((player, index) => ({
                ...player,
                objective: index === 0 ? second?.objective ?? player.objective : first?.objective ?? player.objective,
                coins: 0,
                stolen: 0,
                collectedTypes: {},
                objectiveProgress: 0,
                missionDone: false,
              })),
            }
          }
          if (nextEvent.id === 'jackpot' && !prev.coins.some((coin) => coin.id === 900 + prev.round)) {
            next = {
              ...next,
              coins: [...next.coins, { id: 900 + prev.round, x: 50, y: 50, type: 'diamond' }],
            }
          }
          return next
        })
      }
    }, 3_000)
    return () => window.clearInterval(id)
  }, [state.phase])

  // Chaos süresi dolunca temizle. Bağımlılık YALNIZCA `state.phase`; güncel
  // `chaos` ref'ten okunur (yukarıdaki ile aynı gerekçe).
  useEffect(() => {
    if (state.phase !== 'battle') return
    const id = window.setInterval(() => {
      const c = chaosRef.current
      if (c.event && c.endsAt > 0 && Date.now() >= c.endsAt) {
        c.clear()
        setState((prev) =>
          prev.chaosEvent
            ? { ...prev, chaosEvent: undefined, chaosEventEndsAt: undefined }
            : prev,
        )
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [state.phase])

  useEffect(() => {
    if (state.phase !== 'battle' || state.chaosEvent?.id !== 'magnet') return
    const id = window.setInterval(() => {
      const now = Date.now()
      setState((prev) => {
        if (
          prev.phase !== 'battle' ||
          prev.chaosEvent?.id !== 'magnet' ||
          (prev.chaosEventEndsAt ?? 0) <= now
        ) return prev
        const coins = prev.coins.map((coin) =>
          coin.collectedBy || coin.type === 'diamond'
            ? coin
            : { ...coin, x: coin.x + (50 - coin.x) * 0.018, y: coin.y + (50 - coin.y) * 0.018 },
        )
        return { ...prev, coins }
      })
    }, 1_000)
    return () => window.clearInterval(id)
  }, [state.phase, state.chaosEvent?.id])

  // `objectiveIdRef` — görev değişimini izle (ileride genişletme için).
  useEffect(() => {
    objectiveIdRef.current = state.players[0]?.objective?.id ?? null
  }, [state.players])

  return useMemo<BotGameApi>(
    () => ({
      state,
      chaos,
      cosmetics,
      toast,
      progress,
      busy,
      error,
      secondsLeft,
      lobbyReady: true,
      rivalLeft: false,
      onJoystick,
      livePos,
      liveRivalPos,
      celebrateRef,
      diamondPopRef,
      comboRef,
      scorePopRef,
      shakeRef,
      startBotGame,
      approveNextRound,
      nextReady,
      rivalNextReady: false,
      rematch,
      rematchReady,
      rivalRematchReady: false,
      leaveGame,
      setName,
      setAvatar,
      copyInvite,
      triggerEmote,
    }),
    [
      state,
      chaos,
      cosmetics,
      toast,
      progress,
      busy,
      error,
      secondsLeft,
      onJoystick,
      startBotGame,
      approveNextRound,
      nextReady,
      rematch,
      rematchReady,
      leaveGame,
      setName,
      setAvatar,
      copyInvite,
      triggerEmote,
    ],
  )
}

export { BATTLE_MS, COUNTDOWN_MS, MATCH_ROUNDS }
