// ============================================================================
// Live verification of migration 0038: "Steal 2 and secure 1 Gold" must count
// steals toward objective progress.
//
// Usage: set SUPABASE_DB_PASSWORD=... && node scripts/verify-0038.mjs
// ============================================================================
import pg from 'pg'

const password = process.env.SUPABASE_DB_PASSWORD
if (!password) {
  console.error('SUPABASE_DB_PASSWORD is required')
  process.exit(1)
}

const client = new pg.Client({
  host: 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  user: 'postgres.fanrtyidfhdhlaskwrid',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const objective = {
  id: 'gold-robbery',
  kind: 'steal',
  label: 'Steal 2 and secure 1 Gold',
  target: 3,
  coinType: 'mixed',
  requirements: { gold: 1 },
  stealTarget: 2,
}

let passed = 0
let failed = 0
const check = (label, cond) => {
  if (cond) {
    passed += 1
    console.log(`  ✔ ${label}`)
  } else {
    failed += 1
    console.log(`  ✖ ${label}`)
  }
}

try {
  await client.connect()
  console.log('✔ connected via pooler aws-0-us-east-1\n')

  const cases = [
    { collected: {}, stolen: 0, coins: 0, expected: 0, label: '0 stolen, 0 gold → 0/3' },
    { collected: {}, stolen: 1, coins: 0, expected: 1, label: '1 steal → 1/3 (steal counts!)' },
    { collected: {}, stolen: 2, coins: 0, expected: 2, label: '2 steals → 2/3' },
    { collected: { gold: 1 }, stolen: 2, coins: 1, expected: 3, label: '2 steals + 1 Gold → 3/3' },
    { collected: { gold: 1 }, stolen: 0, coins: 1, expected: 1, label: '1 Gold only → 1/3' },
    { collected: {}, stolen: 5, coins: 0, expected: 2, label: '5 steals → 2/3 (capped at stealTarget)' },
    { collected: { gold: 3 }, stolen: 2, coins: 3, expected: 3, label: '3 Gold + 2 steals → 3/3 (capped)' },
  ]

  for (const c of cases) {
    const res = await client.query(
      'select duo_mission_progress($1::jsonb, $2::jsonb, $3, $4) as p',
      [JSON.stringify(objective), JSON.stringify(c.collected), c.stolen, c.coins],
    )
    const got = res.rows[0].p
    check(`${c.label} (server=${got})`, got === c.expected)
  }

  // Satisfaction checks.
  const sat = async (collected, stolen, coins) => {
    const res = await client.query(
      'select duo_mission_satisfied($1::jsonb, $2::jsonb, $3, $4) as s',
      [JSON.stringify(objective), JSON.stringify(collected), stolen, coins],
    )
    return res.rows[0].s
  }
  check('NOT satisfied: 2 steals, 0 Gold', (await sat({}, 2, 0)) === false)
  check('NOT satisfied: 1 Gold, 1 steal', (await sat({ gold: 1 }, 1, 1)) === false)
  check('satisfied: 2 steals + 1 Gold', (await sat({ gold: 1 }, 2, 1)) === true)
  check('satisfied: 3 steals + 1 Gold', (await sat({ gold: 1 }, 3, 1)) === true)

  console.log(`\n${failed === 0 ? '✔ ALL CHECKS PASSED' : '✖ FAILURES'} — ${passed} passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('✖ verification failed:', err.message)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
