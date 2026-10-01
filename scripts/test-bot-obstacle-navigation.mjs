import { strict as assert } from 'node:assert'
import { MOVE_SPEED } from '../lib/config.ts'
import { createBotMemory, decideBot } from '../lib/bot.ts'
import { hitsObstacle, resolveMove } from '../lib/movement.ts'

const scenarios = [
  { name: 'first obstacle', start: { x: 12, y: 31 }, target: { x: 47, y: 31 } },
  { name: 'second obstacle', start: { x: 50, y: 69 }, target: { x: 92, y: 69 } },
]

for (const scenario of scenarios) {
  const coin = { id: 1, ...scenario.target, type: 'gold' }
  const memory = createBotMemory(scenario.start.x, scenario.start.y)
  memory.targetCoinId = coin.id
  memory.lastRetargetAt = 1_000
  const player = {
    id: 'bot',
    name: 'Bot',
    ...scenario.start,
    coins: 0,
    stolen: 0,
    score: 0,
    objective: null,
    rematch: false,
  }

  let reachedCoin = false
  for (let frame = 0; frame < 600; frame += 1) {
    const decision = decideBot(
      { me: player, rival: null, coins: [coin], now: 1_000 + frame * 16 },
      memory,
    )
    if (decision.collectIds.includes(coin.id)) {
      reachedCoin = true
      break
    }

    const length = Math.hypot(decision.dx, decision.dy)
    if (length > 0.01) {
      const step = (MOVE_SPEED / 60)
      const next = resolveMove(
        memory.x,
        memory.y,
        memory.x + (decision.dx / length) * step,
        memory.y + (decision.dy / length) * step,
      )
      memory.x = next.x
      memory.y = next.y
    }
    player.x = memory.x
    player.y = memory.y
    assert.equal(hitsObstacle(memory.x, memory.y), false, `${scenario.name}: bot entered an obstacle`)
  }

  assert.equal(reachedCoin, true, `${scenario.name}: bot failed to reach the coin`)
  console.log(`✔ ${scenario.name}: bot routes around the obstacle and reaches its target`)
}

console.log('✔ ALL CHECKS PASSED — 2 obstacle navigation scenarios')
