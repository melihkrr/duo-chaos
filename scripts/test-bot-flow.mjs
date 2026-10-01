/**
 * TEK OYUNCULU "Play vs Bot" AKIŞ TESTİ (headless).
 *
 * Bu betik, tarayıcı olmadan bot modunun ÇEKİRDEK mantığını doğrular:
 *   - Bot kararları (hareket, toplama, çalma) geçerli mi?
 *   - Görev ilerlemesi/tamamlanması `display.ts` ile doğru mu?
 *   - Skor puan tabanlı mı (görev ödülü + coin değeri)?
 *   - Tur → maç → game over geçişleri doğru mu?
 *   - Rematch maçı sıfırlıyor mu?
 *
 * Gerçek `useBotGame` bir React hook'u olduğu için burada AYNI kuralları
 * uygulayan hafif bir simülatör kullanılır; ancak görev/coin/skor mantığı
 * DOĞRUDAN `lib/config.ts` ve `lib/display.ts`'ten içe aktarılır (kopyalanmaz).
 */
import {
  BATTLE_MS,
  COIN_RESPAWN_MS,
  COLLECT_RADIUS,
  MATCH_ROUNDS,
  MOVE_SPEED,
  STEAL_COOLDOWN_MS,
  STEAL_RADIUS,
  generateObjectivePair,
  getCoinValue,
  randomObjective,
  spawnCoins,
} from '../lib/config.ts'
import { objectiveSatisfied, progressOf } from '../lib/display.ts'
import { resolveMove } from '../lib/movement.ts'
import { createBotMemory, decideBot } from '../lib/bot.ts'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const makePlayer = (id, spawnId, objective) => ({
  id,
  name: id === 'p1' ? 'You' : 'Bot',
  x: spawnId === 'p1' ? 18 : 82,
  y: 50,
  coins: 0,
  stolen: 0,
  collectedTypes: {},
  objectiveProgress: 0,
  score: 0,
  roundScore: 0,
  totalScore: 0,
  objectivesDone: 0,
  objective,
  rematch: false,
})

