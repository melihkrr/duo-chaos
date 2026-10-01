import { strict as assert } from 'node:assert'
import {
  localizedChaosEvent,
  localizedObjectiveLabel,
  translateForLanguage,
} from '../lib/i18n.tsx'

const checks = [
  [
    'translates the name prompt and interpolates UI values',
    translateForLanguage('Room {code}', 'tr', { code: 'ABC234' }),
    'Oda ABC234',
  ],
  [
    'translates common server errors',
    translateForLanguage('This room already has two players. Ask your friend to leave, or create a new game.', 'tr'),
    'Bu odada zaten iki oyuncu var. Arkadaşından ayrılmasını iste veya yeni oyun oluştur.',
  ],
  [
    'keeps English locale text unchanged',
    translateForLanguage('Round {round} results', 'en', { round: 2 }),
    'Round 2 results',
  ],
  [
    'translates an objective by stable objective ID',
    localizedObjectiveLabel({ id: 'red-burn', label: 'Collect 2 Red + 1 Emerald' }, 'tr'),
    '2 Kırmızı + 1 Zümrüt Topla',
  ],
]

for (const [name, actual, expected] of checks) {
  assert.equal(actual, expected, name)
  console.log(`✔ ${name}`)
}

const event = localizedChaosEvent({
  id: 'gold-rush',
  name: 'Gold Rush',
  description: 'Gold spawns are boosted for 15s.',
  boost: 'Gold reward x3',
}, 'tr')
assert.equal(event.name, 'Altına Hücum')
assert.equal(event.description, '15 saniye boyunca daha fazla altın çıkar.')
console.log('✔ translates dynamic chaos-event content')
console.log('✔ ALL CHECKS PASSED — 5 localization checks')
