import { DEFAULT_AVATAR, DEFAULT_SETTINGS, type AvatarConfig, type MatchSettings, type PlayerColor } from '../turf/types'

export interface AppState {
  nickname: string
  avatar: AvatarConfig
  settings: MatchSettings
  autoRun: boolean
  roomCode: string
  roomCreated: boolean
}

const STORAGE_KEY = 'turf-clash-profile'

function load(): Partial<AppState> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppState> } catch { return {} }
}

const saved = load()
let state: AppState = {
  nickname: saved.nickname || 'Nova',
  avatar: { ...DEFAULT_AVATAR, ...saved.avatar },
  settings: { ...DEFAULT_SETTINGS, ...saved.settings },
  autoRun: saved.autoRun === true,
  roomCode: '',
  roomCreated: false,
}
const listeners = new Set<(value: AppState) => void>()

export const appStore = {
  get(): AppState { return state },
  update(patch: Partial<AppState>): AppState {
    state = { ...state, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nickname: state.nickname, avatar: state.avatar, settings: state.settings, autoRun: state.autoRun }))
    listeners.forEach(listener => listener(state))
    return state
  },
  updateAvatar(patch: Partial<AvatarConfig>): AppState {
    return this.update({ avatar: { ...state.avatar, ...patch } })
  },
  updateSettings(patch: Partial<MatchSettings>): AppState {
    return this.update({ settings: { ...state.settings, ...patch } })
  },
  setColor(color: PlayerColor): AppState { return this.updateAvatar({ color }) },
  subscribe(listener: (value: AppState) => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
}
