import { describe, expect, it } from 'vitest'
import { TurfMatch, type MoveInput, type RuleEvent } from '../src/turf/match'
import { DEFAULT_AVATAR, DEFAULT_SETTINGS } from '../src/turf/types'
import { gridIndex } from '../src/turf/territory'

function newMatch(events: RuleEvent[] = []) {
  const match = new TurfMatch({ ...DEFAULT_SETTINGS, arenaSize: 40, movementSpeed: 8, respawnDuration: 1 }, [
    { id: 'host', nickname: 'Nova', avatar: DEFAULT_AVATAR, ready: true },
    { id: 'guest', nickname: 'Comet', avatar: { ...DEFAULT_AVATAR, color: 'purple' }, ready: true },
  ], event => events.push(event))
  match.update(3, new Map())
  return match
}

function move(match: TurfMatch, id: string, input: MoveInput) {
  for (let tick = 0; tick < 4; tick += 1) match.update(1 / 32, new Map([[id, input]]))
}

describe('shared Turf Clash match rules', () => {
  it('permanently eliminates a player when their last owned tile is captured', () => {
    const events: RuleEvent[] = []
    const match = newMatch(events)
    const [host, guest] = match.players
    const cell = (x: number, z: number) => gridIndex(x, z, 40)
    match.territory.fill(-1)
    for (let offset = 18; offset <= 22; offset += 1) {
      for (const index of [cell(offset, 18), cell(offset, 22), cell(18, offset), cell(22, offset)]) match.territory[index] = 0
    }
    match.territory[cell(20, 20)] = 1
    host.trail = [cell(20, 15), cell(20, 16), cell(20, 17)]
    host.trail.forEach(index => { match.trail[index] = 0 })
    Object.assign(host, { x: 0, z: -3 })
    move(match, host.id, { x: 0, z: 1 })
    expect(guest).toMatchObject({ eliminated: true, alive: false })
    expect(match.snapshot().players[1].territory).toBe(0)
    expect(events).toContainEqual({ type: 'eliminated', playerId: guest.id })
    const position = { x: guest.x, z: guest.z }
    match.update(3, new Map([[guest.id, { x: 1, z: 0 }]]))
    expect(guest).toMatchObject({ ...position, eliminated: true, alive: false })
  })

  it('knocks out the trail owner, awards the cutter, and keeps previously captured turf', () => {
    const events: RuleEvent[] = []
    const match = newMatch(events)
    const [host, guest] = match.players
    const guestStart = { x: guest.x, z: guest.z }
    Object.assign(host, { x: 0, z: 0 })
    Object.assign(guest, { x: 1, z: 1 })
    const exposed = gridIndex(21, 20, 40)
    const owned = gridIndex(23, 20, 40)
    guest.trail.push(exposed)
    match.trail[exposed] = 1
    match.territory[owned] = 1

    move(match, 'host', { x: 1, z: 0 })
    expect(host.alive).toBe(true)
    expect(host.knockouts).toBe(1)
    expect(guest.alive).toBe(false)
    expect(guest.trail).toEqual([])
    expect(match.trail[exposed]).toBe(0)
    expect(match.territory[owned]).toBe(1)

    match.update(1.1, new Map())
    expect(guest).toMatchObject({ ...guestStart, alive: true, respawns: 1 })
    expect(events).toContainEqual(expect.objectContaining({ type: 'respawn', playerId: 'guest' }))
  })

  it('sends a player to their starting spot when they close an unanchored loop', () => {
    const match = newMatch()
    const [player] = match.players
    const start = { x: player.x, z: player.z }
    const owned = match.territory.slice()
    Object.assign(player, { x: 0, z: 0 })
    for (const input of [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]) {
      move(match, 'host', input)
    }
    for (let tick = 0; tick < 2; tick += 1) match.update(1 / 32, new Map([['host', { x: 1, z: 0 }]]))
    expect(player).toMatchObject({ ...start, alive: true, trail: [], knockouts: 0 })
    expect(match.territory).toEqual(owned)
    expect(match.trail.every(owner => owner === -1)).toBe(true)
  })
})
