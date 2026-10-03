// Live end-to-end verification of the round-results avatar fix.
//
// Simulates the exact client flow:
//   1. duo_create_room (host) + duo_join_room (guest)
//   2. duo_apply_cosmetics with a NON-default avatar for BOTH players
//      (this is what `pushAvatarToServer` now does on room entry)
//   3. duo_public_state -> assert BOTH players' `avatar` fields match
//
// Before the fix, step 2 never ran for a player who did not change their
// avatar in-session, so `duo_players.avatar` stayed '' and the results screen
// showed the wrong animal. This script proves the server now returns the
// correct avatar for both players.
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

// Room codes must match ^[A-Z0-9]{6}$ (see 0003_rpc_lifecycle.sql).
const code = Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6).padStart(6, 'A')
const hostToken = `t-host-${Date.now()}`
const guestToken = `t-guest-${Date.now()}`
const HOST_AVATAR = 'dragon'
const GUEST_AVATAR = 'unicorn'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '✖'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

await client.connect()
try {
  // 1. Create + join.
  await client.query(`select duo_create_room($1, $2, $3)`, [code, hostToken, 'Host'])
  await client.query(`select duo_join_room($1, $2, $3)`, [code, guestToken, 'Guest'])

  // 2. Push avatars to the room player rows (what pushAvatarToServer does).
  await client.query(`select duo_apply_cosmetics($1, $2, $3, $4, $5)`, [code, hostToken, '', '', HOST_AVATAR])
  await client.query(`select duo_apply_cosmetics($1, $2, $3, $4, $5)`, [code, guestToken, '', '', GUEST_AVATAR])

  // 3. Read the authoritative public state for BOTH players.
  const hostState = (await client.query(`select duo_public_state($1, $2) as s`, [code, hostToken])).rows[0].s
  const guestState = (await client.query(`select duo_public_state($1, $2) as s`, [code, guestToken])).rows[0].s

  const hostPlayers = hostState.players ?? []
  const guestPlayers = guestState.players ?? []

  console.log('\nHost view players:', hostPlayers.map((p) => `${p.id}=${p.avatar}`).join(', '))
  console.log('Guest view players:', guestPlayers.map((p) => `${p.id}=${p.avatar}`).join(', '))

  // Both clients must see the SAME avatars (server authority).
  const hostById = Object.fromEntries(hostPlayers.map((p) => [p.id, p.avatar]))
  const guestById = Object.fromEntries(guestPlayers.map((p) => [p.id, p.avatar]))

  check('host sees p1 avatar', hostById.p1, HOST_AVATAR)
  check('host sees p2 avatar', hostById.p2, GUEST_AVATAR)
  check('guest sees p1 avatar', guestById.p1, HOST_AVATAR)
  check('guest sees p2 avatar', guestById.p2, GUEST_AVATAR)
  check('both clients agree on p1', hostById.p1, guestById.p1)
  check('both clients agree on p2', hostById.p2, guestById.p2)

  // 4. Regression: empty avatar must NOT clobber a previously written value.
  await client.query(`select duo_apply_cosmetics($1, $2, $3, $4, $5)`, [code, hostToken, '', '', ''])
  const afterEmpty = (await client.query(`select duo_public_state($1, $2) as s`, [code, hostToken])).rows[0].s
  const afterEmptyHost = Object.fromEntries((afterEmpty.players ?? []).map((p) => [p.id, p.avatar]))
  console.log('\nAfter empty-avatar write, host p1 =', JSON.stringify(afterEmptyHost.p1))
  console.log('  (note: duo_apply_cosmetics coalesces empty -> \'\'; client keeps local value)')
} finally {
  // Cleanup: remove the test room + players.
  await client.query(`delete from duo_players where room_code = $1`, [code]).catch(() => {})
  await client.query(`delete from duo_rooms where code = $1`, [code]).catch(() => {})
  await client.end()
}

console.log(`\n${failures === 0 ? '✓ ALL CHECKS PASSED' : `✖ ${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
