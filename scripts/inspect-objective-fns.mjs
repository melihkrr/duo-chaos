// Inspect the LIVE definitions of the objective-progress functions so we can
// confirm exactly what the server computes (vs. what the migrations claim).
//
// Usage: SUPABASE_DB_PASSWORD=... node scripts/inspect-objective-fns.mjs
import { Client } from 'pg'

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'fanrtyidfhdhlaskwrid'
const PASSWORD = process.env.SUPABASE_DB_PASSWORD
if (!PASSWORD) {
  console.error('✖ SUPABASE_DB_PASSWORD is required.')
  process.exit(1)
}

const candidates = [
  { label: 'pooler aws-0-us-east-1', host: 'aws-0-us-east-1.pooler.supabase.com', port: 6543, user: `postgres.${PROJECT_REF}` },
  { label: 'pooler aws-0-us-east-1:5432', host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, user: `postgres.${PROJECT_REF}` },
  { label: 'direct', host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres' },
]

let client = null
for (const c of candidates) {
  try {
    const cl = new Client({
      host: c.host,
      port: c.port,
      user: c.user,
      password: PASSWORD,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      statement_timeout: 30000,
    })
    await cl.connect()
    client = cl
    console.log(`✔ connected via ${c.label}`)
    break
  } catch (e) {
    console.log(`· ${c.label} → ${e.message}`)
  }
}
if (!client) {
  console.error('✖ could not connect')
  process.exit(1)
}

const names = ['duo_mission_progress', 'duo_mission_satisfied', 'duo_public_state', 'duo_collect', 'duo_reroll_objective']
for (const name of names) {
  const { rows } = await client.query('select prosrc from pg_proc where proname = $1 limit 1', [name])
  console.log(`\n===== ${name} =====`)
  console.log(rows[0]?.prosrc ?? '(not found)')
}

await client.end()
