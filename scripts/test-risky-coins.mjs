// ============================================================================
// DUO CHAOS — risky coin (bonus) regression test.
//
// The steal flow was removed entirely and replaced with "RISKY COINS": high
// value special coins (gold / emerald / diamond) that spawn periodically at
// deterministic hot-spots. Both players race to collect them. No contact, no
// cooldowns, no mutual-steal races — just a collection race.
//
// This test mirrors the EXACT server rules from migration 0051 and the client
// constants from lib/config.ts, then drives the required scenarios:
//   1. SPAWN CADENCE: a risky coin spawns every ~15s (idempotent per slot).
//   2. HOT-SPOTS: spawn points rotate deterministically (50,50)/(50,22)/(50,78).
//   3. TYPES: gold → emerald → diamond rotation.
//   4. VALUES: gold=40, emerald=45, diamond=60.
//   5. DESPAWN: an uncollected risky coin is deleted after 8s.
//   6. FIRST-COME: the first player to reach it collects it; the other cannot.
//   7. NO RESPAWN: a collected risky coin never respawns (respawn_at = 0).
//   8. OBJECTIVE POOL: steal objectives are gone; risky-hunter/emerald-rush exist.
//   9. STEAL REMOVED: duo_steal_versioned is a no-op returning ok:false.
//
// No DB required. Run: node scripts/test-risky-coins.mjs
// ============================================================================

import { readFile } from 'node:fs/promises'

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2718 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

// --- Constants mirrored from migration 0051 / lib/config.ts -----------------
const RISKY_COIN_ID_BASE = 2000
const RISKY_COIN_SPAWN_MS = 15_000
const RISKY_COIN_LIFETIME_MS = 8_000
const RISKY_COIN_VALUES = { gold: 40, emerald: 45, diamond: 60 }
const RISKY_TYPES = ['gold', 'emerald', 'diamond']
const RISKY_SPAWN_POINTS = [
  { x: 50, y: 50 },
  { x: 50, y: 22 },
  { x: 50, y: 78 },
]
const COLLECT_RADIUS = 9

const migration = await readFile(
  new URL('../supabase/migrations/0051_risky_coins.sql', import.meta.url),
  'utf8',
)
const configSource = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')

// --- Mirror of duo_risky_spawn_point / duo_risky_coin_type / value ----------
const riskySpawnPoint = (index) => RISKY_SPAWN_POINTS[index % RISKY_SPAWN_POINTS.length]
const riskyCoinType = (index) => RISKY_TYPES[index % RISKY_TYPES.length]
const riskyCoinValue = (type) => RISKY_COIN_VALUES[type] ?? 30
const isRiskyCoin = (coinId) => coinId >= RISKY_COIN_ID_BASE

// --- Mirror of duo_spawn_risky_coin + duo_tick spawn/despawn ----------------
// `state` = { coins: [{ id, type, x, y, respawnAt }], battleStart }
const spawnRiskyCoin = (state, index, now) => {
  // Delete any uncollected risky coin first (one at a time on the map).
  state.coins = state.coins.filter((coin) => !isRiskyCoin(coin.id))
  const point = riskySpawnPoint(index)
  state.coins.push({
    id: RISKY_COIN_ID_BASE + (index % 1000),
    type: riskyCoinType(index),
    x: point.x,
    y: point.y,
    respawnAt: now + RISKY_COIN_LIFETIME_MS,
  })
}

const tick = (state, now) => {
  const slot = Math.floor((now - state.battleStart) / RISKY_COIN_SPAWN_MS)
  if (slot > 0 && state.lastRiskySlot !== slot) {
    state.lastRiskySlot = slot
    spawnRiskyCoin(state, slot - 1, now)
  }
  // Despawn uncollected risky coins past their deadline.
  state.coins = state.coins.filter(
    (coin) => !isRiskyCoin(coin.id) || coin.respawnAt > now,
  )
}

// --- Mirror of duo_collect_batch for risky coins ----------------------------
const collect = (state, player, coinId, now) => {
  const coin = state.coins.find((c) => c.id === coinId)
  if (!coin) return { ok: false, reason: 'missing' }
  if (coin.collectedBy) return { ok: false, reason: 'taken' }
  const dist = Math.hypot(player.x - coin.x, player.y - coin.y)
  if (dist > COLLECT_RADIUS) return { ok: false, reason: 'too_far' }
  const risky = isRiskyCoin(coin.id)
  const value = risky ? riskyCoinValue(coin.type) : 5
  coin.collectedBy = player.id
  // Risky coins NEVER respawn (respawn_at = 0), like diamond.
  coin.respawnAt = risky || coin.type === 'diamond' ? 0 : now + 3000
  player.score += value
  return { ok: true, value, risky }
}

console.log('\nRISKY COIN — spawn / value / despawn / first-come / no-respawn\n')

// --- 1) SPAWN CADENCE -------------------------------------------------------
{
  const state = { coins: [], battleStart: 0, lastRiskySlot: 0 }
  tick(state, 14_000)
  check('no risky coin before the first 15s slot', state.coins.length === 0)
  tick(state, 15_000)
  check('risky coin spawns at the 15s slot', state.coins.length === 1)
  const firstId = state.coins[0]?.id
  tick(state, 15_500)
  check('spawn is idempotent within the same slot', state.coins.length === 1 && state.coins[0].id === firstId)
  tick(state, 30_000)
  check('a new risky coin spawns at the 30s slot', state.coins.length === 1 && state.coins[0].id !== firstId)
}

