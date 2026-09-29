import type { ChaosEvent, Coin, CoinType, Objective } from './types'

// --- Süreler ---
export const BATTLE_MS = 30_000
export const COUNTDOWN_MS = 3_000

// --- Ağ / döngü aralıkları ---
export const MOVE_SEND_MS = 40
export const ACTION_MS = 90
export const STEAL_COOLDOWN_MS = 700
export const RECONCILE_MS = 1000
export const HEARTBEAT_MS = 400
export const PHASE_TICK_MS = 80
export const CLOCK_TICK_MS = 150
/** Peer broadcast pozisyonunun sunucu snapshot'ını ezme süresi */
export const REMOTE_POS_TTL = 5000
export const POLL_MS = { lobby: 700, countdown: 500, battle: RECONCILE_MS, other: 1500 }

// --- Hareket / çarpışma ---
export const MOVE_SPEED = 34
export const COLLECT_RADIUS = 9
export const STEAL_RADIUS = 10
export const PLAYER_HIT_R = 4.2
export const ARENA = { minX: 5, maxX: 95, minY: 7, maxY: 93 }
export const SPAWN = { p1: { x: 18, y: 50 }, p2: { x: 82, y: 50 } }

/** Arena % koordinatlarında engeller (CSS .obstacle.one / .two ile eşleşir) */
export const OBSTACLES: Array<{ cx: number; cy: number; w: number; h: number; angleDeg: number }> = [
  { cx: 29, cy: 31, w: 16, h: 5.5, angleDeg: 28 },
  { cx: 71, cy: 69, w: 16, h: 5.5, angleDeg: -32 },
]

// --- Görev hedefleri (oyunun yeni MVP mantığına göre) ---
export const COLLECT_TARGET = 7
export const STEAL_TARGET = 3
export const COIN_TYPES: CoinType[] = ['gold', 'blue', 'red', 'emerald']

export const OBJECTIVE_POOL: Objective[] = [
  { id: 'gold-rush', kind: 'collect', label: 'Collect 3 Gold', shortLabel: '3 Gold', target: 3, coinType: 'gold' },
  { id: 'blue-raid', kind: 'collect', label: 'Collect 2 Blue + 2 Red', shortLabel: '2 Blue + 2 Red', target: 4, coinType: 'mixed' },
  { id: 'emerald-hunt', kind: 'collect', label: 'Collect 3 Emerald', shortLabel: '3 Emerald', target: 3, coinType: 'emerald' },
  { id: 'resource-control', kind: 'steal', label: 'Steal 3 from your rival', shortLabel: '3 stolen', target: 3, coinType: 'mixed' },
  { id: 'jackpot-run', kind: 'collect', label: 'Collect 1 Gold + 2 Blue', shortLabel: '1 Gold + 2 Blue', target: 3, coinType: 'mixed' },
]

export const CHAOS_EVENTS: ChaosEvent[] = [
  { id: 'gold-rush', name: 'Gold Rush', description: 'Gold spawns are boosted for 15s.', boost: 'Gold reward x2' },
  { id: 'blackout', name: 'Blackout', description: 'The arena dims and nearby resources become more valuable.', boost: 'Risky visibility' },
  { id: 'magnet', name: 'Magnet Storm', description: 'Coins drift toward the center and pressure rises.', boost: 'Resource control' },
  { id: 'swap', name: 'Chaos Swap', description: 'One of your targets is swapped mid-round.', boost: 'Plans break' },
  { id: 'jackpot', name: 'Jackpot', description: 'A rare coin appears and shifts the whole round.', boost: 'Huge score swing' },
]

export const defaultObjectiveForPlayer = (id: string): Objective => {
  const index = id === 'p2' ? 1 : 0
  return OBJECTIVE_POOL[index % OBJECTIVE_POOL.length]
}

export const generateObjectivePair = (): [Objective, Objective] => {
  const pool = [...OBJECTIVE_POOL]
  pool.sort(() => Math.random() - 0.5)
  return [pool[0], pool[1] ?? pool[0]]
}

export const nextChaosEvent = (): ChaosEvent => {
  const event = CHAOS_EVENTS[Math.floor(Math.random() * CHAOS_EVENTS.length)]
  return event ?? CHAOS_EVENTS[0]
}

export const getCoinValue = (type: CoinType, chaosEvent?: string) => {
  const base = { gold: 16, blue: 12, red: 14, emerald: 22 }[type] ?? 10
  if (chaosEvent === 'gold-rush' && type === 'gold') return base * 2
  if (chaosEvent === 'jackpot' && type === 'emerald') return base + 18
  return base
}

// --- Coin ---
export const COIN_COUNT = 14

export const spawnCoins = (): Coin[] =>
  Array.from({ length: COIN_COUNT }, (_, i) => ({
    id: i,
    x: 8 + ((i * 31) % 84),
    y: 12 + ((i * 47) % 76),
    type: COIN_TYPES[i % COIN_TYPES.length],
  }))

export const spawnFor = (id: string) => (id === 'p2' ? SPAWN.p2 : SPAWN.p1)
