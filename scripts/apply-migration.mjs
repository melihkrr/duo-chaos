// ============================================================================
// Apply a SQL migration to the DUO CHAOS Supabase project.
//
// Usage:
//   node scripts/apply-migration.mjs supabase/migrations/0009_player_names.sql
//
// Credentials are read from the environment (never hard-coded):
//   SUPABASE_DB_PASSWORD   (required)  — the database password
//   SUPABASE_PROJECT_REF   (optional)  — defaults to fanrtyidfhdhlaskwrid
//   SUPABASE_DB_HOST       (optional)  — override the resolved host
//   SUPABASE_DB_PORT       (optional)  — override the resolved port
//
// The script tries the direct connection first, then the common pooler
// regions, so it works without knowing the project's region up front.
// ============================================================================

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
const DB_NAME = process.env.SUPABASE_DB_NAME ?? 'postgres'
const DB_USER = process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`

if (!PASSWORD) {
  console.error('✖ SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const fileArg = process.argv[2]
if (!fileArg) {
  console.error('✖ Usage: node scripts/apply-migration.mjs <path-to-sql>')
  process.exit(1)
}

const sqlPath = resolve(process.cwd(), fileArg)
const sql = await readFile(sqlPath, 'utf8')

// Candidate endpoints, tried in order. The direct host is fastest when the
// project allows IPv6/direct access; the pooler hosts cover the common regions.
const candidates = []
if (process.env.SUPABASE_DB_HOST) {
  candidates.push({
    label: 'env override',
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    user: process.env.SUPABASE_DB_USER ?? 'postgres',
  })
} else {
  candidates.push({
    label: 'direct',
    host: `db.${PROJECT_REF}.supabase.co`,
    port: 5432,
    user: 'postgres',
  })
  const regions = [
    'aws-0-us-east-1',
    'aws-0-us-east-2',
    'aws-0-us-west-1',
    'aws-0-eu-central-1',
    'aws-0-eu-west-1',
    'aws-0-eu-west-2',
    'aws-0-ap-southeast-1',
    'aws-0-ap-northeast-1',
    'aws-0-ap-south-1',
    'aws-0-sa-east-1',
  ]
  for (const region of regions) {
    candidates.push({
      label: `pooler ${region}`,
      host: `${region}.pooler.supabase.com`,
      port: 6543,
      user: DB_USER,
    })
    candidates.push({
      label: `pooler-session ${region}`,
      host: `${region}.pooler.supabase.com`,
      port: 5432,
      user: DB_USER,
    })
  }
}

const tryConnect = async (candidate) => {
  const client = new Client({
    host: candidate.host,
    port: candidate.port,
    user: candidate.user,
    password: PASSWORD,
    database: DB_NAME,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 30000,
  })
  await client.connect()
  return client
}

let client = null
let used = null
for (const candidate of candidates) {
  try {
    client = await tryConnect(candidate)
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
  console.log(`→ Applying ${fileArg} …`)
  await client.query('begin')
  await client.query(sql)
  await client.query("notify pgrst, 'reload schema'")
  await client.query('commit')
  console.log('✔ Migration applied and PostgREST schema cache reload requested.')

  // Verify the new RPC signatures exist.
  const { rows } = await client.query(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('duo_create_room', 'duo_join_room', 'duo_set_name')
      order by p.proname, args`,
  )
  console.log('✔ RPC signatures now present:')
  for (const row of rows) {
    console.log(`   • ${row.proname}(${row.args})`)
  }
} catch (error) {
  await client.query('rollback').catch(() => {})
  const message = error instanceof Error ? error.message : String(error)
  console.error(`✖ Migration failed: ${message}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