// --- 2) HOT-SPOTS + 3) TYPES ------------------------------------------------
{
  const state = { coins: [], battleStart: 0, lastRiskySlot: 0 }
  const seenPoints = []
  const seenTypes = []
  for (let slot = 1; slot <= 3; slot += 1) {
    tick(state, slot * RISKY_COIN_SPAWN_MS)
    seenPoints.push(`${state.coins[0].x},${state.coins[0].y}`)
    seenTypes.push(state.coins[0].type)
  }
  check(
    'spawn points rotate through the 3 hot-spots',
    seenPoints.join('|') === '50,50|50,22|50,78',
    seenPoints.join('|'),
  )
  check(
    'types rotate gold → emerald → diamond',
    seenTypes.join('|') === 'gold|emerald|diamond',
    seenTypes.join('|'),
  )
}

// --- 4) VALUES --------------------------------------------------------------
{
  check('gold risky coin is worth 40', riskyCoinValue('gold') === 40)
  check('emerald risky coin is worth 45', riskyCoinValue('emerald') === 45)
  check('diamond risky coin is worth 60', riskyCoinValue('diamond') === 60)
  check(
    'client RISKY_COIN_VALUES matches the server values',
    /RISKY_COIN_VALUES[^}]*gold:\s*40[^}]*emerald:\s*45[^}]*diamond:\s*60/s.test(configSource),
  )
}

// --- 5) DESPAWN -------------------------------------------------------------
{
  const state = { coins: [], battleStart: 0, lastRiskySlot: 0 }
  tick(state, 15_000)
  check('risky coin present right after spawn', state.coins.length === 1)
  tick(state, 15_000 + RISKY_COIN_LIFETIME_MS - 1)
  check('risky coin still present just before the deadline', state.coins.length === 1)
  tick(state, 15_000 + RISKY_COIN_LIFETIME_MS)
  check('uncollected risky coin despawns at the deadline', state.coins.length === 0)
}

// --- 6) FIRST-COME ----------------------------------------------------------
{
  const state = { coins: [], battleStart: 0, lastRiskySlot: 0 }
  tick(state, 15_000)
  const coin = state.coins[0]
  const p1 = { id: 'p1', x: coin.x, y: coin.y, score: 0 }
  const p2 = { id: 'p2', x: coin.x, y: coin.y, score: 0 }
  const first = collect(state, p1, coin.id, 15_100)
  const second = collect(state, p2, coin.id, 15_150)
  check('first player to reach the risky coin collects it', first.ok && first.value === 40)
  check('the second player cannot collect the same risky coin', !second.ok && second.reason === 'taken')
  check('only the first player scored', p1.score === 40 && p2.score === 0)
}

// --- 7) NO RESPAWN ----------------------------------------------------------
{
  const state = { coins: [], battleStart: 0, lastRiskySlot: 0 }
  tick(state, 15_000)
  const coin = state.coins[0]
  const p1 = { id: 'p1', x: coin.x, y: coin.y, score: 0 }
  collect(state, p1, coin.id, 15_100)
  check('collected risky coin has respawn_at = 0 (never respawns)', coin.respawnAt === 0)
  // Advance well past the normal 3s respawn window: it must stay gone.
  tick(state, 15_100 + 10_000)
  check('collected risky coin does not come back', !state.coins.some((c) => c.id === coin.id))
}

// --- 8) OBJECTIVE POOL ------------------------------------------------------
{
  check(
    'server objective pool no longer contains steal objectives',
    !/resource-control|gold-robbery/.test(migration),
  )
  check('server objective pool defines risky-hunter', /risky-hunter/.test(migration))
  check('server objective pool defines emerald-rush', /emerald-rush/.test(migration))
  check(
    'client objective pool matches (risky-hunter + emerald-rush)',
    /risky-hunter/.test(configSource) && /emerald-rush/.test(configSource),
  )
  check(
    'client objective pool no longer contains steal objectives',
    !/resource-control|gold-robbery/.test(configSource),
  )
}

// --- 9) STEAL REMOVED -------------------------------------------------------
{
  check(
    'duo_steal_versioned is neutralized (returns ok:false / removed)',
    /duo_steal_versioned[\s\S]*?'removed'/.test(migration),
  )
  check(
    'duo_steal_versioned execute grant is revoked',
    /revoke[\s\S]*?duo_steal_versioned/i.test(migration),
  )
  check(
    'risky coin id base is 2000 on both server and client',
    /duo_risky_coin_id_base[\s\S]*?2000/.test(migration) &&
      /RISKY_COIN_ID_BASE\s*=\s*2000/.test(configSource),
  )
  check(
    'client spawn cadence matches the server (15s)',
    /RISKY_COIN_SPAWN_MS\s*=\s*15_000/.test(configSource),
  )
  check(
    'client lifetime matches the server (8s)',
    /RISKY_COIN_LIFETIME_MS\s*=\s*8_000/.test(configSource),
  )
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
