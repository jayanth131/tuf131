import { describe, expect, it } from 'vitest'
import { roomSocketUrl } from '../src/services/websocket'

describe('room WebSocket endpoint', () => {
  const frontend = 'http://localhost:3000/'

  it('accepts a backend base URL and adds the room path', () => {
    expect(roomSocketUrl('https://turfclash.onrender.com/', frontend))
      .toBe('wss://turfclash.onrender.com/turf-ws')
  })

  it('preserves explicit endpoints and defaults to same-origin multiplayer', () => {
    expect(roomSocketUrl('wss://example.com/custom', frontend)).toBe('wss://example.com/custom')
    expect(roomSocketUrl(undefined, frontend)).toBe('ws://localhost:3000/turf-ws')
  })
})
