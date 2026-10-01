import type { Coin, State } from './types'

export const markPendingCollect = (
  state: State,
  coinIds: readonly number[],
  actionRound: number,
): State => {
  if (state.round !== actionRound || coinIds.length === 0) return state

  const requested = new Set(coinIds)
  let changed = false
  const coins = state.coins.map((coin) => {
    if (!requested.has(coin.id) || coin.collectedBy || coin.pendingCollect) return coin
    changed = true
    return { ...coin, pendingCollect: true }
  })

  return changed ? { ...state, coins } : state
}

export const settlePendingCollect = (
  state: State,
  requestedIds: readonly number[],
  acceptedIds: readonly number[],
  respawnAt: number,
  actionRound: number,
): State => {
  if (state.round !== actionRound || requestedIds.length === 0) return state

  const requested = new Set(requestedIds)
  const accepted = new Set(acceptedIds)
  let changed = false
  const coins: Coin[] = state.coins.map((coin) => {
    if (!requested.has(coin.id)) return coin

    if (accepted.has(coin.id)) {
      changed = true
      return coin.type === 'diamond'
        ? { ...coin, collectedBy: 'p1', pendingCollect: false, respawnAt: undefined }
        : { ...coin, collectedBy: 'p1', pendingCollect: false, respawnAt }
    }

    if (!coin.pendingCollect) return coin
    changed = true
    return { ...coin, pendingCollect: false }
  })

  return changed ? { ...state, coins } : state
}
