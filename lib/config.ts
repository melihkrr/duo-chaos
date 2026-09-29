import type { Coin } from './types'

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
export const PLAYER_HIT_R = 3.2
export const ARENA = { minX: 5, maxX: 95, minY: 7, maxY: 93 }
export const SPAWN = { p1: { x: 18, y: 50 }, p2: { x: 82, y: 50 } }

/** Arena % koordinatlarında engeller (CSS .obstacle.one / .two ile eşleşir) */
export const OBSTACLES: Array<{ cx: number; cy: number; w: number; h: number; angleDeg: number }> = [
  { cx: 29, cy: 31, w: 16, h: 5.5, angleDeg: 28 },
  { cx: 71, cy: 69, w: 16, h: 5.5, angleDeg: -32 },
]

// --- Görev hedefleri (SADECE görüntü için; gerçek kural sunucuda) ---
export const COLLECT_TARGET = 7
export const STEAL_TARGET = 3

// --- Coin ---
export const COIN_COUNT = 14

export const spawnCoins = (): Coin[] =>
  Array.from({ length: COIN_COUNT }, (_, i) => ({
    id: i,
    x: 8 + ((i * 31) % 84),
    y: 12 + ((i * 47) % 76),
  }))

export const spawnFor = (id: string) => (id === 'p2' ? SPAWN.p2 : SPAWN.p1)
