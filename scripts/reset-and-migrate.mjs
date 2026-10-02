// ============================================================================
// Reset the DUO CHAOS schema and apply every migration in order.
//
// DESTRUCTIVE: drops all duo_* objects and their data, then replays every
// supabase/migrations/*.sql file in filename order. Do not use for routine
// upgrades of an existing project; apply only verified missing migrations.
//
// Usage:
//   set SUPABASE_DB_PASSWORD=... && node scripts/reset-and-migrate.mjs
//
// Env:
//   SUPABASE_DB_PASSWORD  (required)
//   SUPABASE_PROJECT_REF  (optional) — defaults to fanrtyidfhdhlaskwrid
//   SUPABASE_DB_HOST/PORT/USER (optional) — override the resolved endpoint
// ============================================================================

import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
if (!PASSWORD) {
  console.error('✖ SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const client = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: process.env.SUPABASE_DB_USER ?? `postgres.${PROJECT_REF}`,
  password: PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
})

await client.connect()
console.log('✔ Connected to Supabase Postgres')

// ---------------------------------------------------------------------------
// 1. Drop every duo_* object so the migrations start from a clean slate.
// ---------------------------------------------------------------------------
console.log('→ Dropping existing duo_* objects …')
await client.query(`
  do $$
  declare
    r record;
  begin
    -- Functions (all signatures).
    for r in
      select p.oid::regprocedure as sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'duo\\_%'
    loop
      execute 'drop function if exists ' || r.sig || ' cascade';
    end loop;

    -- Tables (cascades to indexes, constraints, triggers).
    for r in
      select tablename from pg_tables
       where schemaname = 'public' and tablename like 'duo\\_%'
    loop
      execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade';
    end loop;

    -- Enums.
    for r in
      select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typname like 'duo\\_%' and t.typtype = 'e'
    loop
      execute 'drop type if exists public.' || quote_ident(r.typname) || ' cascade';
    end loop;
  end $$;
`)
console.log('✔ Old duo_* objects dropped')

// ---------------------------------------------------------------------------
// 2. Apply every migration file in lexical order.
// ---------------------------------------------------------------------------
const migrationsDir = resolve(process.cwd(), 'supabase/migrations')
const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()

for (const file of files) {
  const sql = await readFile(resolve(migrationsDir, file), 'utf8')
  process.stdout.write(`→ Applying ${file} … `)
  try {
    await client.query('begin')
    await client.query(sql)
    await client.query('commit')
    console.log('ok')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    console.error(`FAILED\n✖ ${file}: ${message}`)
    await client.end().catch(() => {})
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// 3. Reload the PostgREST schema cache.
// ---------------------------------------------------------------------------
await client.query("notify pgrst, 'reload schema'")
console.log('✔ PostgREST schema cache reload requested')

// ---------------------------------------------------------------------------
// 4. Report the resulting surface.
// ---------------------------------------------------------------------------
const tables = await client.query(
  `select table_name from information_schema.tables
    where table_schema = 'public' and table_name like 'duo_%' order by table_name`,
)
console.log('\nTABLES:', tables.rows.map((r) => r.table_name).join(', '))

const fns = await client.query(
  `select p.proname, pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'duo_%'
    order by p.proname, args`,
)
console.log('FUNCTIONS:')
for (const fn of fns.rows) {
  console.log(`   • ${fn.proname}(${fn.args})`)
}

await client.end()
console.log('\n✔ Schema reset and all migrations applied.')
