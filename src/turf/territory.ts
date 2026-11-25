export const NEUTRAL = -1

export interface CaptureResult {
  captured: number[]
  trail: number[]
  owner: number
}

export function gridIndex(x: number, z: number, size: number): number {
  return z * size + x
}

export function gridCoord(index: number, size: number): { x: number; z: number } {
  return { x: index % size, z: Math.floor(index / size) }
}

export function createTerritory(size: number): Int8Array {
  return new Int8Array(size * size).fill(NEUTRAL)
}

export function seedBase(grid: Int8Array, size: number, owner: number, centerX: number, centerZ: number, radius = 3): number[] {
  const cells: number[] = []
  for (let z = centerZ - radius; z <= centerZ + radius; z += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      if (x >= 0 && x < size && z >= 0 && z < size) {
        const index = gridIndex(x, z, size)
        grid[index] = owner
        cells.push(index)
      }
    }
  }
  return cells
}

export function neighbors(index: number, size: number): number[] {
  const { x, z } = gridCoord(index, size)
  const result: number[] = []
  if (x > 0) result.push(index - 1)
  if (x < size - 1) result.push(index + 1)
  if (z > 0) result.push(index - size)
  if (z < size - 1) result.push(index + size)
  return result
}

/**
 * Adds the exposed trail to the owner and flood-fills neutral/opponent cells from the arena edge.
 * Anything not reachable from the edge is enclosed and claimed by the trail owner.
 */
export function captureEnclosed(grid: Int8Array, size: number, owner: number, trail: number[]): CaptureResult {
  if (trail.length === 0) return { captured: [], trail: [], owner }
  const validTrail = [...new Set(trail)].filter(index => index >= 0 && index < grid.length)
  for (const index of validTrail) grid[index] = owner

  const outside = new Uint8Array(grid.length)
  const queue: number[] = []
  for (let x = 0; x < size; x += 1) {
    queue.push(gridIndex(x, 0, size), gridIndex(x, size - 1, size))
  }
  for (let z = 1; z < size - 1; z += 1) {
    queue.push(gridIndex(0, z, size), gridIndex(size - 1, z, size))
  }
  while (queue.length > 0) {
    const index = queue.pop()!
    if (outside[index] || grid[index] === owner) continue
    outside[index] = 1
    for (const next of neighbors(index, size)) {
      if (!outside[next] && grid[next] !== owner) queue.push(next)
    }
  }

  const captured: number[] = []
  for (let index = 0; index < grid.length; index += 1) {
    if (!outside[index] && grid[index] !== owner) {
      grid[index] = owner
      captured.push(index)
    }
  }
  return { captured, trail: validTrail, owner }
}

export function territoryPercent(grid: Int8Array, owner: number): number {
  let owned = 0
  for (const value of grid) if (value === owner) owned += 1
  return Math.round((owned / grid.length) * 1000) / 10
}

export function isTrailCollision(playerIndex: number, opponentTrail: number[]): boolean {
  return opponentTrail.includes(playerIndex)
}

export function compareScores(a: { territory: number; knockouts: number }, b: { territory: number; knockouts: number }): number {
  if (a.territory !== b.territory) return b.territory - a.territory
  return b.knockouts - a.knockouts
}
