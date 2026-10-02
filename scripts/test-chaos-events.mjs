import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { CHAOS_EVENTS, chaosEventForRound, getCoinValue } from '../lib/config.ts'

const expectedIds = [
  'gold-rush',
  'blackout',
  'magnet',
  'swap',
  'jackpot',
  'double-score',
  'red-alert',
]

assert.deepEqual(CHAOS_EVENTS.map(({ id }) => id), expectedIds)
assert.equal(new Set(CHAOS_EVENTS.map(({ id }) => id)).size, expectedIds.length)

assert.equal(getCoinValue('gold', 'gold-rush'), 30)
assert.equal(getCoinValue('blue', 'double-score'), 10)
assert.equal(getCoinValue('blue', 'double-score', { coinType: 'blue' }), 30)
assert.equal(getCoinValue('emerald', 'double-score'), 50)
assert.equal(getCoinValue('diamond', 'double-score'), 50)
assert.equal(getCoinValue('red', 'red-alert'), 30)
assert.equal(getCoinValue('red', 'red-alert', { coinType: 'red' }), 40)
assert.equal(getCoinValue('blue', 'red-alert'), 5)

for (let index = 0; index < 100; index += 1) {
  const event = chaosEventForRound(`round-${index}`)
  assert.ok(expectedIds.includes(event.id), `unknown event selected: ${event.id}`)
}

const enumMigration = await readFile(
  new URL('../supabase/migrations/0043_add_score_chaos_events.sql', import.meta.url),
  'utf8',
)
const rulesMigration = await readFile(
  new URL('../supabase/migrations/0044_chaos_event_rules.sql', import.meta.url),
  'utf8',
)
const publicStateMigration = await readFile(
  new URL('../supabase/migrations/0045_restore_avatar_in_public_state.sql', import.meta.url),
  'utf8',
)
const translations = await readFile(new URL('../lib/i18n.tsx', import.meta.url), 'utf8')
assert.match(enumMigration, /add value if not exists 'double-score'/)
assert.match(enumMigration, /add value if not exists 'red-alert'/)
assert.match(rulesMigration, /p_chaos = 'double-score'/)
assert.match(rulesMigration, /p_chaos = 'red-alert' and p_type = 'red'/)
assert.match(rulesMigration, /when 'double-score' then 'Double Points'/)
assert.match(rulesMigration, /when 'red-alert' then 'Red Alert'/)
assert.match(rulesMigration, /before update of objective on duo_players/)
assert.match(rulesMigration, /new\.objective_progress := 0/)
assert.match(translations, /'All standard coins are worth double for 15s\.'/)
assert.match(translations, /'Red coins grant \+25 bonus points for 15s\.'/)
assert.match(publicStateMigration, /'avatar', p\.avatar/)
const serverEvents = rulesMigration.match(/events duo_chaos_event\[\] := array\[([\s\S]*?)\]::duo_chaos_event\[\]/)
assert.ok(serverEvents, 'server event rotation is defined')
assert.deepEqual(
  [...serverEvents[1].matchAll(/'([^']+)'/g)].map(([, id]) => id),
  expectedIds,
  'server and client event rotations must match',
)

console.log('✔ event catalog and selection cover every live event')
console.log('✔ event bonuses match coin, target, emerald, and diamond scoring')
console.log('✔ database scoring, event metadata, objective resets, and translations stay wired')
console.log('✔ ALL CHECKS PASSED — chaos event checks')
