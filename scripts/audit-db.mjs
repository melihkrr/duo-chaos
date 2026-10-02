// ============================================================================
// DUO CHAOS — full live-database audit dump.
//
// Dumps the ACTUAL live schema (tables, columns, constraints, indexes, FKs,
// RLS policies, functions with signatures + source) so it can be compared
// against the local migrations and the frontend RPC contracts.
//
// Usage: node scripts/audit-db.mjs [section]
//   sections: tables | functions | policies | all (default)
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

const section = process.argv[2] ?? 'all'

const candidates = []
if (process.env.SUPABASE_DB_HOST) {
  candidates.push({
    label: 'env override',
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    user: process.env.SUPABASE_DB_USER ?? 'postgres',
  })
} else {
  candidates.push({ label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' })
  const regions = [
    'aws-0-us-east-1', 'aws-0-us-east-2', 'aws-0-us-west-1',
    'aws-0-eu-central-1', 'aws-0-eu-west-1', 'aws-0-eu-west-2',
    'aws-0-ap-southeast-1', 'aws-0-ap-northeast-1', 'aws-0-ap-south-1', 'aws-0-sa-east-1',
  ]
  for (const region of regions) {
    candidates.push({ label: `pooler ${region}`, host: `${region}.pooler.supabase.com`, port: 6543, user: DB_USER })
    candidates.push({ label: `pooler-session ${region}`, host: `${region}.pooler.supabase.com`, port: 5432, user: DB_USER })
  }
}

let client = null
for (const c of candidates) {
  const attempt = new Client({
    host: c.host, port: c.port, user: c.user, password: PASSWORD, database: DB_NAME,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
  })
  try {
    await attempt.connect()
    client = attempt
    console.log(`✔ connected via ${c.label} (${c.host}:${c.port})`)
    break
  } catch (error) {
    try { await attempt.end() } catch {}
  }
}

if (!client) {
  console.error('✖ could not connect to any candidate endpoint')
  process.exit(1)
}

const q = async (label, sql) => {
  const { rows } = await client.query(sql)
  console.log(`\n===== ${label} =====`)
  for (const row of rows) console.log(JSON.stringify(row))
  return rows
}

if (section === 'all' || section === 'tables') {
  await q('TABLES', `
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name`)
  await q('COLUMNS', `
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position`)
  await q('CONSTRAINTS', `
    select tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name,
           ccu.table_name as foreign_table, ccu.column_name as foreign_column
    from information_schema.table_constraints tc
    left join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    left join information_schema.constraint_column_usage ccu
      on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    where tc.table_schema = 'public'
    order by tc.table_name, tc.constraint_type, tc.constraint_name`)
  await q('INDEXES', `
    select tablename, indexname, indexdef from pg_indexes
    where schemaname = 'public' order by tablename, indexname`)
}

if (section === 'all' || section === 'functions') {
  await q('FUNCTIONS', `
    select p.proname, pg_get_function_identity_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as returns, p.prosecdef as security_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' order by p.proname`)
}

if (section === 'all' || section === 'policies') {
  await q('RLS_ENABLED', `
    select relname, relrowsecurity from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`)
  await q('POLICIES', `
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname = 'public' order by tablename, policyname`)
  await q('GRANTS', `
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon','authenticated','service_role','public')
    order by table_name, grantee, privilege_type`)
}

await client.end()
console.log('\n✔ audit dump complete')
