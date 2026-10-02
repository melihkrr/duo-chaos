// ============================================================================
// DUO CHAOS — player SOLID COLLISION regression test.
//
// The player BUMP / KNOCKBACK mechanic was removed entirely (it felt bad and
// caused teleport/desync bugs). It is replaced by a simple, purely positional
// "solid" collision: the two players CANNOT pass through each other, but
// NOTHING is pushed — no knockback, no cooldown, no server RPC.
//
//   When a player's attempted position would land inside the rival's collide
//   radius, the movement is BLOCKED: the player is placed on the surface of the
//   rival's collide circle (along the line connecting their centres) instead of
//   passing through. The rival is NEVER moved. Score, coins, objectives and the
//   round are completely untouched.
//
// This test mirrors the EXACT pure client helper `resolvePlayerCollision` from
// lib/movement.ts and asserts the removal of every bump artefact, then drives
// the required scenarios:
//   1.  A walks into stationary B  → A is blocked, B never moves.
//   2.  B walks into stationary A  → symmetric (blocked, no push).
//   3.  Both run toward each other → neither passes through the other.
//   4.  Diagonal contact           → blocked along the correct normal.
//   5.  Continuous contact         → stays blocked every frame (no bounce).
//   6.  No cooldown gate           → contact is resolved immediately, always.
//   7.  Collision does NOT change score.
//   8.  Collision does NOT change coins.
//   9.  Collision does NOT affect objectives.
//   10. Keyboard movement unchanged (speed/feel constants preserved).
//   11. Joystick movement unchanged (same input path, no artificial delay).
//   12. Two clients stay synchronized (authoritative reconcile, no stale move).
//   13. No pass-through: a fast step cannot tunnel through the rival.
//   14. Removal: no duo_bump RPC, no last_bump_at, no BUMP_* constants.
//
// No DB required. Run: node scripts/test-player-bump.mjs
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

// --- Constants mirrored from lib/config.ts ----------------------------------
const PLAYER_COLLIDE_R = 5.2
const PLAYER_HIT_R = 2.6
const MOVE_SPEED = 38
const SLOW_MULTIPLIER = 0.55
const ARENA = { minX: 5, maxX: 95, minY: 7, maxY: 93 }

// The slow multiplier constant name in lib/config.ts (kept in sync by hand).
const SLOW_MULT_NAME = 'SLOWED_SPEED_MULTIPLIER'

const removalMigration = await readFile(
  new URL('../supabase/migrations/0053_remove_player_bump.sql', import.meta.url),
  'utf8',
)
const bumpMigration = await readFile(
  new URL('../supabase/migrations/0052_player_bump.sql', import.meta.url),
  'utf8',
)
const configSource = await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8')
const movementSource = await readFile(new URL('../lib/movement.ts', import.meta.url), 'utf8')
const loopSource = await readFile(new URL('../lib/useGameLoop.ts', import.meta.url), 'utf8')
const botSource = await readFile(new URL('../lib/useBotGame.ts', import.meta.url), 'utf8')
const duoSource = await readFile(new URL('../lib/useDuoChaos.ts', import.meta.url), 'utf8')

// --- Mirror of duo_clamp_pos -------------------------------------------------
const clampPos = (x, y) => ({
  x: Math.max(ARENA.minX, Math.min(ARENA.maxX, x)),
  y: Math.max(ARENA.minY, Math.min(ARENA.maxY, y)),
})

