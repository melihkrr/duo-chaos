import { COIN_RESPAWN_MS } from './config'
import type { Coin } from './types'

type PickupCoin = Pick<Coin, 'id' | 'type' | 'collectedBy'>

export const claimSinglePlayerPickupIds = (
  coins: readonly PickupCoin[],
  candidateIds: readonly number[],
  now: number,
  claimed: Map<number, number | null>,
): number[] => {
  const coinsById = new Map(coins.map((coin) => [coin.id, coin]))

  for (const [coinId, respawnAt] of claimed) {
    const coin = coinsById.get(coinId)
    if (respawnAt !== null && now >= respawnAt && coin && !coin.collectedBy) {
      claimed.delete(coinId)
    }
  }

  const uniqueIds = new Set<number>()
  const claimedIds: number[] = []
  for (const coinId of candidateIds) {
    if (uniqueIds.has(coinId)) continue
    uniqueIds.add(coinId)
    const coin = coinsById.get(coinId)
    if (!coin || coin.collectedBy || claimed.has(coinId)) continue

    claimed.set(
      coinId,
      coin.type === 'diamond' ? null : now + COIN_RESPAWN_MS,
    )
    claimedIds.push(coinId)
  }

  return claimedIds
}
