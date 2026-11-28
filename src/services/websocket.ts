import type { MatchEntrant, MoveInput, RuleEvent } from '../turf/match'
import type { AvatarConfig, GameSnapshot, MatchSettings } from '../turf/types'

export interface RoomState {
  code: string
  hostId: string
  localId: string
  players: Array<MatchEntrant & { connected?: boolean }>
  settings: MatchSettings
  phase: 'lobby' | 'countdown' | 'live' | 'ended'
}

export type RoomRequest =
  | { type: 'create'; nickname: string; avatar: AvatarConfig; settings: MatchSettings; compact?: boolean }
  | { type: 'join'; code: string; nickname: string; avatar: AvatarConfig; compact?: boolean; seatToken?: string; resume?: boolean }
  | { type: 'leave' }
  | { type: 'customize'; nickname: string; avatar: AvatarConfig }
  | { type: 'ready'; ready: boolean }
  | { type: 'settings'; settings: MatchSettings }
  | { type: 'start' | 'end' }
  | ({ type: 'input' } & MoveInput)

export interface RoomSnapshot extends Omit<GameSnapshot, 'territory' | 'trail' | 'localId'> {
  territory?: string
  trail?: string
}

export type RoomMessage =
  | { type: 'room'; room: RoomState; seatToken?: string }
  | { type: 'match'; matchId: number; boardVersion: number; snapshot: RoomSnapshot; events: RuleEvent[] }
  | { type: 'error'; message: string }

export function roomSocketUrl(configured: string | undefined, pageUrl: string): string {
  const endpoint = new URL(configured?.trim() || '/turf-ws', pageUrl)
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:'
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:'
  if (endpoint.pathname === '/') endpoint.pathname = '/turf-ws'
  return endpoint.href
}

export class MultiplayerClient {
  private socket?: WebSocket
  private connectTimer?: number
  private readonly message: (message: RoomMessage) => void
  private readonly closed: (code?: number) => void

  constructor(message: (message: RoomMessage) => void, closed: (code?: number) => void) {
    this.message = message
    this.closed = closed
  }

  connect(request: RoomRequest): void {
    this.disconnect()
    try {
      const endpoint = roomSocketUrl(import.meta.env.VITE_WS_URL, window.location.href)
      const socket = new WebSocket(endpoint)
      this.socket = socket
      this.connectTimer = window.setTimeout(() => socket.close(), 15000)
      socket.onopen = () => {
        window.clearTimeout(this.connectTimer)
        this.send(request)
      }
      socket.onmessage = event => {
        if (this.socket !== socket) return
        let message: RoomMessage
        try { message = JSON.parse(String(event.data)) as RoomMessage } catch { return }
        if (message?.type === 'room' || message?.type === 'match' || message?.type === 'error') this.message(message)
      }
      socket.onclose = event => {
        if (this.socket !== socket) return
        window.clearTimeout(this.connectTimer)
        this.socket = undefined
        this.closed(event.code)
      }
    } catch { this.closed() }
  }

  send(request: RoomRequest): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 64_000) return false
    this.socket.send(JSON.stringify(request))
    return true
  }

  disconnect(): void {
    window.clearTimeout(this.connectTimer)
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }
}
