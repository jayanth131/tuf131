export type Screen = 'home' | 'customize' | 'lobby' | 'game' | 'results' | 'settings' | 'howto'
export type GameMode = 'practice' | 'quick' | 'room'
export type PlayerColor = 'yellow' | 'green' | 'blue' | 'red' | 'purple' | 'orange' | 'pink' | 'cyan'
export type ArenaTheme = 'meadow' | 'desert' | 'ice' | 'neon' | 'candy'
export type AvatarHat = 'none' | 'cap' | 'crown' | 'antenna'
export type AvatarExpression = 'happy' | 'focused' | 'sleepy' | 'surprised'
export type AvatarAccessory = 'none' | 'scarf' | 'visor' | 'badge'

export interface AvatarConfig {
  color: PlayerColor
  hat: AvatarHat
  sunglasses: boolean
  expression: AvatarExpression
  accessory: AvatarAccessory
  variant: number
}

export interface PlayerProfile {
  id: string
  nickname: string
  color: PlayerColor
  x: number
  z: number
  territory: number
  knockouts: number
  respawns: number
  trail: number[]
  alive: boolean
  eliminated?: boolean
  respawnAt: number
  bot: boolean
  ready: boolean
  avatar: AvatarConfig
}

export interface MatchSettings {
  duration: 2 | 3 | 5
  maxPlayers: 4 | 6 | 8
  arenaSize: 40 | 50 | 60
  movementSpeed: number
  respawnDuration: number
  theme: ArenaTheme
  music: boolean
  sfx: boolean
}

export interface LeaderboardRow {
  id: string
  nickname: string
  color: PlayerColor
  territory: number
  knockouts: number
  bot: boolean
}

export interface MatchResult extends LeaderboardRow {
  rank: number
  respawns: number
}

export interface GameSnapshot {
  phase: 'countdown' | 'live' | 'ended'
  countdown: number
  timeLeft: number
  players: PlayerProfile[]
  territory: Int8Array
  trail: Int8Array
  settings: MatchSettings
  notifications: string[]
  localId: string
}

export const COLORS: Record<PlayerColor, string> = {
  yellow: '#F7C84B',
  green: '#43D69A',
  blue: '#5B8DEF',
  red: '#F16C6C',
  purple: '#A77BFF',
  orange: '#FF975C',
  pink: '#F47CC6',
  cyan: '#4FD7E6',
}

export const COLOR_LABELS: Record<PlayerColor, string> = {
  yellow: 'Sunbeam',
  green: 'Meadow',
  blue: 'Sky',
  red: 'Coral',
  purple: 'Grape',
  orange: 'Citrus',
  pink: 'Bubblegum',
  cyan: 'Poolside',
}

export const DEFAULT_AVATAR: AvatarConfig = {
  color: 'yellow',
  hat: 'antenna',
  sunglasses: false,
  expression: 'happy',
  accessory: 'none',
  variant: 0,
}

export const DEFAULT_SETTINGS: MatchSettings = {
  duration: 3,
  maxPlayers: 8,
  arenaSize: 60,
  movementSpeed: 8,
  respawnDuration: 3,
  theme: 'meadow',
  music: true,
  sfx: true,
}
