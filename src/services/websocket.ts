import type { MatchEntrant, MoveInput, RuleEvent } from '../turf/match'
import type { AvatarConfig, GameSnapshot, MatchSettings } from '../turf/types'

export interface RoomState {
  code: string
  hostId: string
  localId: string
  players: MatchEntrant[]
  settings: MatchSettings
  phase: 'lobby' | 'countdown' | 'live' | 'ended'
}

export type RoomRequest =
  | { type: 'create'; nickname: string; avatar: AvatarConfig; settings: MatchSettings }
  | { type: 'join'; code: string; nickname: string; avatar: AvatarConfig }
  | { type: 'customize'; nickname: string; avatar: AvatarConfig }
  | { type: 'ready'; ready: boolean }
  | { type: 'settings'; settings: MatchSettings }
  | { type: 'start' | 'end' }
  | ({ type: 'input' } & MoveInput)

export interface RoomSnapshot extends Omit<GameSnapshot, 'territory' | 'trail' | 'localId'> {
  territory: string
  trail: string
}

export type RoomMessage =
  | { type: 'room'; room: RoomState }
  | { type: 'match'; matchId: number; boardVersion: number; snapshot: RoomSnapshot; events: RuleEvent[] }
  | { type: 'error'; message: string }

export class MultiplayerClient {
  private socket?: WebSocket
  private connectTimer?: number
  private readonly message: (message: RoomMessage) => void
  private readonly closed: () => void

  constructor(message: (message: RoomMessage) => void, closed: () => void) {
    this.message = message
    this.closed = closed
  }

  connect(request: RoomRequest): void {
    this.disconnect()
    try {
      const endpoint = import.meta.env.VITE_WS_URL || new URL('/turf-ws', window.location.href).href
      const socket = new WebSocket(endpoint)
      this.socket = socket
      this.connectTimer = window.setTimeout(() => socket.close(), 8000)
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
      socket.onclose = () => {
        if (this.socket !== socket) return
        window.clearTimeout(this.connectTimer)
        this.socket = undefined
        this.closed()
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
