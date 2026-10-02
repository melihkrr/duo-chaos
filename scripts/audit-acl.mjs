// Audit function ACLs + table grants + RLS policies on the live DB.
// Usage: SUPABASE_DB_PASSWORD=... node scripts/audit-acl.mjs
import { Client } from 'pg'

const password = process.env.SUPABASE_DB_PASSWORD
if (!password) {
  console.error('SUPABASE_DB_PASSWORD is required')
  process.exit(1)
}

const candidates = [
  { host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: 'postgres.fanrtyidfhdhlaskwrid' },
  { host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, user: 'postgres.fanrtyidfhdhlaskwrid' },
  { host: 'db.fanrtyidfhdhlaskwrid.supabase.co', port: 5432, user: 'postgres' },
]

let client = null
for (const c of candidates) {
  try {
    const candidate = new Client({
      host: c.host,
      port: c.port,
      user: c.user,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    })
    await candidate.connect()
    client = candidate
    console.log(`connected via ${c.host}:${c.port}`)
    break
  } catch (error) {
    console.error(`failed ${c.host}:${c.port} -> ${error.message}`)
  }
}

if (!client) {
  console.error('could not connect')
  process.exit(1)
}

const q = async (label, sql) => {
  console.log(`\n===== ${label} =====`)
  const res = await client.query(sql)
  for (const row of res.rows) console.log(JSON.stringify(row))
}

await q(
  'FUNCTION_ACL',
  `select p.proname,
          pg_get_function_identity_arguments(p.oid) as args,
          coalesce(array_to_string(p.proacl, ' | '), '(default: PUBLIC EXECUTE)') as acl
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'duo_%'
    order by p.proname, args`,
)

await q(
  'TABLE_ACL',
  `select c.relname as table_name,
          coalesce(array_to_string(c.relacl, ' | '), '(default)') as acl
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'duo_%'
    order by c.relname`,
)

await q(
  'POLICIES',
  `select schemaname, tablename, policyname, roles, cmd, qual, with_check
     from pg_policies where schemaname = 'public' order by tablename, policyname`,
)

await q(
  'PUBLICATION_TABLES',
  `select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`,
)

await q(
  'TRIGGERS',
  `select event_object_table as table_name, trigger_name, action_timing, event_manipulation
     from information_schema.triggers
    where trigger_schema = 'public' and event_object_table like 'duo_%'
    order by event_object_table, trigger_name`,
)

await client.end()
console.log('\n✔ acl audit complete')