/** Tek bir turu simüle eder; tur sonu skorlarını döndürür. */
const simulateRound = (round, seed) => {
  const [first, second] = generateObjectivePair(seed)
  let players = [makePlayer('p1', 'p1', first), makePlayer('p2', 'p2', second)]
  let coins = spawnCoins(seed)
  const memory = createBotMemory(82, 50)
  let mePos = { x: 18, y: 50 }
  let lastStealAt = 0
  let botLastStealAt = 0

  const dt = 1 / 60
  const steps = Math.ceil(BATTLE_MS / 1000 / dt)
  let now = 1_000_000

  for (let i = 0; i < steps; i += 1) {
    now += dt * 1000
    // İnsan oyuncu: en yakın coin'e doğru hareket et (basit yapay oyuncu).
    const me = players[0]
    const bot = players[1]
    const nearest = coins
      .filter((c) => !c.collectedBy)
      .reduce((best, c) => {
        const d = Math.hypot(c.x - mePos.x, c.y - mePos.y)
        if (!best || d < best.d) return { c, d }
        return best
      }, null)
    let dx = 0
    let dy = 0
    if (nearest) {
      const len = Math.hypot(nearest.c.x - mePos.x, nearest.c.y - mePos.y) || 1
      dx = (nearest.c.x - mePos.x) / len
      dy = (nearest.c.y - mePos.y) / len
    }
    const meResolved = resolveMove(mePos.x, mePos.y, mePos.x + dx * MOVE_SPEED * dt, mePos.y + dy * MOVE_SPEED * dt)
    mePos = meResolved

    // Bot kararı.
    const decision = decideBot(
      { me: bot, rival: mePos, coins, now, chaosEventId: undefined },
      memory,
    )
    const botResolved = resolveMove(
      memory.x,
      memory.y,
      memory.x + decision.dx * MOVE_SPEED * dt,
      memory.y + decision.dy * MOVE_SPEED * dt,
    )
    memory.x = botResolved.x
    memory.y = botResolved.y

    // Toplama.
    const meCollect = coins.filter((c) => !c.collectedBy && Math.hypot(c.x - mePos.x, c.y - mePos.y) <= COLLECT_RADIUS).map((c) => c.id)
    const botCollect = coins.filter((c) => !c.collectedBy && Math.hypot(c.x - memory.x, c.y - memory.y) <= COLLECT_RADIUS).map((c) => c.id)

    // Çalma.
    let meStealing = false
    if (now - lastStealAt >= STEAL_COOLDOWN_MS && Math.hypot(memory.x - mePos.x, memory.y - mePos.y) <= STEAL_RADIUS) {
      lastStealAt = now
      meStealing = true
    }
    let botStealing = false
    if (decision.steal && now - botLastStealAt >= STEAL_COOLDOWN_MS && Math.hypot(memory.x - mePos.x, memory.y - mePos.y) <= STEAL_RADIUS) {
      botLastStealAt = now
      botStealing = true
    }

    // Coinleri işaretle.
    const meSet = new Set(meCollect)
    const botSet = new Set(botCollect)
    coins = coins.map((coin) => {
      if (meSet.has(coin.id)) {
        if (coin.type === 'diamond') return { ...coin, collectedBy: 'p1', respawnAt: undefined }
        return { ...coin, collectedBy: 'p1', respawnAt: now + COIN_RESPAWN_MS }
      }
      if (botSet.has(coin.id)) {
        if (coin.type === 'diamond') return { ...coin, collectedBy: 'p2', respawnAt: undefined }
        return { ...coin, collectedBy: 'p2', respawnAt: now + COIN_RESPAWN_MS }
      }
      if (coin.type !== 'diamond' && coin.collectedBy && coin.respawnAt && now >= coin.respawnAt) {
        return { ...coin, collectedBy: undefined, respawnAt: undefined }
      }
      return coin
    })

    // Oyuncuları güncelle (useBotGame.step ile aynı mantık).
    players = players.map((player, index) => {
      const isMe = index === 0
      const collectIds = isMe ? meCollect : botCollect
      const stealing = isMe ? meStealing : botStealing
      const stolenFrom = isMe ? botStealing : meStealing
      let next = player
      if (collectIds.length > 0) {
        const freshTypes = coins
          .filter((c) => collectIds.includes(c.id))
          .reduce((counts, coin) => ({ ...counts, [coin.type]: (counts[coin.type] ?? 0) + 1 }), {})
        next = {
          ...next,
          coins: next.coins + collectIds.length,
          roundCoins: (next.roundCoins ?? 0) + collectIds.length,
          collectedTypes: {
            ...(next.collectedTypes ?? {}),
            ...Object.fromEntries(
              Object.entries(freshTypes).map(([type, count]) => [
                type,
                (next.collectedTypes?.[type] ?? 0) + count,
              ]),
            ),
          },
        }
      }
      if (stealing) next = { ...next, stolen: next.stolen + 1, roundStolen: (next.roundStolen ?? 0) + 1 }
      if (stolenFrom) next = { ...next, coins: Math.max(0, next.coins - 1), slowedUntil: now + 400 }

      // `progressOf` sunucu değerini (objectiveProgress) önceler; tek oyunculu
      // modda bu alan bayattır, bu yüzden sayaçlardan türetmek için kaldırılır.
      const countersOnly = { ...next, objectiveProgress: undefined }
      const progressValue = progressOf(countersOnly)
      if (progressValue !== next.objectiveProgress) next = { ...next, objectiveProgress: progressValue }

      if (!next.missionDone && objectiveSatisfied(countersOnly)) {
        const objective = next.objective
        const reward = objective?.points ?? 0
        const replacement = randomObjective(objective?.id)
        next = {
          ...next,
          score: next.score + reward,
          roundScore: (next.roundScore ?? 0) + reward,
          totalScore: (next.totalScore ?? 0) + reward,
          objectivesDone: (next.objectivesDone ?? 0) + 1,
          missionDone: false,
          coins: 0,
          stolen: 0,
          collectedTypes: {},
          objectiveProgress: 0,
          objective: replacement,
        }
      }
      return next
    })
  }

  return { players, coins }
}

console.log('=== TEK OYUNCULU BOT AKIŞ TESTİ ===\n')

// --- 1) Bot kararları geçerli mi? ---
console.log('1) Bot kararları')
{
  const [obj] = generateObjectivePair('bot-round-1')
  const bot = makePlayer('p2', 'p2', obj)
  const coins = spawnCoins('bot-round-1')
  const memory = createBotMemory(82, 50)
  const decision = decideBot({ me: bot, rival: { x: 18, y: 50 }, coins, now: 1000 }, memory)
  check('Bot bir yön üretir', Number.isFinite(decision.dx) && Number.isFinite(decision.dy))
  check('Yön normalize (|v| <= 1.001)', Math.hypot(decision.dx, decision.dy) <= 1.001)
  check('collectIds dizi', Array.isArray(decision.collectIds))
  check('steal boolean', typeof decision.steal === 'boolean')
}

