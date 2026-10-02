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
    'translates the complete multiplayer leave confirmation subtitle',
    translateForLanguage("You'll return to the home screen. Your rival will be notified.", 'tr'),
    'Ana ekrana döneceksin. Rakibine haber verilecek.',
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
  description: 'Gold coins grant +25 points for 15s.',
  boost: 'Gold bonus +25',
}, 'tr')
assert.equal(event.name, 'Altına Hücum')
assert.equal(event.description, 'Altın paralar 15 saniye boyunca +25 puan kazandırır.')
console.log('✔ translates dynamic chaos-event content')

const doubleScore = localizedChaosEvent({
  id: 'double-score',
  name: 'Double Points',
  description: 'All standard coins are worth double for 15s.',
  boost: '2x coin points',
}, 'tr')
assert.equal(doubleScore.name, 'Çifte Puan')
assert.equal(doubleScore.description, '15 saniye boyunca standart paralar iki kat puan kazandırır.')
console.log('✔ translates new live chaos event content')
console.log('✔ ALL CHECKS PASSED — 7 localization checks')
