import { DEFAULT_AVATAR, type AvatarConfig, type GameSnapshot, type MatchSettings, type PlayerProfile, type PlayerColor } from './types.ts'
import { captureEnclosed, createTerritory, gridIndex, seedBase, territoryPercent } from './territory.ts'

export type RuleEvent =
  | { type: 'capture'; message: string; playerId: string }
  | { type: 'knockout'; message: string; playerId: string; by?: string }
  | { type: 'respawn'; message: string; playerId: string }
  | { type: 'countdown'; value: number }

export interface MatchEntrant { id: string; nickname: string; avatar: AvatarConfig; ready: boolean; bot?: boolean }
export interface MoveInput { x: number; z: number }

const PLAYER_SPAWNS = [
  { x: 7, z: 7 },
  { x: 52, z: 7 },
  { x: 7, z: 52 },
  { x: 52, z: 52 },
  { x: 30, z: 7 },
  { x: 52, z: 30 },
  { x: 7, z: 30 },
  { x: 30, z: 52 },
]
const PLAYER_COLORS: PlayerColor[] = ['yellow', 'green', 'blue', 'red', 'purple', 'orange', 'pink', 'cyan']
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function practiceRoster(nickname: string, avatar: AvatarConfig): MatchEntrant[] {
  const colors = PLAYER_COLORS.filter(color => color !== avatar.color)
  const bots = ['Pixel', 'Orbit', 'Mochi'].map((name, index): MatchEntrant => ({
    id: `bot-${index + 1}`,
    nickname: name,
    ready: true,
    bot: true,
    avatar: {
      ...DEFAULT_AVATAR,
      color: colors[index],
      variant: index + 1,
      hat: (['cap', 'none', 'antenna'] as const)[index],
      sunglasses: index === 1,
      expression: index === 2 ? 'focused' : 'happy',
    },
  }))
  return [{ id: 'local', nickname: nickname || 'Nova', avatar, ready: true }, ...bots]
}

export class TurfMatch {
  readonly players: PlayerProfile[]
  readonly territory: Int8Array
  readonly trail: Int8Array
  readonly settings: MatchSettings
  readonly size: number
  boardVersion = 0
  now = 0
  countdown = 3
  timeLeft: number
  phase: GameSnapshot['phase'] = 'countdown'
  private notificationBuffer: string[] = []
  private readonly baseCenters = new Map<number, { x: number; z: number }>()
  private readonly botTimers = new Map<string, number>()
  private readonly botDirections = new Map<string, MoveInput>()
  private readonly departed = new Set<string>()
  private readonly onEvent: (event: RuleEvent) => void

  constructor(settings: MatchSettings, entrants: MatchEntrant[], onEvent: (event: RuleEvent) => void = () => {}) {
    this.settings = { ...settings }
    this.onEvent = onEvent
    this.size = settings.arenaSize
    this.timeLeft = settings.duration * 60
    this.territory = createTerritory(this.size)
    this.trail = createTerritory(this.size)
    this.players = entrants.map((entrant, index) => {
      const spawn = PLAYER_SPAWNS[index]
      const center = { x: Math.round(spawn.x * this.size / 60), z: Math.round(spawn.z * this.size / 60) }
      this.baseCenters.set(index, center)
      seedBase(this.territory, this.size, index, center.x, center.z, 3)
      if (entrant.bot) this.botDirections.set(entrant.id, { x: index % 2 === 0 ? 1 : -1, z: index % 3 === 0 ? 1 : -1 })
      return {
        ...entrant,
        avatar: { ...entrant.avatar },
        color: entrant.avatar.color,
        bot: Boolean(entrant.bot),
        x: center.x - this.size / 2,
        z: center.z - this.size / 2,
        alive: true,
        trail: [],
        territory: 0,
        knockouts: 0,
        respawns: 0,
        respawnAt: 0,
      }
    })
  }

  update(dt: number, inputs: ReadonlyMap<string, MoveInput>): void {
    if (this.phase === 'ended') return
    this.now += dt
    if (this.phase === 'countdown') {
      const next = Math.max(0, Math.ceil(3 - this.now))
      if (next !== this.countdown) {
        this.countdown = next
        if (next === 0) this.phase = 'live'
        this.onEvent({ type: 'countdown', value: next })
      }
      return
    }
    this.timeLeft = Math.max(0, this.settings.duration * 60 - (this.now - 3))
    if (this.timeLeft <= 0) {
      this.end()
      return
    }
    for (const player of this.players) {
      if (this.departed.has(player.id)) continue
      if (player.bot) this.updateBot(player, dt)
      else {
        const input = inputs.get(player.id)
        if (input) this.movePlayer(player, input.x, input.z, dt, false)
      }
    }
    for (const player of this.players) {
      if (!this.departed.has(player.id)) this.updateRespawn(player)
    }
  }

  end(): void { this.phase = 'ended' }

  removePlayer(id: string): void {
    const player = this.players.find(candidate => candidate.id === id)
    if (!player || this.phase === 'ended') return
    this.departed.add(id)
    this.clearTrail(player)
    player.alive = false
  }

