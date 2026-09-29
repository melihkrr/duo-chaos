export type Phase = 'home' | 'lobby' | 'countdown' | 'battle' | 'results' | 'matchover'

export type CoinType = 'gold' | 'blue' | 'red' | 'emerald'

export type ObjectiveKind = 'collect' | 'steal'

export type Objective = {
  id: string
  kind: ObjectiveKind
  label: string
  shortLabel: string
  target: number
  coinType?: CoinType | 'mixed'
}

export type Player = {
  id: string
  name: string
  x: number
  y: number
  coins: number
  stolen: number
  score: number
  objective: Objective | null
  rematch: boolean
  /** Sunucu doldurur. Gelmezse display.ts sadece görüntü için hedefe göre türetir. */
  missionDone?: boolean
}

export type Coin = { id: number; x: number; y: number; type: CoinType; collectedBy?: string }

export type State = {
  phase: Phase
  players: Player[]
  coins: Coin[]
  endsAt: number
  countdownEndsAt: number
  round: number
  /** Sadece sunucudan gelir. Client asla hesaplamaz. */
  winner?: string
}

export type RemotePos = { x: number; y: number; at: number }
