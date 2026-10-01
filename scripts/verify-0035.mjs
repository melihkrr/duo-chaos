// ============================================================================
// Verify migration 0035 is live: duo_collect / duo_steal must return the
// authoritative post-action `state` object, and duo_collect must still
// increment round_coins (0034) and reroll immediately (0033).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/verify-0035.mjs
// ============================================================================

import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
const DB_NAME = process.env.SUPABASE_DB_NAME ?? 'postgres'
const DB_USER = process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`

if (!PASSWORD) {
  console.error('✖ SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const candidates = [
  { label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' },
  { label: 'pooler aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: DB_USER },
  { label: 'pooler-session aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, user: DB_USER },
]

const QUERY = `
  select proname,
         prosrc like '%''state''%' as has_state,
         prosrc like '%round_coins = coalesce(round_coins, 0) + 1%' as has_round_coins,
         prosrc like '%duo_reroll_objective%' as has_reroll
  from pg_proc
  where proname in ('duo_collect', 'duo_steal')
  order by proname;
`

let lastError
for (const candidate of candidates) {
  const client = new Client({
    host: candidate.host,
    port: candidate.port,
    user: candidate.user,
    password: PASSWORD,
    database: DB_NAME,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  })
  try {
    await client.connect()
    const { rows } = await client.query(QUERY)
    console.log(`✔ connected via ${candidate.label}`)
    for (const row of rows) {
      console.log(
        `  ${row.proname}: state=${row.has_state} round_coins=${row.has_round_coins} reroll=${row.has_reroll}`,
      )
    }
    const collect = rows.find((r) => r.proname === 'duo_collect')
    const steal = rows.find((r) => r.proname === 'duo_steal')
    const ok =
      collect?.has_state === true &&
      collect?.has_round_coins === true &&
      collect?.has_reroll === true &&
      steal?.has_state === true &&
      steal?.has_reroll === true
    console.log(ok ? '✔ 0035 VERIFIED' : '✖ 0035 NOT FULLY APPLIED')
    await client.end()
    process.exit(ok ? 0 : 1)
  } catch (error) {
    lastError = error
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

console.error('✖ could not connect to any endpoint:', lastError?.message)
process.exit(1)
