#!/usr/bin/env node
/**
 * DUO CHAOS — round-transition INPUT RESET regression test.
 *
 * Reproduces the exact scenario the user reported:
 *   "Oyuncu klavye/joystick ile hareket ederken round bitiyor. Yeni round
 *    başladığında oyuncu hiçbir tuşa basmıyor ama karakter son yönünde
 *    otomatik hareket etmeye devam ediyor."
 *
 * Root cause: movement input lives in long-lived refs / module singletons
 * (`keys`, `joystick`) that were NEVER cleared on a round transition, so the
 * last held direction leaked into the next round.
 *
 * This test statically verifies the fix is wired end-to-end:
 *   1. `lib/inputReset.ts` exists and exports the shared reset helpers.
 *   2. `useGameLoop` (multiplayer) resets keys+joystick on round advance,
 *      on non-battle phase exit, and installs visibility/blur listeners.
 *   3. `useBotGame` (single-player) does the same on beginRound + phase exit
 *      + round advance + visibility/blur.
 *   4. `VirtualJoystick` releases the pointer + zeroes the knob on
 *      visibility/blur/pagehide.
 *   5. No module-level `keys` singleton remains in `useGameLoop`.
 *
 * Run with:
 *   node scripts/test-input-reset.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let passes = 0
const check = (label, fn) => {
  fn()
  passes += 1
  console.log(`  \u2714 ${label}`)
}

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8')

const inputReset = await read('../lib/inputReset.ts')
const gameLoop = await read('../lib/useGameLoop.ts')
const botGame = await read('../lib/useBotGame.ts')
const joystick = await read('../components/game/VirtualJoystick.tsx')

console.log('\nDUO CHAOS input-reset regression test\n')

// --- 1. Shared utility -----------------------------------------------------
check('inputReset exports neutralKeys/resetKeys/resetJoystick/resetGamepads/resetAllInput/installInputResetListeners', () => {
  assert.match(inputReset, /export const neutralKeys/)
  assert.match(inputReset, /export const resetKeys/)
  assert.match(inputReset, /export const resetJoystick/)
  assert.match(inputReset, /export const resetGamepads/)
  assert.match(inputReset, /export const resetAllInput/)
  assert.match(inputReset, /export const installInputResetListeners/)
})

check('inputReset listens to blur + pagehide + visibilitychange', () => {
  assert.match(inputReset, /addEventListener\('blur'/)
  assert.match(inputReset, /addEventListener\('pagehide'/)
  assert.match(inputReset, /addEventListener\('visibilitychange'/)
})

check('resetAllInput zeroes keys + joystick and resets gamepads', () => {
  assert.match(inputReset, /resetKeys\(input\.keys\)/)
  assert.match(inputReset, /resetJoystick\(input\.joystick\)/)
  assert.match(inputReset, /resetGamepads\(\)/)
})

// --- 2. useGameLoop (multiplayer) -----------------------------------------
check('useGameLoop imports the shared reset helpers', () => {
  assert.match(gameLoop, /from '\.\/inputReset'/)
  assert.match(gameLoop, /installInputResetListeners/)
  assert.match(gameLoop, /resetAllInput/)
})

check('useGameLoop no longer uses a module-level `keys` singleton', () => {
  // The old bug: `const keys = { up: false, ... }` at module scope.
  assert.doesNotMatch(gameLoop, /^const keys = \{/m)
  // Now it is a per-hook ref.
  assert.match(gameLoop, /const keys = useRef<KeyState>\(neutralKeys\(\)\)/)
})

check('useGameLoop resets input on non-battle phase exit', () => {
  assert.match(
    gameLoop,
    /if \(state\.phase !== 'battle'\)[\s\S]{0,400}resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

check('useGameLoop resets input on round advance', () => {
  assert.match(
    gameLoop,
    /if \(roundAdvanced\)[\s\S]{0,300}resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

check('useGameLoop installs visibility/blur reset listeners', () => {
  assert.match(
    gameLoop,
    /installInputResetListeners\(\(\) => \{[\s\S]{0,200}resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

check('useGameLoop reads movement from keys.current (not a shared object)', () => {
  assert.match(gameLoop, /if \(keys\.current\.up\) dy -= 1/)
  assert.match(gameLoop, /if \(keys\.current\.down\) dy \+= 1/)
  assert.match(gameLoop, /if \(keys\.current\.left\) dx -= 1/)
  assert.match(gameLoop, /if \(keys\.current\.right\) dx \+= 1/)
})

// --- 3. useBotGame (single-player) ----------------------------------------
check('useBotGame imports the shared reset helpers', () => {
  assert.match(botGame, /from '\.\/inputReset'/)
  assert.match(botGame, /installInputResetListeners/)
  assert.match(botGame, /resetAllInput/)
})

check('useBotGame resets input inside beginRound', () => {
  assert.match(
    botGame,
    /const beginRound = useCallback\([\s\S]*?resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

check('useBotGame resets input on non-battle phase exit', () => {
  assert.match(
    botGame,
    /if \(prev\.phase !== 'battle'\)[\s\S]{0,300}resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

check('useBotGame resets input on round advance', () => {
  assert.match(
    botGame,
    /if \(lastRound\.current !== prev\.round\)[\s\S]{0,300}resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

check('useBotGame installs visibility/blur reset listeners', () => {
  assert.match(
    botGame,
    /installInputResetListeners\(\(\) => \{[\s\S]{0,200}resetAllInput\(\{ keys: keys\.current, joystick: joystick\.current \}\)/,
  )
})

// --- 4. VirtualJoystick ----------------------------------------------------
check('VirtualJoystick releases pointer + zeroes knob on visibility/blur/pagehide', () => {
  assert.match(joystick, /releasePointerCapture/)
  assert.match(joystick, /addEventListener\('blur'/)
  assert.match(joystick, /addEventListener\('pagehide'/)
  assert.match(joystick, /addEventListener\('visibilitychange'/)
  assert.match(joystick, /const release = \(\) => \{[\s\S]{0,400}end\(\)/)
})

check('VirtualJoystick end() zeroes the input vector', () => {
  assert.match(joystick, /const end = \(\) => \{[\s\S]{0,200}onChange\(0, 0\)/)
})

console.log(`\n\u2714 ${passes} input-reset checks passed.\n`)
