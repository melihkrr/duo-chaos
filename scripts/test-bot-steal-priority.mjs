import { strict as assert } from 'node:assert'
import { MOVE_SPEED, STEAL_RADIUS } from '../lib/config.ts'
import { createBotMemory, decideBot } from '../lib/bot.ts'
import { hitsObstacle, resolveMove } from '../lib/movement.ts'

const makeBot = (objective, overrides = {}) => ({
  id: 'p2',
  name: 'Bot',
  x: 12,
  y: 31,
  coins: 0,
  stolen: 0,
  score: 0,
  objective,
  rematch: false,
  ...overrides,
})

console.log('Bot prioritizes steal objectives and navigates around obstacles')
{
  const objective = {
    id: 'resource-control',
    kind: 'steal',
    label: 'Steal 3 from your rival',
    shortLabel: '3 stolen',
    target: 3,
  }
  const bot = makeBot(objective)
  const rival = { x: 47, y: 31 }
  const distractingCoin = { id: 91, x: 12, y: 48, type: 'red' }
  const memory = createBotMemory(bot.x, bot.y)
  memory.targetCoinId = distractingCoin.id
  memory.lastRetargetAt = 1_000

  let stealReached = false
  for (let frame = 0; frame < 900; frame += 1) {
    const decision = decideBot(
      { me: bot, rival, coins: [distractingCoin], now: 1_000 + frame * 16 },
      memory,
    )
    assert.equal(memory.targetCoinId, distractingCoin.id, 'steal pursuit should not retarget toward a coin')

    if (Math.hypot(memory.x - rival.x, memory.y - rival.y) <= STEAL_RADIUS) {
      assert.equal(decision.steal, true, 'bot should attempt a steal once in range and off cooldown')
      stealReached = true
      break
    }

    const length = Math.hypot(decision.dx, decision.dy)
    assert.ok(length > 0.01, 'bot should keep moving toward the rival')
    const next = resolveMove(
      memory.x,
      memory.y,
      memory.x + (decision.dx / length) * (MOVE_SPEED / 60),
      memory.y + (decision.dy / length) * (MOVE_SPEED / 60),
    )
    memory.x = next.x
    memory.y = next.y
    bot.x = memory.x
    bot.y = memory.y
    assert.equal(hitsObstacle(memory.x, memory.y), false, 'bot should not enter an obstacle')
  }

  assert.equal(stealReached, true, 'bot should route around the obstacle and get within steal range')
  console.log('✔ steal objective overrides a distracting coin and routes around the obstacle')
}

console.log('A combined steal-and-collect objective switches to coins after steals are complete')
{
  const objective = {
    id: 'gold-robbery',
    kind: 'steal',
    label: 'Steal 2 and secure 1 Gold',
    shortLabel: '2 stolen + 1 Gold',
    target: 3,
    stealTarget: 2,
    requirements: { gold: 1 },
  }
  const coin = { id: 92, x: 18, y: 65, type: 'gold' }
  const bot = makeBot(objective, {
    x: 18,
    y: 50,
    stolen: 2,
    objectiveProgress: 2,
    collectedTypes: {},
  })
  const memory = createBotMemory(bot.x, bot.y)
  memory.targetCoinId = coin.id
  memory.lastRetargetAt = 1_000

  const decision = decideBot(
    { me: bot, rival: { x: 82, y: 50 }, coins: [coin], now: 1_000 },
    memory,
  )
  assert.ok(decision.dy > 0.99, 'bot should pursue the outstanding Gold requirement')
  assert.equal(decision.steal, false, 'completed steal component should not trigger more pursuit')
  console.log('✔ bot resumes coin hunting after satisfying the steal component')
}

console.log('✔ ALL CHECKS PASSED — 2 steal-priority scenarios')