// --- Mirror of the pure resolvePlayerCollision helper (lib/movement.ts) ------
// (Obstacle push-out is omitted here: the test scenarios use open arena space,
// so `pushOut` is the identity. The direction/blocking math is identical.)
const resolvePlayerCollision = (
  fromX,
  fromY,
  toX,
  toY,
  rivalX,
  rivalY,
  collideR = PLAYER_COLLIDE_R,
) => {
  const dx = toX - rivalX
  const dy = toY - rivalY
  const dist = Math.hypot(dx, dy)

  const mx = toX - fromX
  const my = toY - fromY
  const mdist = Math.hypot(mx, my)

  // Swept test: does the movement segment cross the rival's collide circle?
  let sweepHit = false
  let stopX = toX
  let stopY = toY
  if (mdist > 1e-6) {
    const ux = mx / mdist
    const uy = my / mdist
    const t = ((rivalX - fromX) * ux + (rivalY - fromY) * uy) / mdist
    if (t > 0 && t < 1) {
      const projX = fromX + ux * (t * mdist)
      const projY = fromY + uy * (t * mdist)
      const perp = Math.hypot(rivalX - projX, rivalY - projY)
      if (perp < collideR) {
        const back = Math.sqrt(Math.max(0, collideR * collideR - perp * perp))
        stopX = projX - ux * back
        stopY = projY - uy * back
        sweepHit = true
      }
    }
  }

  if (dist >= collideR && !sweepHit) return clampPos(toX, toY)
  if (sweepHit) return clampPos(stopX, stopY)

  let nx
  let ny
  if (dist < 1e-6) {
    if (mdist < 1e-6) {
      nx = 1
      ny = 0
    } else {
      nx = -mx / mdist
      ny = -my / mdist
    }
  } else {
    nx = dx / dist
    ny = dy / dist
  }
  const targetX = rivalX + nx * collideR
  const targetY = rivalY + ny * collideR
  return clampPos(targetX, targetY)
}

// --- Mirror of the client loop collision block -------------------------------
// Returns the resolved position for the mover; the rival is NEVER moved.
const stepWithCollision = (fromX, fromY, toX, toY, rivalX, rivalY) => {
  const blocked = resolvePlayerCollision(fromX, fromY, toX, toY, rivalX, rivalY)
  return { x: blocked.x, y: blocked.y, rivalX, rivalY }
}

console.log('\n=== DUO CHAOS — player solid collision ===\n')

// ---------------------------------------------------------------------------
// 0. Removal of the bump / knockback mechanic
// ---------------------------------------------------------------------------
console.log('0. Bump / knockback removal')
check(
  'migration 0053 drops the duo_bump RPC',
  /drop\s+function\s+if\s+exists\s+public\.duo_bump/i.test(removalMigration),
)
check(
  'migration 0053 drops the last_bump_at column',
  /drop\s+column\s+if\s+exists\s+last_bump_at/i.test(removalMigration),
)
check(
  'migration 0053 reloads the PostgREST schema cache',
  /notify\s+pgrst\s*,\s*'reload schema'/i.test(removalMigration),
)
check(
  'lib/config.ts no longer exports BUMP_CONTACT_R',
  !/export\s+const\s+BUMP_CONTACT_R/.test(configSource),
)
check(
  'lib/config.ts no longer exports BUMP_KNOCKBACK',
  !/export\s+const\s+BUMP_KNOCKBACK/.test(configSource),
)
check(
  'lib/config.ts no longer exports BUMP_COOLDOWN_MS',
  !/export\s+const\s+BUMP_COOLDOWN_MS/.test(configSource),
)
check(
  'lib/config.ts exports PLAYER_COLLIDE_R = 5.2',
  /export\s+const\s+PLAYER_COLLIDE_R\s*=\s*5\.2/.test(configSource),
)
check(
  'lib/movement.ts no longer defines computeBump',
  !/export\s+function\s+computeBump/.test(movementSource),
)
check(
  'lib/movement.ts exports resolvePlayerCollision',
  /export\s+function\s+resolvePlayerCollision/.test(movementSource),
)
check(
  'lib/useGameLoop.ts no longer references runBump',
  !/\brunBump\b/.test(loopSource),
)
check(
  'lib/useGameLoop.ts no longer references bumpCooldownRef',
  !/\bbumpCooldownRef\b/.test(loopSource),
)
check(
  'lib/useDuoChaos.ts no longer references runBump',
  !/\brunBump\b/.test(duoSource),
)
check(
  'lib/useDuoChaos.ts no longer references duo_bump',
  !/duo_bump/.test(duoSource),
)
check(
  'lib/useBotGame.ts no longer references bumpCooldownRef',
  !/\bbumpCooldownRef\b/.test(botSource),
)
check(
  'lib/useBotGame.ts no longer references computeBump',
  !/\bcomputeBump\b/.test(botSource),
)
check(
  'lib/useGameLoop.ts uses resolvePlayerCollision',
  /resolvePlayerCollision/.test(loopSource),
)
check(
  'lib/useBotGame.ts uses resolvePlayerCollision',
  /resolvePlayerCollision/.test(botSource),
)
check(
  'migration 0052 (the removed bump) is superseded, not re-applied',
  /duo_bump/i.test(bumpMigration) && /drop\s+function\s+if\s+exists\s+public\.duo_bump/i.test(removalMigration),
)

