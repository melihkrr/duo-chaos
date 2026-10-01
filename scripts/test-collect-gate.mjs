// ============================================================================
// DUO CHAOS — client collect-gate test (the "Collect 2 Red → 1/2" race).
//
// Reproduces the reported bug:
//   Objective "Collect 2 Red". The player collects 2 Red coins almost
//   simultaneously. Both are picked up, but progress becomes 1/2 instead of 2/2.
//
// ROOT CAUSE (fixed in lib/useGameLoop.ts):
//   The collect block was wrapped in a GLOBAL time gate:
//       if (now - lastAction.current >= ACTION_MS) { ... }
//   with ACTION_MS = 90. When two valid pickups happened in DIFFERENT frames
//   but within 90 ms of each other, the second frame's `collectedIds` was
//   FORCED empty: the coin was neither marked collected nor sent to the server
//   → one valid collection was LOST and the objective stuck at 1/2.
//
//   The gate was redundant: the `!coin.collectedBy` filter plus the
//   `collectedSet` marking already prevent re-collecting the same coin every
//   frame. The gate only ever dropped VALID pickups.
//
// FIX: removed the global time gate. EVERY frame evaluates nearby uncollected
//   coins. The server serializes concurrent collects atomically (migration
//   0039), so sending multiple coins — even in the same frame — is safe.
//
// This test mirrors the EXACT frame-loop collect logic (pre- and post-fix) and
// asserts that two red coins collected in different frames within the throttle
// window are BOTH counted.
//
// Run: node scripts/test-collect-gate.mjs
// ============================================================================

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    console.log(`  \u2718 ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const ACTION_MS = 90
const COLLECT_RADIUS = 9

// --- Mirror of the OLD (buggy) collect block: global 90 ms time gate. --------
// Returns the ids collected THIS frame. `lastAction` is the mutable gate state.
const collectFrameBuggy = (state, player, now, lastAction) => {
  let collectedIds = []
  if (now - lastAction.value >= ACTION_MS) {
    lastAction.value = now
    const nearby = state.coins.filter(
      (coin) =>
        !coin.collectedBy && Math.hypot(coin.x - player.x, coin.y - player.y) <= COLLECT_RADIUS,
    )
    if (nearby.length > 0) collectedIds = nearby.map((coin) => coin.id)
  }
  return collectedIds
}

// --- Mirror of the FIXED collect block: no time gate. ------------------------
const collectFrameFixed = (state, player) => {
  let collectedIds = []
  const nearby = state.coins.filter(
    (coin) => !coin.collectedBy && Math.hypot(coin.x - player.x, coin.y - player.y) <= COLLECT_RADIUS,
  )
  if (nearby.length > 0) collectedIds = nearby.map((coin) => coin.id)
  return collectedIds
}

// Apply a frame's collected ids to the coin list (mark collected).
const markCollected = (coins, ids) =>
  coins.map((coin) => (ids.includes(coin.id) ? { ...coin, collectedBy: 'p1' } : coin))

// Simulate the frame loop for a given collect function. Returns the total
// number of DISTINCT coins collected across all frames.
//
// `coin2At` is the frame time at which coin 2 enters COLLECT_RADIUS. Coin 1 is
// in range from the start. This models the real scenario: the player picks up
// coin 1, then a few frames later reaches coin 2 — both within 90 ms.
const simulate = (frames, collectFn, coin2At = 0) => {
  const coin2X = coin2At === 0 ? 505 : 900 // far away until `coin2At`
  let coins = [
    { id: 1, type: 'red', x: 500, y: 500, collectedBy: null },
    { id: 2, type: 'red', x: coin2X, y: 500, collectedBy: null },
  ]
  const player = { x: 500, y: 500 }
  // In the real loop `now` is a large performance.now() value, so the very
  // first frame always passes the gate. Model that with a large negative
  // starting value so frame 0 is allowed (and frame 16 is then blocked).
  const lastAction = { value: -1_000_000 }
  const collected = new Set()
  for (const now of frames) {
    // Coin 2 slides into range at `coin2At`.
    if (now >= coin2At && coin2At > 0) coins[1] = { ...coins[1], x: 505 }
    const ids = collectFn({ coins }, player, now, lastAction)
    for (const id of ids) collected.add(id)
    coins = markCollected(coins, ids)
  }
  return collected
}

const run = () => {
  // --------------------------------------------------------------------------
  // Scenario 1: two red coins picked up in DIFFERENT frames within 90 ms.
  // This is the exact user scenario ("almost simultaneously").
  // --------------------------------------------------------------------------
  console.log('Scenario 1: two red coins in different frames within 90 ms')
  const frames = [0, 16, 32] // 60fps: frame 0 collects coin 1, frame 16 coin 2
  // Coin 2 enters range at t=16 (within the 90 ms gate window).
  const buggy = simulate(frames, collectFrameBuggy, 16)
  const fixed = simulate(frames, collectFrameFixed, 16)
  console.log(`  buggy collected: ${[...buggy].sort().join(',') || '(none)'}`)
  console.log(`  fixed collected: ${[...fixed].sort().join(',') || '(none)'}`)
  check(
    'OLD gate DROPS the second coin (reproduces the bug)',
    buggy.size === 1,
    `collected ${buggy.size} (expected 1 to reproduce)`,
  )
  check(
    'FIXED loop collects BOTH red coins (2/2)',
    fixed.size === 2,
    `collected ${fixed.size} (expected 2)`,
  )

  // --------------------------------------------------------------------------
  // Scenario 2: both coins in the SAME frame (already worked before).
  // --------------------------------------------------------------------------
  console.log('\nScenario 2: both red coins in the same frame')
  const sameFrame = simulate([0], collectFrameFixed)
  check('FIXED loop collects both in one frame', sameFrame.size === 2, `collected ${sameFrame.size}`)

  // --------------------------------------------------------------------------
  // Scenario 3: the same coin must NOT be collected twice across frames
  // (the removed gate must not cause double-counting).
  // --------------------------------------------------------------------------
  console.log('\nScenario 3: no double-collection across frames')
  // Coin 1 stays in range for several frames; it must be collected exactly once.
  let coins = [{ id: 1, type: 'red', x: 500, y: 500, collectedBy: null }]
  const player = { x: 500, y: 500 }
  const seen = []
  for (const now of [0, 16, 32, 48, 64]) {
    const ids = collectFrameFixed({ coins }, player, now, { value: 0 })
    seen.push(...ids)
    coins = markCollected(coins, ids)
  }
  check(
    'coin collected exactly once despite being in range every frame',
    seen.length === 1 && seen[0] === 1,
    `collected ids: [${seen.join(', ')}]`,
  )

  // --------------------------------------------------------------------------
  // Scenario 4: rapid sequential pickups across many frames all count.
  // --------------------------------------------------------------------------
  console.log('\nScenario 4: 4 coins picked up across rapid consecutive frames')
  let coins4 = [
    { id: 1, type: 'red', x: 500, y: 500, collectedBy: null },
    { id: 2, type: 'red', x: 500, y: 500, collectedBy: null },
    { id: 3, type: 'red', x: 500, y: 500, collectedBy: null },
    { id: 4, type: 'red', x: 500, y: 500, collectedBy: null },
  ]
  const player4 = { x: 500, y: 500 }
  const collected4 = new Set()
  for (const now of [0, 16, 32, 48]) {
    const ids = collectFrameFixed({ coins: coins4 }, player4, now, { value: 0 })
    for (const id of ids) collected4.add(id)
    coins4 = markCollected(coins4, ids)
  }
  check('all 4 coins collected', collected4.size === 4, `collected ${collected4.size}`)

  console.log(
    `\n${failed === 0 ? '\u2714 ALL CHECKS PASSED' : '\u2716 FAILURES DETECTED'} — ${passed} passed, ${failed} failed`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

run()
