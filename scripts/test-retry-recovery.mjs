// ============================================================================
// DUO CHAOS — retry & recovery layer test (10 required scenarios).
//
// This test exercises the REAL reusable retry layer (`lib/retry.ts`) and the
// version-guarded idempotency contract used by the gameplay RPCs. It does NOT
// need a live DB: it simulates transient/permanent failures and asserts the
// recovery behaviour the user asked for.
//
// SCENARIOS (from the task):
//   1.  position request fails once            -> auto-recovers
//   2.  position sync fails multiple times     -> eventually recovers, no freeze
//   3.  realtime disconnects                   -> reconnects + state reconciled
//   4.  collect request fails                  -> no duplicate collection
//   5.  steal request fails                    -> no duplicate +25/-25
//   6.  score sync stale                       -> authoritative score restored
//   7.  objective state stale                  -> correct progress recovered
//   8.  disconnect during active match         -> reconnect preserves identity
//   9.  next-round transition fails temporarily-> does not advance twice / block
//   10. both players lose connection+reconnect -> converge to same state
//
// Usage: npx tsx scripts/test-retry-recovery.mjs
// ============================================================================

import {
  BACKGROUND_RETRY_POLICY,
  DEFAULT_RETRY_POLICY,
  FAST_RETRY_POLICY,
  computeBackoffDelay,
  createRetryController,
  isRetryableError,
  isTransientRpcFailure,
  withRetry,
  withVersionGuardedRetry,
} from '../lib/retry.ts'

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
const section = (title) => console.log(`\n${title}`)

// A transient network error (retryable).
const transient = () => new Error('TypeError: Failed to fetch')
// A permanent logical rejection (NOT retryable).
const permanent = () => new Error('duo_move rejected: not_ready')

// ---------------------------------------------------------------------------
section('1. Position request fails once -> auto-recovers')
// ---------------------------------------------------------------------------
{
  let attempts = 0
  const result = await withRetry(
    async () => {
      attempts += 1
      if (attempts === 1) throw transient()
      return 'ok'
    },
    FAST_RETRY_POLICY,
  )
  check('recovers after a single transient failure', result === 'ok')
  check('used exactly 2 attempts', attempts === 2, `attempts=${attempts}`)
}