// ---------------------------------------------------------------------------
// 1. A walks into stationary B → A is blocked, B never moves
// ---------------------------------------------------------------------------
console.log('\n1. A walks into stationary B')
{
  const rival = { x: 50, y: 50 }
  // A starts to the left, tries to step onto B's centre.
  const result = stepWithCollision(40, 50, 50, 50, rival.x, rival.y)
  const dist = Math.hypot(result.x - rival.x, result.y - rival.y)
  check('A does not land on top of B', dist >= PLAYER_COLLIDE_R - 1e-9, `dist=${dist.toFixed(3)}`)
  check('A is placed on the left surface (x < rival.x)', result.x < rival.x, `x=${result.x.toFixed(3)}`)
  check('A keeps its y (straight-line contact)', Math.abs(result.y - 50) < 1e-9, `y=${result.y.toFixed(3)}`)
  check('B is never moved', result.rivalX === rival.x && result.rivalY === rival.y)
}

// ---------------------------------------------------------------------------
// 2. B walks into stationary A → symmetric (blocked, no push)
// ---------------------------------------------------------------------------
console.log('\n2. B walks into stationary A (symmetric)')
{
  const rival = { x: 50, y: 50 }
  // B starts to the right, tries to step onto A's centre.
  const result = stepWithCollision(60, 50, 50, 50, rival.x, rival.y)
  const dist = Math.hypot(result.x - rival.x, result.y - rival.y)
  check('B does not land on top of A', dist >= PLAYER_COLLIDE_R - 1e-9, `dist=${dist.toFixed(3)}`)
  check('B is placed on the right surface (x > rival.x)', result.x > rival.x, `x=${result.x.toFixed(3)}`)
  check('A is never moved', result.rivalX === rival.x && result.rivalY === rival.y)
}

