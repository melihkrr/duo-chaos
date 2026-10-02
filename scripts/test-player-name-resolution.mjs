import assert from 'node:assert/strict'
import { resolvePlayerName } from '../lib/playerName.ts'

assert.equal(resolvePlayerName('  New Name  ', 'Saved Name', 'Current Name'), 'New Name')
assert.equal(resolvePlayerName('', '  Saved Name  ', 'Stale State Name'), 'Saved Name')
assert.equal(resolvePlayerName('', '', '  Saved Name  '), 'Saved Name')
assert.equal(resolvePlayerName(undefined, '', null), '')

console.log('✔ Player name resolution prefers explicit, current, then persisted names.')
