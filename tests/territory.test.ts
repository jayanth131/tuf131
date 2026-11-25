import { describe, expect, it } from 'vitest'
import { captureEnclosed, createTerritory, gridIndex, isTrailCollision, territoryPercent } from '../src/turf/territory'

describe('Turf Clash territory rules', () => {
  it('captures a closed region and keeps the outside neutral', () => {
    const size = 9
    const grid = createTerritory(size)
    const trail = [gridIndex(3, 3, size), gridIndex(4, 3, size), gridIndex(5, 3, size), gridIndex(5, 4, size), gridIndex(5, 5, size), gridIndex(4, 5, size), gridIndex(3, 5, size), gridIndex(3, 4, size)]
    const result = captureEnclosed(grid, size, 0, trail)
    expect(result.captured).toContain(gridIndex(4, 4, size))
    expect(grid[gridIndex(4, 4, size)]).toBe(0)
    expect(grid[gridIndex(1, 1, size)]).toBe(-1)
  })

  it('detects an exposed trail collision', () => {
    expect(isTrailCollision(12, [4, 12, 18])).toBe(true)
    expect(isTrailCollision(2, [4, 12, 18])).toBe(false)
  })

  it('reports territory as a stable percentage', () => {
    const grid = createTerritory(4)
    grid[0] = 1; grid[1] = 1; grid[2] = 1; grid[3] = 1
    expect(territoryPercent(grid, 1)).toBe(25)
  })
})