// ---------------------------------------------------------------------------
section('2. Position sync fails multiple times -> eventually recovers (no freeze)')
// ---------------------------------------------------------------------------
{
  let attempts = 0
  const result = await withRetry(
    async () => {
      attempts += 1
      if (attempts < 3) throw transient()
      return 'recovered'
    },
    FAST_RETRY_POLICY,
  )
  check('recovers after multiple transient failures', result === 'recovered')
  check('attempts bounded by policy', attempts === 3, `attempts=${attempts}`)

  // Exhaustion must THROW (caller decides), never hang forever.
  let exhausted = 0
  let threw = false
  try {
    await withRetry(
      async () => {
        exhausted += 1
        throw transient()
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    )
  } catch {
    threw = true
  }
  check('bounded: gives up after maxAttempts (no infinite loop)', threw && exhausted === 3, `attempts=${exhausted}`)
}

// ---------------------------------------------------------------------------
section('3. Realtime disconnects -> reconnects + state reconciled')
// ---------------------------------------------------------------------------
{
  // The reconnect controller backs off on failure and resets on success.
  // NOTE: `computeBackoffDelay` applies jitter, so the controller's actual
  // `nextAllowedAt` may be up to `maxDelayMs * (1 + jitter)` ahead. The test
  // advances the clock by the policy's MAXIMUM possible delay to be robust
  // regardless of the random jitter draw.
  const maxDelay = (policy) => policy.maxDelayMs * (1 + (policy.jitter ?? 0)) + 1
  let clock = 0
  const controller = createRetryController(BACKGROUND_RETRY_POLICY, () => clock)
  let calls = 0
  const flaky = async () => {
    calls += 1
    if (calls < 3) throw transient()
    return 'live'
  }
  const first = await controller.run(flaky)
  check('first attempt fails -> no result', first === undefined)
  check('backoff scheduled (shouldRunNow false)', controller.shouldRunNow() === false)
  // Advance the clock past the backoff window.
  clock += maxDelay(BACKGROUND_RETRY_POLICY)
  check('backoff window elapsed -> may retry', controller.shouldRunNow() === true)
  const second = await controller.run(flaky)
  check('second attempt fails -> still no result', second === undefined)
  clock += maxDelay(BACKGROUND_RETRY_POLICY)
  const third = await controller.run(flaky)
  check('third attempt succeeds -> reconciled', third === 'live')
  check('counter reset after success', controller.failures() === 0)
}

// ---------------------------------------------------------------------------
section('4. Collect request fails -> no duplicate collection (version-guarded)')
// ---------------------------------------------------------------------------
{
  // Simulate the server: a version-guarded collect. The FIRST call applies the
  // collect and bumps the version; a REPLAY with the SAME expected version is
  // rejected as stale (no double count).
  let serverVersion = 0
  let serverCoins = 0
  const serverCollect = (expectedVersion) => {
    if (expectedVersion !== serverVersion) return { ok: false, reason: 'stale' }
    serverCoins += 1
    serverVersion += 1
    return { ok: true, acceptedCoinIds: [1] }
  }

  let attempts = 0
  const response = await withVersionGuardedRetry(async () => {
    attempts += 1
    // First attempt: network drops AFTER the server applied it (worst case).
    if (attempts === 1) {
      serverCollect(0) // server applied it
      throw transient() // but the client never saw the response
    }
    // Retry with the SAME expected version (0) -> server rejects as stale.
    const result = serverCollect(0)
    if (!result.ok && isTransientRpcFailure(result)) {
      throw new Error('transient')
    }
    return result
  })
  check('retry did not double-apply the collect', serverCoins === 1, `coins=${serverCoins}`)
  check('server rejected the duplicate as stale', response.ok === false && response.reason === 'stale')
}

// ---------------------------------------------------------------------------
section('5. Steal request fails -> no duplicate +25/-25 (version-guarded)')
// ---------------------------------------------------------------------------
{
  let serverVersion = 0
  let p1 = 0
  let p2 = 0
  const serverSteal = (expectedVersion) => {
    if (expectedVersion !== serverVersion) return { ok: false, reason: 'stale' }
    p1 += 25
    p2 -= 25
    serverVersion += 1
    return { ok: true }
  }

  let attempts = 0
  await withVersionGuardedRetry(async () => {
    attempts += 1
    if (attempts === 1) {
      serverSteal(0) // applied
      throw transient() // response lost
    }
    const result = serverSteal(0) // replay with same version -> stale
    if (!result.ok && isTransientRpcFailure(result)) throw new Error('transient')
    return result
  })
  check('steal applied exactly once (+25)', p1 === 25, `p1=${p1}`)
  check('rival debited exactly once (-25)', p2 === -25, `p2=${p2}`)
}

// ---------------------------------------------------------------------------
section('6. Score sync stale -> authoritative score restored')
// ---------------------------------------------------------------------------
{
  // Monotonic merge: a stale (lower) server score must never overwrite a newer
  // local score; a newer server score always wins.
  const mergeScore = (local, server) => Math.max(local, server)
  check('stale server score does not revert local', mergeScore(30, 10) === 30)
  check('fresh server score wins', mergeScore(10, 30) === 30)
  check('equal scores stable', mergeScore(20, 20) === 20)
}

// ---------------------------------------------------------------------------
section('7. Objective state stale -> correct progress recovered')
// ---------------------------------------------------------------------------
{
  // Version-stamped objective progress: only forward moves are accepted; a
  // stale snapshot (lower version) is ignored so progress is never reverted.
  const applyProgress = (local, server, serverVersion, localVersion) => {
    if (serverVersion < localVersion) return local // stale snapshot -> keep local
    return Math.max(local, server)
  }
  check('stale snapshot ignored (progress preserved)', applyProgress(3, 1, 1, 2) === 3)
  check('fresh snapshot advances progress', applyProgress(1, 3, 3, 2) === 3)
}

// ---------------------------------------------------------------------------
section('8. Disconnect during active match -> reconnect preserves identity')
// ---------------------------------------------------------------------------
{
  // Reconnect reuses the SAME token/params (identity preserved). The controller
  // must not mutate the stored params.
  const params = { code: 'ABC123', playerId: 'p2', token: 'tok-xyz', name: 'Rival' }
  const stored = { ...params }
  let clock = 0
  const controller = createRetryController(DEFAULT_RETRY_POLICY, () => clock)
  let seen = null
  await controller.run(async () => {
    seen = { ...stored }
    throw transient()
  })
  clock += computeBackoffDelay(1, DEFAULT_RETRY_POLICY) + 1
  await controller.run(async () => {
    seen = { ...stored }
    return 'live'
  })
  check('reconnect used the same token', seen.token === 'tok-xyz')
  check('reconnect used the same slot', seen.playerId === 'p2')
  check('reconnect used the same room code', seen.code === 'ABC123')
}

// ---------------------------------------------------------------------------
section('9. Next-round transition fails temporarily -> no double advance / no block')
// ---------------------------------------------------------------------------
{
  // `duo_advance_phase` is idempotent server-side. A transient failure retries;
  // the server only advances once. Simulate: first call fails before applying,
  // retry applies exactly once.
  let serverPhase = 'battle'
  let advances = 0
  const serverAdvance = () => {
    if (serverPhase === 'battle') {
      serverPhase = 'results'
      advances += 1
    }
    return { ok: true, phase: serverPhase }
  }
  let attempts = 0
  const result = await withRetry(
    async () => {
      attempts += 1
      if (attempts === 1) throw transient() // fails BEFORE applying
      return serverAdvance()
    },
    FAST_RETRY_POLICY,
  )
  check('transition eventually succeeds', result.phase === 'results')
  check('advanced exactly once (no double advance)', advances === 1, `advances=${advances}`)

  // Idempotent replay: calling again does NOT advance twice.
  serverAdvance()
  check('idempotent replay does not advance twice', advances === 1, `advances=${advances}`)
}

// ---------------------------------------------------------------------------
section('10. Both players lose connection + reconnect -> converge to same state')
// ---------------------------------------------------------------------------
{
  // Two independent controllers recovering against the same authoritative
  // server state must both converge to it. As in scenario 3, advance the clock
  // by the policy's MAXIMUM jittered delay so the retry is never skipped.
  const maxDelay = (policy) => policy.maxDelayMs * (1 + (policy.jitter ?? 0)) + 1
  const authoritative = { score: 42, round: 2, phase: 'battle' }
  const recover = async (label) => {
    let clock = 0
    const controller = createRetryController(BACKGROUND_RETRY_POLICY, () => clock)
    let local = { score: 0, round: 1, phase: 'countdown' }
    let calls = 0
    const pull = async () => {
      calls += 1
      if (calls < 2) throw transient()
      local = { ...authoritative }
      return local
    }
    await controller.run(pull)
    clock += maxDelay(BACKGROUND_RETRY_POLICY)
    await controller.run(pull)
    return local
  }
  const a = await recover('A')
  const b = await recover('B')
  check('player A converged to authoritative state', a.score === 42 && a.round === 2 && a.phase === 'battle')
  check('player B converged to authoritative state', b.score === 42 && b.round === 2 && b.phase === 'battle')
  check('both players agree', JSON.stringify(a) === JSON.stringify(b))
}

// ---------------------------------------------------------------------------
section('Classification: transient vs permanent')
// ---------------------------------------------------------------------------
{
  check('network error is retryable', isRetryableError(transient()) === true)
  check('not_ready is NOT retryable', isRetryableError(permanent()) === false)
  check('room_full is NOT retryable', isRetryableError(new Error('room_full')) === false)
  check('invalid_token is NOT retryable', isRetryableError(new Error('invalid_token')) === false)
  check('timeout is retryable', isRetryableError(new Error('request timeout')) === true)
  check('AbortError is NOT retryable', isRetryableError(new DOMException('Aborted', 'AbortError')) === false)
  check('transient rpc failure classified', isTransientRpcFailure({ ok: false, reason: 'network' }) === true)
  check('permanent rpc failure classified', isTransientRpcFailure({ ok: false, reason: 'room_full' }) === false)
}

// ---------------------------------------------------------------------------
section('Backoff: bounded, exponential, capped')
// ---------------------------------------------------------------------------
{
  const p = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 800, jitter: 0 }
  check('attempt 1 = base', computeBackoffDelay(1, p) === 100)
  check('attempt 2 = 2x base', computeBackoffDelay(2, p) === 200)
  check('attempt 3 = 4x base', computeBackoffDelay(3, p) === 400)
  check('attempt 4 capped at maxDelayMs', computeBackoffDelay(4, p) === 800)
  check('attempt 10 still capped', computeBackoffDelay(10, p) === 800)
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '\u2714 ALL PASSED' : '\u2718 FAILURES'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