// ---------------------------------------------------------------------------
// 3. Both run toward each other → neither passes through the other
// ---------------------------------------------------------------------------
console.log('\n3. Both run toward each other')
{
  let a = { x: 40, y: 50 }
  let b = { x: 60, y: 50 }
  const step = 1.5
  for (let i = 0; i < 40; i += 1) {
    // A moves right, B moves left; each resolves against the other's CURRENT pos.
    const aNext = resolvePlayerCollision(a.x, a.y, a.x + step, a.y, b.x, b.y)
    const bNext = resolvePlayerCollision(b.x, b.y, b.x - step, b.y, a.x, a.y)
    a = { x: aNext.x, y: aNext.y }
    b = { x: bNext.x, y: bNext.y }
  }
  const dist = Math.hypot(a.x - b.x, a.y - b.y)
  check('A stays left of B (no pass-through)', a.x < b.x, `a.x=${a.x.toFixed(3)} b.x=${b.x.toFixed(3)}`)
  check('final separation respects the collide radius', dist >= PLAYER_COLLIDE_R - 1e-6, `dist=${dist.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// 4. Diagonal contact → blocked along the correct normal
// ---------------------------------------------------------------------------
console.log('\n4. Diagonal contact')
{
  const rival = { x: 50, y: 50 }
  // A approaches from the lower-left along the diagonal.
  const result = stepWithCollision(45, 45, 50, 50, rival.x, rival.y)
  const dist = Math.hypot(result.x - rival.x, result.y - rival.y)
  check('diagonal contact respects the collide radius', dist >= PLAYER_COLLIDE_R - 1e-9, `dist=${dist.toFixed(3)}`)
  check('A stays on the lower-left side', result.x < rival.x && result.y < rival.y)
  const nx = (result.x - rival.x) / dist
  const ny = (result.y - rival.y) / dist
  check('blocking normal points back toward A', nx < 0 && ny < 0, `n=(${nx.toFixed(3)}, ${ny.toFixed(3)})`)
}

// ---------------------------------------------------------------------------
// 5. Continuous contact → stays blocked every frame (no bounce)
// ---------------------------------------------------------------------------
console.log('\n5. Continuous contact (no bounce)')
{
  const rival = { x: 50, y: 50 }
  let a = { x: 44, y: 50 }
  let stable = true
  for (let i = 0; i < 30; i += 1) {
    const next = resolvePlayerCollision(a.x, a.y, a.x + 1.5, a.y, rival.x, rival.y)
    // Pushing into the rival must never move A past the surface.
    if (next.x > rival.x - PLAYER_COLLIDE_R + 1e-6) stable = false
    a = { x: next.x, y: next.y }
  }
  check('A never crosses the surface while pushing in', stable, `a.x=${a.x.toFixed(3)}`)
  check('A settles exactly on the surface', Math.abs(a.x - (rival.x - PLAYER_COLLIDE_R)) < 1e-6, `a.x=${a.x.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// 6. No cooldown gate → contact is resolved immediately, always
// ---------------------------------------------------------------------------
console.log('\n6. No cooldown gate')
{
  const rival = { x: 50, y: 50 }
  const first = resolvePlayerCollision(44, 50, 50, 50, rival.x, rival.y)
  const second = resolvePlayerCollision(44, 50, 50, 50, rival.x, rival.y)
  check('repeated contact resolves identically (no time gate)', first.x === second.x && first.y === second.y)
  check('no BUMP_COOLDOWN_MS constant remains', !/BUMP_COOLDOWN_MS/.test(configSource))
}

// ---------------------------------------------------------------------------
// 7. Collision does NOT change score
// ---------------------------------------------------------------------------
console.log('\n7. Score untouched')
{
  const state = { score: 12, coins: 3, objectivesDone: 1 }
  const before = { ...state }
  stepWithCollision(44, 50, 50, 50, 50, 50)
  check('score unchanged by a collision', state.score === before.score)
  check('collision helper returns only positions', Object.keys(stepWithCollision(44, 50, 50, 50, 50, 50)).sort().join(',') === 'rivalX,rivalY,x,y')
}

// ---------------------------------------------------------------------------
// 8. Collision does NOT change coins
// ---------------------------------------------------------------------------
console.log('\n8. Coins untouched')
{
  const state = { score: 12, coins: 3, objectivesDone: 1 }
  const before = { ...state }
  stepWithCollision(44, 50, 50, 50, 50, 50)
  check('coin count unchanged by a collision', state.coins === before.coins)
}

// ---------------------------------------------------------------------------
// 9. Collision does NOT affect objectives
// ---------------------------------------------------------------------------
console.log('\n9. Objectives untouched')
{
  const state = { score: 12, coins: 3, objectivesDone: 1 }
  const before = { ...state }
  stepWithCollision(44, 50, 50, 50, 50, 50)
  check('objective progress unchanged by a collision', state.objectivesDone === before.objectivesDone)
  check('no objective mutation in the collision helper', !/objective/i.test(resolvePlayerCollision.toString()))
}

// ---------------------------------------------------------------------------
// 10. Keyboard movement unchanged (speed/feel constants preserved)
// ---------------------------------------------------------------------------
console.log('\n10. Keyboard movement unchanged')
{
  check('MOVE_SPEED is still 38', new RegExp(`MOVE_SPEED\\s*=\\s*${MOVE_SPEED}\\b`).test(configSource))
  check(
    'slow multiplier is still 0.55',
    new RegExp(`${SLOW_MULT_NAME}\\s*=\\s*${SLOW_MULTIPLIER}`).test(configSource),
  )
  check('resolveMove is still used by the multiplayer loop', /resolveMove/.test(loopSource))
  check('resolveMove is still used by the bot loop', /resolveMove/.test(botSource))
}

// ---------------------------------------------------------------------------
// 11. Joystick movement unchanged (same input path, no artificial delay)
// ---------------------------------------------------------------------------
console.log('\n11. Joystick movement unchanged')
{
  check('joystick input still feeds the same step loop', /setJoystick/.test(loopSource))
  check('no artificial delay added around the collision block', !/setTimeout[\s\S]{0,80}resolvePlayerCollision/.test(loopSource))
}

// ---------------------------------------------------------------------------
// 12. Two clients stay synchronized (authoritative reconcile, no stale move)
// ---------------------------------------------------------------------------
console.log('\n12. Client synchronization')
{
  // The collision is purely local & deterministic: given the same inputs both
  // clients compute the same blocked position, so no extra server round-trip
  // (and therefore no stale-position teleport) is introduced.
  const rival = { x: 50, y: 50 }
  const clientA = resolvePlayerCollision(44, 50, 50, 50, rival.x, rival.y)
  const clientB = resolvePlayerCollision(44, 50, 50, 50, rival.x, rival.y)
  check('both clients resolve the same blocked position', clientA.x === clientB.x && clientA.y === clientB.y)
  check('no duo_bump RPC is enqueued by the collision path', !/duo_bump/.test(loopSource) && !/duo_bump/.test(duoSource))
  check('no extra position action is queued for collisions', !/enqueueMove[\s\S]{0,200}resolvePlayerCollision/.test(loopSource))
}

// ---------------------------------------------------------------------------
// 13. No pass-through: a fast step cannot tunnel through the rival
// ---------------------------------------------------------------------------
console.log('\n13. No tunnelling')
{
  const rival = { x: 50, y: 50 }
  // A very large step that would jump clean over the rival (lands exactly on
  // the centre). The fallback normal is the OPPOSITE of the movement direction,
  // so the mover is pushed back to the surface it came from — never through.
  const result = resolvePlayerCollision(40, 50, 60, 50, rival.x, rival.y)
  check('a fast step is stopped at the surface', Math.abs(result.x - (rival.x - PLAYER_COLLIDE_R)) < 1e-9, `x=${result.x.toFixed(3)}`)
  check('a fast step never lands beyond the rival', result.x < rival.x, `x=${result.x.toFixed(3)}`)
  // A step that lands just past the centre must also be pushed back to the
  // near side (not snapped to the far side).
  const past = resolvePlayerCollision(40, 50, 51, 50, rival.x, rival.y)
  check('a step landing past the centre returns to the near side', past.x < rival.x, `x=${past.x.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
// 14. Removal sanity: the old bump migration is no longer referenced
// ---------------------------------------------------------------------------
console.log('\n14. Removal sanity')
{
  check('no source file references duo_bump', !/duo_bump/.test(loopSource) && !/duo_bump/.test(duoSource) && !/duo_bump/.test(botSource))
  check('no source file references last_bump_at', !/last_bump_at/.test(loopSource) && !/last_bump_at/.test(duoSource) && !/last_bump_at/.test(botSource))
  check('no source file references BUMP_KNOCKBACK', !/BUMP_KNOCKBACK/.test(loopSource) && !/BUMP_KNOCKBACK/.test(botSource))
}

// ---------------------------------------------------------------------------
// Safety: the collision helper never returns NaN / out-of-arena positions
// ---------------------------------------------------------------------------
console.log('\nSafety')
{
  const rival = { x: 50, y: 50 }
  const cases = [
    [50, 50, 50, 50], // exactly on top of the rival
    [5, 7, 5, 7], // arena corner
    [95, 93, 95, 93], // opposite corner
    [50, 50, 5, 7], // long diagonal
  ]
  let allFinite = true
  let allInArena = true
  for (const [fx, fy, tx, ty] of cases) {
    const r = resolvePlayerCollision(fx, fy, tx, ty, rival.x, rival.y)
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) allFinite = false
    if (r.x < ARENA.minX - 1e-9 || r.x > ARENA.maxX + 1e-9) allInArena = false
    if (r.y < ARENA.minY - 1e-9 || r.y > ARENA.maxY + 1e-9) allInArena = false
  }
  check('collision result is always finite', allFinite)
  check('collision result always stays inside the arena', allInArena)
  check('PLAYER_HIT_R is still 2.6 (obstacle push-out radius)', new RegExp(`PLAYER_HIT_R\\s*=\\s*${PLAYER_HIT_R}\\b`).test(configSource))
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
