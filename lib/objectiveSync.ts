import type { Phase, Player, State } from './types'

export const shouldRetryRematch = (phase: Phase, locallyReady: boolean): boolean =>
  phase === 'matchover' && locallyReady

export const shouldIgnoreStalePhaseSnapshot = (
  currentPhase: Phase,
  currentRound: number,
  serverPhase: Phase,
  serverRound: number,
): boolean => {
  if (serverRound >= currentRound) return false
  return !(currentPhase === 'matchover' && serverPhase === 'lobby')
}

export type ObjectiveProgressFields = Pick<
  Player,
  'coins' | 'stolen' | 'roundCoins' | 'roundStolen' | 'collectedTypes' | 'objectiveProgress'
>

export type AuthoritativeActionState = Partial<Pick<
  Player,
  | 'objective'
  | 'objectiveProgress'
  | 'collectedTypes'
  | 'coins'
  | 'stolen'
  | 'roundCoins'
  | 'roundStolen'
  | 'missionDone'
  | 'objectivesDone'
  | 'score'
  | 'roundScore'
>>

// ÇALINANIN OTORİTER DURUMU: sunucu `duo_steal_versioned` yanıtında döner.
// Yalnızca puan/coin alanlarını taşır (çalınanın GÖREVİ çalmadan etkilenmez).
// Çalan istemci bunu `steal` yayınıyla rakibe iletir; çalınan istemci kendi
// -25'ini ANINDA ve OTORİTER uygular (bayat yoklamaya bağımlı kalmaz).
export type AuthoritativeVictimState = Partial<Pick<
  Player,
  'coins' | 'roundCoins' | 'score' | 'roundScore'
>>

export const isRpcSuccess = (response: unknown): response is { ok: true } =>
  typeof response === 'object' && response !== null && 'ok' in response && response.ok === true

