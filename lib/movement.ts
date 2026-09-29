import { ARENA, OBSTACLES, PLAYER_HIT_R } from './config'

export function clampPos(x: number, y: number) {
  return {
    x: Math.max(ARENA.minX, Math.min(ARENA.maxX, x)),
    y: Math.max(ARENA.minY, Math.min(ARENA.maxY, y)),
  }
}

export function hitsObstacle(x: number, y: number, radius = PLAYER_HIT_R): boolean {
  for (const o of OBSTACLES) {
    const rad = (-o.angleDeg * Math.PI) / 180
    const dx = x - o.cx
    const dy = y - o.cy
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
    if (Math.abs(lx) <= o.w / 2 + radius && Math.abs(ly) <= o.h / 2 + radius) return true
  }
  return false
}

/** Önce tam hareket, sonra X kayması, sonra Y kayması (duvar kayması). */
export function resolveMove(fromX: number, fromY: number, toX: number, toY: number) {
  const { x, y } = clampPos(toX, toY)
  if (!hitsObstacle(x, y)) return { x, y }
  if (!hitsObstacle(x, fromY)) return { x, y: fromY }
  if (!hitsObstacle(fromX, y)) return { x: fromX, y }
  return { x: fromX, y: fromY }
}
