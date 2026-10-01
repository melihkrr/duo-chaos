export type Phase = 'home' | 'lobby' | 'countdown' | 'battle' | 'results' | 'matchover'

export type CoinType = 'gold' | 'blue' | 'red' | 'emerald' | 'diamond'
export type ChaosEventType = 'gold-rush' | 'blackout' | 'magnet' | 'swap' | 'jackpot'

export type ObjectiveKind = 'collect' | 'steal'

/** Oyuncunun seçebileceği emote (kısa tepki animasyonu). */
export type EmoteId = 'wave' | 'taunt' | 'shock' | 'gg' | 'fire'

/** Oyuncunun arkasında bıraktığı iz efekti. */
export type TrailId = 'none' | 'spark' | 'frost' | 'ember' | 'shadow'

/** Sunucudan gelen kısmi ipucu (Guess/Read mekaniği). */
export type ScoutHint = {
  /** Rakibin görevinin türü: toplama mı, çalma mı. */
  kind: ObjectiveKind
  /** Rakibin hedeflediği ana coin türü (varsa). */
  coinType?: CoinType | 'mixed'
  /** Rakibin görev hedefi (kaç adet). */
  target: number
  /** İpucunun üretildiği zaman (ms). */
  at: number
}

export type Objective = {
  id: string
  kind: ObjectiveKind
  label: string
  shortLabel: string
  target: number
  coinType?: CoinType | 'mixed'
  requirements?: Partial<Record<CoinType, number>>
  stealTarget?: number
  /**
   * Görev tamamlandığında kazanılan PUAN ödülü.
   *
   * ÖNEMLİ: Skor artık "tamamlanan görev sayısı" DEĞİL, toplanan PUAN'dır.
   * Puan; coin toplama + çalma + bu görev ödülünden birikir. Görevlerin
   * önemini yitirmemesi için ödül, birkaç coin değerinden yüksek tutulur
   * (bkz. OBJECTIVE_POOL). Sunucu `duo_objective_pool` ile birebir aynı
   * olmalıdır.
   */
  points?: number
}

export type ChaosEvent = {
  id: ChaosEventType
  name: string
  description: string
  boost: string
}

export type Player = {
  id: string
  name: string
  x: number
  y: number
  coins: number
  stolen: number
  collectedTypes?: Partial<Record<CoinType, number>>
  /**
   * PUAN TABANLI SKOR. Coin toplama + çalma + görev ödüllerinin TOPLAMI.
   * Sunucu otoritesidir (`duo_collect`/`duo_steal`/`duo_reroll_objective`).
   * Karşılaştırma kıstası budur — görev sayısı DEĞİL.
   */
  score: number
  roundScore?: number
  totalScore?: number
  /**
   * Tamamlanan görev sayısı — yalnızca İSTATİSTİK. Skor DEĞİLDİR (skor
   * `score` alanıdır ve puan tabanlıdır). Her görev tamamlandığında 1 artar,
   * yerine rastgele yeni bir görev verilir ve görevin `points` ödülü skora
   * eklenir.
   */
  objectivesDone?: number
  xp?: number
  slowedUntil?: number
  objective: Objective | null
  rematch: boolean
  /** Sunucu doldurur. Gelmezse display.ts sadece görüntü için hedefe göre türetir. */
  missionDone?: boolean
  /** Guess/Read: kalan tarama hakkı. Sunucu otoritesi. */
  scoutCharges?: number
  /** Guess/Read: son taramanın üretildiği zaman (cooldown için). */
  scoutUsedAt?: number
  /** Guess/Read: rakibin görevi hakkında elde edilen kısmi ipucu. */
  revealedHint?: ScoutHint | null
  /** Aktif emote ve bitiş zamanı (cosmetic). */
  emote?: EmoteId | null
  emoteUntil?: number
  /** Seçili iz efekti (cosmetic). */
  trail?: TrailId
  /** Sunucudan gelen seviye/ünvan (progression). */
  level?: number
  title?: string
}

export type Coin = {
  id: number
  x: number
  y: number
  type: CoinType
  collectedBy?: string
  /**
   * Toplandıktan sonra yeniden doğacağı zaman (epoch ms). 0/undefined ise
   * yeniden doğma beklenmiyor. Süre dolunca coin yeni konum + yeni renkle
   * tekrar oynanabilir hale gelir.
   */
  respawnAt?: number
}

export type State = {
  phase: Phase
  players: Player[]
  coins: Coin[]
  endsAt: number
  countdownEndsAt: number
  round: number
  roundScores?: Record<string, number>
  matchScores?: Record<string, number>
  chaosEvent?: ChaosEvent
  chaosEventEndsAt?: number
  /** Sadece sunucudan gelir. Client asla hesaplamaz. */
  winner?: string
  /** Sunucu tarafından üretilen bir sonraki chaos olayının zamanı. */
  nextChaosAt?: number
  /** Sunucu tarafından üretilen bir sonraki kaynak dalgasının zamanı. */
  nextWaveAt?: number
  /** Sunucu bağlantı durumu (UI göstergesi için). */
  connection?: 'idle' | 'connecting' | 'live' | 'error'
}

export type RemotePos = { x: number; y: number; at: number }

/** Sunucudan gelen oyuncu ilerlemesi (XP / seviye / kozmetik). */
export type Progress = {
  clientId: string
  xp: number
  level: number
  title: string
  emote: EmoteId
  trail: TrailId
  wins: number
  matches: number
}