export const runAfterPositionSync = async (
  syncPosition: () => Promise<void>,
  actions: Array<() => Promise<void>>,
  positionIncludedInAction = false,
): Promise<void> => {
  if (!positionIncludedInAction) await syncPosition()
  let failed = false
  let firstError: unknown
  await Promise.all(
    actions.map(async (action) => {
      try {
        await action()
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }),
  )
  if (failed) throw firstError
}

type PositionQueueTask =
  | { kind: 'move'; run: () => Promise<void>; onError: (error: unknown) => void }
  | {
      kind: 'actions'
      run: () => Promise<void>
      resolve: () => void
      reject: (error: unknown) => void
    }

export const createPositionActionQueue = () => {
  const tasks: PositionQueueTask[] = []
  let running = false

  const drain = async () => {
    while (tasks.length > 0) {
      const task = tasks.shift()
      if (!task) continue

      try {
        await task.run()
        if (task.kind === 'actions') task.resolve()
      } catch (error) {
        if (task.kind === 'actions') task.reject(error)
        else {
          try {
            task.onError(error)
          } catch (reportingError) {
            console.error('Failed to report position sync error', reportingError)
          }
        }
      }
    }
    running = false
  }

  const start = () => {
    if (running) return
    running = true
    void drain()
  }

  return {
    enqueueMove: (run: () => Promise<void>, onError: (error: unknown) => void) => {
      const lastTask = tasks[tasks.length - 1]
      if (lastTask?.kind === 'move') {
        lastTask.run = run
        lastTask.onError = onError
      } else {
        tasks.push({ kind: 'move', run, onError })
      }
      start()
    },
    runActions: (run: () => Promise<void>, positionIncludedInAction = false) =>
      new Promise<void>((resolve, reject) => {
        if (positionIncludedInAction) {
          // The action transaction writes its own latest position, so queued
          // movement snapshots before it are redundant and add another RTT.
          for (let index = tasks.length - 1; index >= 0; index -= 1) {
            if (tasks[index]?.kind === 'move') tasks.splice(index, 1)
          }
        }
        tasks.push({ kind: 'actions', run, resolve, reject })
        start()
      }),
  }
}

export const mergeObjectiveProgress = (
  local: Player,
  server: Partial<Player>,
  objectiveChanged: boolean,
): ObjectiveProgressFields => {
  const serverDone =
    typeof server.objectivesDone === 'number' && Number.isFinite(server.objectivesDone)
      ? server.objectivesDone
      : undefined
  const localDone =
    typeof local.objectivesDone === 'number' && Number.isFinite(local.objectivesDone)
      ? local.objectivesDone
      : 0

  if (serverDone !== undefined && serverDone < localDone) {
    return {
      coins: local.coins,
      stolen: local.stolen,
      roundCoins: local.roundCoins,
      roundStolen: local.roundStolen,
      collectedTypes: local.collectedTypes ?? {},
      objectiveProgress: local.objectiveProgress ?? 0,
    }
  }

  if (objectiveChanged) {
    return {
      coins: server.coins ?? local.coins,
      stolen: server.stolen ?? local.stolen,
      roundCoins: server.roundCoins ?? local.roundCoins,
      roundStolen: server.roundStolen ?? local.roundStolen,
      collectedTypes: server.collectedTypes ?? {},
      objectiveProgress: server.objectiveProgress ?? 0,
    }
  }

  const serverProgress =
    typeof server.objectiveProgress === 'number' && Number.isFinite(server.objectiveProgress)
      ? server.objectiveProgress
      : undefined
  const localProgress =
    typeof local.objectiveProgress === 'number' && Number.isFinite(local.objectiveProgress)
      ? local.objectiveProgress
      : 0

  return {
    coins: server.coins ?? local.coins,
    stolen: server.stolen ?? local.stolen,
    roundCoins: server.roundCoins ?? local.roundCoins,
    roundStolen: server.roundStolen ?? local.roundStolen,
    collectedTypes: server.collectedTypes ?? local.collectedTypes ?? {},
    objectiveProgress:
      serverProgress === undefined ? localProgress : Math.max(localProgress, serverProgress),
  }
}

export const applyAuthoritativeActionState = (
  previous: State,
  server: AuthoritativeActionState,
  completedProgress: number | undefined,
  actionRound: number,
): State => {
  if (previous.round !== actionRound) return previous

  const local = previous.players[0]
  if (!local) return previous

  const serverDone =
    typeof server.objectivesDone === 'number' && Number.isFinite(server.objectivesDone)
      ? server.objectivesDone
      : undefined
  const localDone =
    typeof local.objectivesDone === 'number' && Number.isFinite(local.objectivesDone)
      ? local.objectivesDone
      : 0
  const nextObjective = server.objective ?? local.objective
  const objectiveChanged = (nextObjective?.id ?? null) !== (local.objective?.id ?? null)
  const serverProgress =
    typeof server.objectiveProgress === 'number' && Number.isFinite(server.objectiveProgress)
      ? server.objectiveProgress
      : undefined
  const localProgress =
    typeof local.objectiveProgress === 'number' && Number.isFinite(local.objectiveProgress)
      ? local.objectiveProgress
      : 0

  // A response from before a completed objective (or a lower progress value
  // for the same objective) must not roll authoritative state back.
  if (serverDone !== undefined && serverDone < localDone) return previous
  if (!objectiveChanged && serverProgress !== undefined && serverProgress < localProgress) {
    return previous
  }

  const objectiveProgress =
    completedProgress !== undefined
      ? Math.max(localProgress, completedProgress)
      : objectiveChanged
        ? (serverProgress ?? 0)
        : serverProgress === undefined
          ? localProgress
          : Math.max(localProgress, serverProgress)
  const showCompleted = completedProgress !== undefined

  const players = previous.players.map((player, index) => {
    if (index !== 0) return player
    return {
      ...player,
      objective: showCompleted ? player.objective : nextObjective,
      objectiveProgress,
      collectedTypes: server.collectedTypes ?? player.collectedTypes,
      coins: server.coins ?? player.coins,
      stolen: server.stolen ?? player.stolen,
      roundCoins: server.roundCoins ?? player.roundCoins,
      roundStolen: server.roundStolen ?? player.roundStolen,
      missionDone: server.missionDone ?? player.missionDone,
      objectivesDone: server.objectivesDone ?? player.objectivesDone,
      score:
        server.score === undefined
          ? player.score
          : Math.max(player.score ?? 0, server.score),
      roundScore:
        server.roundScore === undefined
          ? player.roundScore
          : Math.max(player.roundScore ?? 0, server.roundScore),
    }
  })

  return { ...previous, players }
}

export const applyAuthoritativeRivalState = (
  previous: State,
  server: AuthoritativeActionState,
  actionRound: number,
): State => {
  if (previous.round !== actionRound) return previous

  const local = previous.players[1]
  if (!local) return previous

  const serverDone =
    typeof server.objectivesDone === 'number' && Number.isFinite(server.objectivesDone)
      ? server.objectivesDone
      : undefined
  const localDone =
    typeof local.objectivesDone === 'number' && Number.isFinite(local.objectivesDone)
      ? local.objectivesDone
      : 0
  if (serverDone !== undefined && serverDone < localDone) return previous

  const objective = server.objective ?? local.objective
  const objectiveChanged = (objective?.id ?? null) !== (local.objective?.id ?? null)
  const serverProgress =
    typeof server.objectiveProgress === 'number' && Number.isFinite(server.objectiveProgress)
      ? server.objectiveProgress
      : undefined
  const localProgress =
    typeof local.objectiveProgress === 'number' && Number.isFinite(local.objectiveProgress)
      ? local.objectiveProgress
      : 0
  if (!objectiveChanged && serverProgress !== undefined && serverProgress < localProgress) {
    return previous
  }

  const progress = mergeObjectiveProgress(local, server, objectiveChanged)
  const players = previous.players.map((player, index) => {
    if (index !== 1) return player
    return {
      ...player,
      objective,
      objectiveProgress: progress.objectiveProgress,
      collectedTypes: progress.collectedTypes,
      coins: progress.coins,
      stolen: progress.stolen,
      roundCoins: progress.roundCoins,
      roundStolen: progress.roundStolen,
      missionDone: objectiveChanged
        ? (server.missionDone ?? false)
        : Boolean(player.missionDone || server.missionDone),
      objectivesDone: serverDone ?? player.objectivesDone,
      score:
        server.score === undefined
          ? player.score
          : Math.max(player.score ?? 0, server.score),
      roundScore:
        server.roundScore === undefined
          ? player.roundScore
          : Math.max(player.roundScore ?? 0, server.roundScore),
    }
  })

  return { ...previous, players }
}

// ÇALINAN İSTEMCİ TARAFI: `steal` yayınıyla gelen OTORİTER kurban durumunu
// yerel oyuncuya (index 0) uygular. Burada `Math.max` KULLANMAYIZ: çalınma
// puanı DÜŞÜRÜR ve bu düşüş meşrudur. Ancak bayat bir yayın (ör. tur değişimi
// sonrası gecikmiş paket) yerel skoru geriye çekmemeli; bu yüzden yalnızca
// AYNI turda ve sunucu değeri yerelden KÜÇÜK/EŞİT olduğunda uygularız.
export const applyAuthoritativeVictimState = (
  previous: State,
  victim: AuthoritativeVictimState,
  actionRound: number,
): State => {
  if (previous.round !== actionRound) return previous

  const local = previous.players[0]
  if (!local) return previous

  const players = previous.players.map((player, index) => {
    if (index !== 0) return player
    const next: Player = { ...player }
    if (typeof victim.coins === 'number' && Number.isFinite(victim.coins)) {
      next.coins = Math.min(player.coins ?? 0, victim.coins)
    }
    if (typeof victim.roundCoins === 'number' && Number.isFinite(victim.roundCoins)) {
      next.roundCoins = Math.min(player.roundCoins ?? 0, victim.roundCoins)
    }
    if (typeof victim.score === 'number' && Number.isFinite(victim.score)) {
      next.score = Math.min(player.score ?? 0, victim.score)
    }
    if (typeof victim.roundScore === 'number' && Number.isFinite(victim.roundScore)) {
      next.roundScore = Math.min(player.roundScore ?? 0, victim.roundScore)
    }
    return next
  })

  return { ...previous, players }
}
