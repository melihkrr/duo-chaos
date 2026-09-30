/**
 * DUO CHAOS — real-browser end-to-end test against a live deployment.
 *
 * Opens two independent browser contexts (two "players"), creates a room in
 * one, joins it from the other, and walks the whole flow:
 *   home → create → lobby (name visibility both ways) → start → countdown →
 *   battle (movement + collect) → results → leave confirmation → URL sync.
 *
 * Usage:
 *   node scripts/e2e-live.mjs [baseUrl]
 * Default base URL: https://v0-duo-chaos.vercel.app
 */
import { chromium } from 'playwright'

const BASE = (process.argv[2] ?? 'https://v0-duo-chaos.vercel.app').replace(/\/$/, '')

let passed = 0
let failed = 0
const failures = []

const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  \u2714 ${label}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  \u2718 ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until `fn()` returns truthy, polling every 200ms up to `timeout` ms. */
const waitFor = async (fn, timeout = 15000, interval = 200) => {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) return null
    await sleep(interval)
  }
}

const run = async () => {
  console.log(`\nDUO CHAOS live E2E — ${BASE}\n`)

  const browser = await chromium.launch({ headless: true })
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const host = await hostCtx.newPage()
  const guest = await guestCtx.newPage()

  const consoleErrors = []
  const rpcLog = []
  for (const [name, page] of [
    ['host', host],
    ['guest', guest],
  ]) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[${name}] ${msg.text()}`)
      if (msg.text().includes('[duo]')) rpcLog.push(`[${name}] console: ${msg.text()}`)
    })
    page.on('pageerror', (err) => consoleErrors.push(`[${name}] pageerror: ${err.message}`))
    page.on('response', async (res) => {
      const url = res.url()
      if (!url.includes('/rest/v1/rpc/')) return
      const fn = url.split('/rpc/')[1]?.split('?')[0] ?? '?'
      let body = ''
      try {
        body = (await res.text()).slice(0, 200)
      } catch {
        /* ignore */
      }
      rpcLog.push(`[${name}] ${res.status()} ${fn} ${body}`)
    })
  }

  try {
    // ---------------------------------------------------------------- HOME
    await host.goto(BASE, { waitUntil: 'domcontentloaded' })
    await guest.goto(BASE, { waitUntil: 'domcontentloaded' })

    check('home loads (host)', await host.locator('h1', { hasText: 'DUO' }).isVisible())
    check('home loads (guest)', await guest.locator('h1', { hasText: 'DUO' }).isVisible())

    // ------------------------------------------------------- CREATE ROOM
    // Fill the controlled input, then wait for the button to become enabled
    // (it is gated on name length >= 2).
    const hostNameInput = host.getByLabel('Your display name')
    await hostNameInput.fill('Melih')
    const hostCreateBtn = host.getByRole('button', { name: /Create a game/i })
    await waitFor(() => hostCreateBtn.isEnabled(), 5000)
    await hostCreateBtn.click()

    const lobbyVisible = await waitFor(() => host.locator('.lobby').isVisible(), 20000)
    if (!lobbyVisible) {
      const errText = await host.locator('.error').first().textContent().catch(() => '')
      console.log(`    [debug] host error text: "${errText ?? ''}"`)
      console.log(`    [debug] host URL: ${host.url()}`)
      console.log('    [debug] console log:')
      for (const line of rpcLog) console.log(`      ${line}`)
      for (const line of consoleErrors) console.log(`      ERR ${line}`)
    }
    check('host reaches lobby after create', Boolean(lobbyVisible))

    // The room code lives in the URL (/play/CODE) — the `.room-code` element
    // renders "Room X8P7TV", so parse it from the pathname instead.
    const codeFromUrl = new URL(host.url()).pathname.match(/\/play\/([A-Za-z0-9]+)/)?.[1] ?? ''
    const code = codeFromUrl.toUpperCase()
    check('room code is 6 chars', /^[A-Z0-9]{6}$/.test(code), `got "${code}"`)

    // URL should now contain /play/CODE
    const hostUrl = host.url()
    check('host URL synced to /play/CODE', hostUrl.includes(`/play/${code}`), hostUrl)

    // Host's own name should be visible in the lobby
    const hostSeatName = await host.locator('.seat').first().locator('strong').textContent()
    check('host sees own name in lobby', (hostSeatName ?? '').includes('Melih'), `got "${hostSeatName}"`)

    // --------------------------------------------------------- JOIN ROOM
    const guestNameInput = guest.getByLabel('Your display name')
    await guestNameInput.fill('Ayse')
    const guestJoinBtn = guest.getByRole('button', { name: /Join with code/i })
    await waitFor(() => guestJoinBtn.isEnabled(), 5000)
    await guestJoinBtn.click()
    const codeInput = guest.locator('.code-input')
    await codeInput.waitFor({ state: 'visible', timeout: 10000 })
    await codeInput.fill(code)
    await guest.getByRole('button', { name: /Join game/i }).click()

    const guestLobby = await waitFor(() => guest.locator('.lobby').isVisible(), 20000)
    if (!guestLobby) {
      const errText = await guest.locator('.error, .form-error').first().textContent().catch(() => '')
      console.log(`    [debug] guest error text: "${errText ?? ''}"`)
      console.log(`    [debug] guest URL: ${guest.url()}`)
      console.log('    [debug] RPC log:')
      for (const line of rpcLog) console.log(`      ${line}`)
    }
    check('guest reaches lobby after join', Boolean(guestLobby))

    const guestUrl = guest.url()
    check('guest URL synced to /play/CODE', guestUrl.includes(`/play/${code}`), guestUrl)

    // ------------------------------------------- NAME VISIBILITY (BOTH)
    // Host should see the rival's name (Ayse) in the second seat.
    const hostSeesRival = await waitFor(async () => {
      const text = await host.locator('.seat').nth(1).textContent()
      return (text ?? '').includes('Ayse') ? text : null
    }, 15000)
    if (!hostSeesRival) {
      console.log('    [debug] RPC log (host+guest):')
      for (const line of rpcLog) console.log(`      ${line}`)
      const seat0 = await host.locator('.seat').nth(0).textContent().catch(() => '')
      const seat1 = await host.locator('.seat').nth(1).textContent().catch(() => '')
      console.log(`    [debug] host seat0="${seat0}" seat1="${seat1}"`)
    }
    check('host sees rival name (Ayse)', Boolean(hostSeesRival), `seat text: "${hostSeesRival}"`)

    // Guest should see the host's name (Melih) in the second seat.
    const guestSeesRival = await waitFor(async () => {
      const text = await guest.locator('.seat').nth(1).textContent()
      return (text ?? '').includes('Melih') ? text : null
    }, 15000)
    check('guest sees rival name (Melih)', Boolean(guestSeesRival), `seat text: "${guestSeesRival}"`)

    // Both seats should be marked "filled" (server playerCount === 2).
    const hostFilled = await host.locator('.seat.filled').count()
    check('host lobby shows 2 filled seats', hostFilled === 2, `got ${hostFilled}`)

    // ------------------------------------------------------- START MATCH
    const startBtn = host.getByRole('button', { name: /Start match/i })
    const startReady = await waitFor(() => startBtn.isEnabled(), 15000)
    check('host Start button enabled once rival is ready', Boolean(startReady))

    if (startReady) {
      await startBtn.click()
    }

    // Countdown → battle
    const battleVisible = await waitFor(() => host.locator('.battle-wrap').isVisible(), 20000)
    check('host enters battle', Boolean(battleVisible))

    const guestBattle = await waitFor(() => guest.locator('.battle-wrap').isVisible(), 20000)
    check('guest enters battle', Boolean(guestBattle))

    // HUD should show both names
    const hudText = (await host.locator('.hud').textContent()) ?? ''
    check('battle HUD shows host name', hudText.includes('Melih'), hudText.slice(0, 120))
    check('battle HUD shows rival name', hudText.includes('Ayse'), hudText.slice(0, 120))

    // ------------------------------------------------------ GAMEPLAY
    // The `.battle-wrap` element renders during the countdown too, so we must
    // wait for the phase to actually become "battle" (clock > 0) before
    // testing movement/collection. Poll the clock instead of a fixed sleep.
    const readClock = async () => {
      const text = await host.locator('.hud-clock').textContent().catch(() => '0')
      return parseInt((text ?? '0').replace(/[^0-9]/g, ''), 10)
    }
    // Wait until the battle phase is active (clock > 0).
    const clockReady = await waitFor(async () => {
      const value = await readClock()
      return value > 0 ? value : null
    }, 15000)
    // The clock must actually tick DOWN over time (not just be non-zero).
    const firstClock = await readClock()
    await sleep(1500)
    const secondClock = await readClock()
    check(
      'battle clock is counting down',
      Boolean(clockReady) && secondClock > 0 && secondClock < firstClock,
      `${firstClock}s -> ${secondClock}s`,
    )

    // Move the host avatar with the keyboard and confirm it changes position.
    // Focus the arena first so the window-level key listeners receive events.
    const avatarBefore = await host.locator('.avatar.me').getAttribute('style')
    await host.locator('.arena').click({ position: { x: 10, y: 10 } }).catch(() => {})
    await host.keyboard.down('ArrowRight')
    await sleep(900)
    await host.keyboard.up('ArrowRight')
    await host.keyboard.down('ArrowDown')
    await sleep(900)
    await host.keyboard.up('ArrowDown')
    const avatarAfter = await host.locator('.avatar.me').getAttribute('style')
    check('host avatar moves with keyboard', avatarBefore !== avatarAfter, `${avatarBefore} -> ${avatarAfter}`)

    // Coins should be rendered in the arena.
    const coinCount = await host.locator('.arena .coin').count()
    check('coins rendered in arena', coinCount > 0, `got ${coinCount}`)

    // Scout panel should be present and usable.
    const scoutVisible = await host.locator('.scout').isVisible()
    check('scout panel visible in battle', scoutVisible)

    // Emote button should trigger a glyph. The glyph only lives for ~1.6s, so
    // we install a DOM observer BEFORE clicking, then click, then read the flag.
    // This avoids missing the short-lived `.emote-pop` between polls.
    const emoteBtn = host.locator('.emote-btn')
    const emoteBtnCount = await emoteBtn.count()
    if (emoteBtnCount > 0) {
      await emoteBtn.scrollIntoViewIfNeeded().catch(() => {})
      await host.evaluate(() => {
        const w = window
        w.__duoEmoteSeen = false
        const observer = new MutationObserver(() => {
          if (document.querySelector('.emote-pop') || document.querySelector('.avatar-emote')) {
            w.__duoEmoteSeen = true
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
        w.__duoEmoteObserver = observer
      })
      await emoteBtn.click({ force: true })
      const glyph = await waitFor(
        async () => await host.evaluate(() => Boolean(window.__duoEmoteSeen)),
        3000,
        50,
      )
      await host.evaluate(() => {
        window.__duoEmoteObserver?.disconnect()
      })
      check('emote triggers a visual glyph', Boolean(glyph))
    } else {
      check('emote button visible', false, 'button not found')
    }

    // ---------------------------------------------- LEAVE CONFIRMATION
    // Click Leave in the top bar → confirmation dialog must appear.
    await host.getByRole('button', { name: /^Leave$/ }).click()
    const dialog = await waitFor(() => host.locator('.modal[role="dialog"]').isVisible(), 5000)
    check('leave confirmation dialog opens', Boolean(dialog))

    const dialogText = (await host.locator('.modal[role="dialog"]').textContent()) ?? ''
    check('dialog asks "Leave this game?"', dialogText.includes('Leave this game?'), dialogText.slice(0, 120))

    // Cancel → dialog closes, still in the game.
    await host.getByRole('button', { name: /^Stay$/ }).click()
    const dialogGone = await waitFor(async () => !(await host.locator('.modal[role="dialog"]').isVisible()), 5000)
    check('cancel closes dialog and stays in game', Boolean(dialogGone))
    check('still in battle after cancel', await host.locator('.battle-wrap').isVisible())

    // Confirm leave → returns home and URL resets to "/".
    await host.getByRole('button', { name: /^Leave$/ }).click()
    await waitFor(() => host.locator('.modal[role="dialog"]').isVisible(), 5000)
    await host.getByRole('button', { name: /Leave game/i }).click()

    const backHome = await waitFor(() => host.locator('.home').isVisible(), 10000)
    check('confirm leave returns to home', Boolean(backHome))

    const homeUrl = host.url()
    check('URL resets to root after leave', new URL(homeUrl).pathname === '/', homeUrl)

    // ------------------------------------------------- CONSOLE HEALTH
    // Filter out benign noise (favicon, analytics, network hiccups).
    const realErrors = consoleErrors.filter(
      (line) =>
        !/favicon/i.test(line) &&
        !/vercel\/insights/i.test(line) &&
        !/analytics/i.test(line) &&
        !/Failed to load resource/i.test(line) &&
        !/net::ERR_/i.test(line),
    )
    check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  } catch (err) {
    failed += 1
    failures.push(`exception: ${err.message}`)
    console.log(`  \u2718 exception — ${err.message}`)
  } finally {
    await browser.close()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

run()
