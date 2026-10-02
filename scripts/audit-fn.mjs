// Dump the source of one or more live functions.
// Usage: node scripts/audit-fn.mjs duo_collect_batch duo_steal_versioned ...
import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
if (!PASSWORD) { console.error('✖ SUPABASE_DB_PASSWORD is required.'); process.exit(1) }

const names = process.argv.slice(2)
if (names.length === 0) { console.error('✖ pass at least one function name'); process.exit(1) }

const client = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`,
  password: PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000, statement_timeout: 60000,
})
await client.connect()

for (const name of names) {
  const { rows } = await client.query(
    `select p.oid::regprocedure as sig, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
      order by p.oid`, [name])
  for (const row of rows) {
    console.log(`\n\n########## ${row.sig} ##########\n`)
    console.log(row.def)
  }
}
await client.end()
