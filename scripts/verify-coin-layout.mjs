// ============================================================================
// Verify that the server `duo_spawn_coins` layout EXACTLY matches the client
// `spawnCoins()` layout for a given seed.
//
// Usage:
//   set SUPABASE_DB_PASSWORD=... && node scripts/verify-coin-layout.mjs
//
// It computes the client layout in JS (mirroring lib/config.ts) and the server
// layout by calling `duo_spawn_coins` inside a transaction that is rolled back,
// then compares every coin's x/y/type.
// ============================================================================

import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
if (!PASSWORD) {
  console.error('✖ SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const COIN_TYPES = ['gold', 'blue', 'red', 'emerald']
const COIN_COUNT = 14

// --- Client algorithm (mirror of lib/config.ts spawnCoins) -------------------
const spawnCoins = (seed) => {
  const hash = (value) => {
    let h = 2166136261
    for (let i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  let state = hash(seed) || 1
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  const cols = 5
  const rows = 3
  const cells = Array.from({ length: cols * rows }, (_, i) => i)
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[cells[i], cells[j]] = [cells[j], cells[i]]
  }
  return Array.from({ length: COIN_COUNT }, (_, i) => {
    const cell = cells[i % cells.length]
    const col = cell % cols
    const row = Math.floor(cell / cols)
    return {
      id: i,
      x: 12 + col * 19 + (next() * 6 - 3),
      y: 16 + row * 30 + (next() * 8 - 4),
      // Round-robin types (mirror of lib/config.ts + migration 0036).
      type: COIN_TYPES[i % COIN_TYPES.length] ?? 'gold',
    }
  })
}

const round4 = (n) => Math.round(n * 10000) / 10000

const client = new Client({
  host: 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  user: `postgres.${PROJECT_REF}`,
  password: PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const seeds = ['TEST01:1', 'TEST01:2', 'TEST01:3', 'ABC123:1', 'round-1']

await client.connect()
let failures = 0
for (const seed of seeds) {
  const expected = spawnCoins(seed)
  // Create a throwaway room row so duo_spawn_coins can read round_seed, then
  // call it and read the coins back — all inside a rolled-back transaction.
  await client.query('begin')
  try {
    await client.query(
      `insert into duo_rooms (code, phase, round, round_seed)
       values ($1, 'lobby', 1, $2)
       on conflict (code) do update set round_seed = excluded.round_seed`,
      ['ZZZZZZ', seed],
    )
    await client.query('select duo_spawn_coins($1)', ['ZZZZZZ'])
    const { rows } = await client.query(
      'select coin_id, x, y, type from duo_coins where room_code = $1 order by coin_id',
      ['ZZZZZZ'],
    )
    let ok = rows.length === expected.length
    const diffs = []
    for (let i = 0; i < expected.length && ok; i += 1) {
      const e = expected[i]
      const r = rows[i]
      const same =
        Number(r.coin_id) === e.id &&
        round4(Number(r.x)) === round4(e.x) &&
        round4(Number(r.y)) === round4(e.y) &&
        r.type === e.type
      if (!same) {
        ok = false
        diffs.push({ i, expected: e, server: r })
      }
    }
    if (ok) {
      console.log(`✔ seed "${seed}" — ${rows.length} coins match exactly`)
    } else {
      failures += 1
      console.error(`✖ seed "${seed}" — MISMATCH`)
      console.error('  expected:', JSON.stringify(expected.slice(0, 3)))
      console.error('  server  :', JSON.stringify(rows.slice(0, 3)))
      if (diffs.length) console.error('  first diff:', JSON.stringify(diffs[0]))
    }
  } finally {
    await client.query('rollback')
  }
}

await client.end()
if (failures > 0) {
  console.error(`\n✖ ${failures} seed(s) mismatched.`)
  process.exit(1)
}
console.log('\n✔ All seeds match — server and client coin layouts are identical.')
