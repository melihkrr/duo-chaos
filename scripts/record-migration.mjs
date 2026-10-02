// ============================================================================
// Record a migration version in supabase_migrations.schema_migrations.
//
// Usage:
//   node scripts/record-migration.mjs 0052 self_sufficient_steal_sample
//
// Credentials are read from the environment (never hard-coded):
//   SUPABASE_DB_PASSWORD   (required)
//   SUPABASE_PROJECT_REF   (optional) — defaults to fanrtyidfhdhlaskwrid
//   SUPABASE_DB_USER       (optional) — defaults to postgres.<project-ref>
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

const version = process.argv[2]
const name = process.argv[3] ?? ''
if (!version) {
  console.error('✖ Usage: node scripts/record-migration.mjs <version> [name]')
  process.exit(1)
}

const candidates = [
  { label: 'pooler us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: DB_USER },
  { label: 'pooler eu-central-1', host: 'aws-0-eu-central-1.pooler.supabase.com', port: 6543, user: DB_USER },
  { label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' },
]

let client = null
let used = null
for (const candidate of candidates) {
  try {
    const next = new Client({
      host: candidate.host,
      port: candidate.port,
      user: candidate.user,
      password: PASSWORD,
      database: DB_NAME,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      statement_timeout: 30000,
    })
    await next.connect()
    client = next
    used = candidate
    break
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`· ${candidate.label} (${candidate.host}:${candidate.port}) → ${message}`)
  }
}

if (!client || !used) {
  console.error('✖ Could not connect to any Supabase Postgres endpoint.')
  process.exit(1)
}

console.log(`✔ Connected via ${used.label} (${used.host}:${used.port})`)

try {
  await client.query(
    `insert into supabase_migrations.schema_migrations (version, name)
       values ($1, $2)
       on conflict (version) do update set name = excluded.name`,
    [version, name],
  )
  const { rows } = await client.query(
    'select version from supabase_migrations.schema_migrations order by version',
  )
  console.log(`✔ Recorded ${version} (${name}).`)
  console.log(`✔ Ledger: ${rows.map((row) => row.version).join(',')}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`✖ Failed to record migration: ${message}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
