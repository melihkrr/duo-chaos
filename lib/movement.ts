import { ARENA, OBSTACLES, PLAYER_HIT_R } from './config'

export function clampPos(x: number, y: number) {
  return {
    x: Math.max(ARENA.minX, Math.min(ARENA.maxX, x)),
    y: Math.max(ARENA.minY, Math.min(ARENA.maxY, y)),
  }
}

export function hitsObstacle(x: number, y: number, radius = PLAYER_HIT_R): boolean {
  const effectiveRadius = Math.max(1.2, radius * 0.72)

  for (const o of OBSTACLES) {
    const rad = (-o.angleDeg * Math.PI) / 180
    const dx = x - o.cx
    const dy = y - o.cy
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
    if (Math.abs(lx) <= o.w / 2 + effectiveRadius && Math.abs(ly) <= o.h / 2 + effectiveRadius) return true
  }
  return false
}

/** Önce tam hareket, sonra en az engel baskısıyla çalışan eksen kayması. */
export function resolveMove(fromX: number, fromY: number, toX: number, toY: number) {
  const { x, y } = clampPos(toX, toY)
  if (!hitsObstacle(x, y)) return { x, y }

  const xOnly = { x, y: fromY }
  const yOnly = { x: fromX, y }
  const none = { x: fromX, y: fromY }

  const xOpen = !hitsObstacle(xOnly.x, xOnly.y)
  const yOpen = !hitsObstacle(yOnly.x, yOnly.y)

  if (xOpen && !yOpen) return xOnly
  if (yOpen && !xOpen) return yOnly
  if (xOpen && yOpen) {
    const xDist = Math.hypot(x - fromX, 0)
    const yDist = Math.hypot(0, y - fromY)
    return xDist >= yDist ? xOnly : yOnly
  }

  const xGap = Math.abs(x - fromX) < 0.01 ? Number.POSITIVE_INFINITY : Math.abs(x - fromX)
  const yGap = Math.abs(y - fromY) < 0.01 ? Number.POSITIVE_INFINITY : Math.abs(y - fromY)
  return xGap <= yGap ? xOnly : yOnly
}