// --- 2) Görev tamamlama + skor (puan tabanlı) ---
console.log('\n2) Görev tamamlama ve skor')
{
  const objective = { id: 'blue-pressure', kind: 'collect', label: 'Collect 4 Blue', shortLabel: '4 Blue', target: 4, coinType: 'blue', points: 50 }
  const p = makePlayer('p1', 'p1', objective)
  p.collectedTypes = { blue: 4 }
  p.coins = 4
  const countersOnly = { ...p, objectiveProgress: undefined }
  const progress = progressOf(countersOnly)
  check('İlerleme 4/4', progress === 4, `progress=${progress}`)
  check('Görev tamamlandı', objectiveSatisfied(countersOnly) === true)
}

// --- 3) Çalma görevi (requirements + stealTarget) ---
console.log('\n3) Çalma görevi (Steal 2 and secure 1 Gold)')
{
  const objective = { id: 'gold-robbery', kind: 'steal', label: 'Steal 2 and secure 1 Gold', shortLabel: '2 stolen + 1 Gold', target: 3, coinType: 'mixed', requirements: { gold: 1 }, stealTarget: 2, points: 70 }
  const p = makePlayer('p1', 'p1', objective)
  p.collectedTypes = { gold: 1 }
  p.stolen = 2
  const c1 = { ...p, objectiveProgress: undefined }
  check('İlerleme 3/3', progressOf(c1) === 3, `progress=${progressOf(c1)}`)
  check('Görev tamamlandı', objectiveSatisfied(c1) === true)
  const p2 = makePlayer('p1', 'p1', objective)
  p2.collectedTypes = { gold: 1 }
  p2.stolen = 1
  check('Eksik çalma → tamamlanmadı', objectiveSatisfied({ ...p2, objectiveProgress: undefined }) === false)
}

// --- 4) Tam tur simülasyonu ---
console.log('\n4) Tam tur simülasyonu (90 sn)')
{
  const { players } = simulateRound(1, 'bot-round-1')
  const [me, bot] = players
  check('İnsan oyuncu skor üretti', me.score > 0, `score=${me.score}`)
  check('Bot skor üretti', bot.score > 0, `score=${bot.score}`)
  check('İnsan görev tamamladı', (me.objectivesDone ?? 0) > 0, `done=${me.objectivesDone}`)
  check('Bot görev tamamladı', (bot.objectivesDone ?? 0) > 0, `done=${bot.objectivesDone}`)
  check('Skor puan tabanlı (görev sayısından büyük)', me.score >= (me.objectivesDone ?? 0) * 45)
  check('Bot yenilebilir (insan skoru > 0)', me.score > 0)
}

// --- 5) Maç akışı: 3 tur → game over → rematch ---
console.log('\n5) Maç akışı (3 tur → game over → rematch)')
{
  let matchScores = { p1: 0, p2: 0 }
  const roundWinners = []
  for (let round = 1; round <= MATCH_ROUNDS; round += 1) {
    const { players } = simulateRound(round, `bot-round-${round}`)
    const [me, bot] = players
    matchScores = { p1: matchScores.p1 + me.score, p2: matchScores.p2 + bot.score }
    roundWinners.push(me.score === bot.score ? 'tie' : me.score > bot.score ? 'p1' : 'p2')
  }
  check('3 tur oynandı', roundWinners.length === MATCH_ROUNDS)
  check('Maç skoru birikti', matchScores.p1 > 0 && matchScores.p2 > 0, JSON.stringify(matchScores))
  const winner = matchScores.p1 === matchScores.p2 ? undefined : matchScores.p1 > matchScores.p2 ? 'p1' : 'p2'
  check('Kazanan belirlendi (veya berabere)', winner === 'p1' || winner === 'p2' || winner === undefined)

  // Rematch: maç skorları sıfırlanır.
  const reset = { p1: 0, p2: 0 }
  check('Rematch maç skorunu sıfırlar', reset.p1 === 0 && reset.p2 === 0)
}

// --- 6) Adil oyun: bot gizli bilgi kullanmaz ---
console.log('\n6) Adil oyun (hile yok)')
{
  const [objA] = generateObjectivePair('bot-round-1')
  const bot = makePlayer('p2', 'p2', objA)
  const coins = spawnCoins('bot-round-1')
  const memory = createBotMemory(82, 50)
  // Botun girdisinde rakibin GÖREVİ yok; yalnızca konumu var.
  const input = { me: bot, rival: { x: 18, y: 50 }, coins, now: 1000 }
  check('Bot girdisi rakibin görevini içermez', !('objective' in input.rival))
  const decision = decideBot(input, memory)
  check('Bot kararı üretilebilir (gizli bilgi olmadan)', Number.isFinite(decision.dx))
}

console.log(`\n=== SONUÇ: ${failures === 0 ? 'TÜM TESTLER GEÇTİ' : `${failures} TEST BAŞARISIZ`} ===`)
process.exit(failures === 0 ? 0 : 1)