  snapshot(localId = ''): GameSnapshot {
    return {
      phase: this.phase, countdown: this.countdown, timeLeft: this.timeLeft,
      players: this.players.map((player, index) => ({
        ...player, trail: [...player.trail], territory: territoryPercent(this.territory, index),
      })),
      territory: this.territory.slice(), trail: this.trail.slice(),
      settings: { ...this.settings }, notifications: [...this.notificationBuffer], localId,
    }
  }

  private pushNotification(message: string): void {
    this.notificationBuffer = [message, ...this.notificationBuffer].slice(0, 4)
  }

  private movePlayer(player: PlayerProfile, inputX: number, inputZ: number, dt: number, bot: boolean): void {
    if (!player.alive) return
    const length = Math.hypot(inputX, inputZ)
    if (length < 0.01) return
    const x = inputX / length
    const z = inputZ / length
    const speed = this.settings.movementSpeed * (bot ? 0.66 : 1)
    const previousIndex = this.worldToIndex(player.x, player.z)
    player.x = clamp(player.x + x * speed * dt, -this.size / 2 + 0.7, this.size / 2 - 0.7)
    player.z = clamp(player.z + z * speed * dt, -this.size / 2 + 0.7, this.size / 2 - 0.7)
    const index = this.worldToIndex(player.x, player.z)
    if (index === previousIndex) return
    const ownerIndex = this.players.indexOf(player)
    const otherTrailOwner = this.trail[index]
    if (otherTrailOwner >= 0 && otherTrailOwner !== ownerIndex) {
      this.knockout(this.players[otherTrailOwner], player)
    }
    const onOwn = this.territory[index] === ownerIndex
    if (!onOwn && this.trail[index] === ownerIndex) {
      this.clearTrail(player)
      this.returnToStart(player)
      return
    }
    if (!onOwn) {
      this.boardVersion += 1
      player.trail.push(index)
      this.trail[index] = ownerIndex
    }
    if (onOwn && player.trail.length > 0) {
      const result = player.trail.length >= 3 ? captureEnclosed(this.territory, this.size, ownerIndex, player.trail) : null
      this.clearTrail(player)
      const gained = result ? result.captured.length + result.trail.length : 0
      if (gained > 0) {
        this.pushNotification(`${player.nickname} captured ${gained} tiles.`)
        this.onEvent({ type: 'capture', message: `${player.nickname} expanded the turf.`, playerId: player.id })
      }
    }
  }

  private updateBot(player: PlayerProfile, dt: number): void {
    const direction = this.botDirections.get(player.id) ?? { x: 1, z: 0 }
    let timer = (this.botTimers.get(player.id) ?? 0) + dt
    const index = this.worldToIndex(player.x, player.z)
    const owner = this.players.indexOf(player)
    if (timer > 1.4 + owner * 0.35) {
      timer = 0
      const turn = Math.random() > 0.5 ? 1 : -1
      this.botDirections.set(player.id, { x: direction.z * turn, z: -direction.x * turn })
    }
    if (this.territory[index] === owner && player.trail.length === 0 && Math.random() < dt * 0.22) {
      const target = PLAYER_SPAWNS[(owner + 1) % PLAYER_SPAWNS.length]
      const dx = target.x - (player.x + this.size / 2)
      const dz = target.z - (player.z + this.size / 2)
      this.botDirections.set(player.id, { x: Math.sign(dx), z: Math.sign(dz) })
    }
    this.botTimers.set(player.id, timer)
    const next = this.botDirections.get(player.id) ?? direction
    this.movePlayer(player, next.x, next.z, dt, true)
  }

  private updateRespawn(player: PlayerProfile): void {
    if (player.alive || this.now < player.respawnAt) return
    this.returnToStart(player)
  }

  private returnToStart(player: PlayerProfile): void {
    const owner = this.players.indexOf(player)
    const center = this.baseCenters.get(owner) ?? { x: Math.floor(this.size / 2), z: Math.floor(this.size / 2) }
    player.x = center.x - this.size / 2
    player.z = center.z - this.size / 2
    player.alive = true
    this.pushNotification(`${player.nickname} respawned.`)
    this.onEvent({ type: 'respawn', message: `${player.nickname} is back in the arena.`, playerId: player.id })
  }

  private clearTrail(player: PlayerProfile): void {
    const owner = this.players.indexOf(player)
    for (const index of player.trail) {
      if (this.trail[index] === owner) this.trail[index] = -1
    }
    player.trail = []
    this.boardVersion += 1
  }

  private knockout(player: PlayerProfile, attacker?: PlayerProfile): void {
    if (!player.alive) return
    this.clearTrail(player)
    player.alive = false
    player.respawns += 1
    player.respawnAt = this.now + this.settings.respawnDuration
    if (attacker && attacker.id !== player.id) attacker.knockouts += 1
    this.pushNotification(`${player.nickname} was knocked out${attacker ? ` by ${attacker.nickname}` : ''}.`)
    this.onEvent({ type: 'knockout', message: `${player.nickname} knocked out.`, playerId: player.id, by: attacker?.id })
  }

  private worldToIndex(x: number, z: number): number {
    const gx = clamp(Math.round(x + this.size / 2), 0, this.size - 1)
    const gz = clamp(Math.round(z + this.size / 2), 0, this.size - 1)
    return gridIndex(gx, gz, this.size)
  }

}
