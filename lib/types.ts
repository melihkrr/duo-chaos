export type Phase = 'home' | 'lobby' | 'countdown' | 'battle' | 'results' | 'matchover'
export type Objective = 'collect' | 'steal'

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

export type Coin = { id: number; x: number; y: number; collectedBy?: string }

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
