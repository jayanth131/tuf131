import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setInterval as every } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

class Client {
  socket
  handlers = new Set()
  messages = []
  constructor(endpoint) {
    this.socket = new WebSocket(endpoint)
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      this.messages.push(message)
      if (this.messages.length > 180) this.messages.shift()
      for (const handler of this.handlers) handler(message)
    })
  }
  send(message) { this.socket.send(JSON.stringify(message)) }
  clear() { this.messages = [] }
  until(test) {
    const previous = this.messages.findLast(test)
    if (previous) return Promise.resolve(previous)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(handler)
        reject(new Error('Timed out waiting for ' + test.toString()))
      }, 10_000)
      const handler = message => {
        if (!test(message)) return
        clearTimeout(timer)
        this.handlers.delete(handler)
        resolve(message)
      }
      this.handlers.add(handler)
    })
  }
}

test('friend codes, ready roster, authority, shared movement and final results', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./turf_server.mjs', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  const clients = []
  try {
    const lines = createInterface({ input: child.stdout })
    const [line] = await once(lines, 'line')
    const port = JSON.parse(line).port
    const connect = async () => {
      const client = new Client('ws://127.0.0.1:' + port + '/turf-ws')
      clients.push(client)
      await once(client.socket, 'open')
      return client
    }
    const [host, guest, outsider] = await Promise.all([connect(), connect(), connect()])
    outsider.send({ type: 'join', code: '999999', nickname: 'Outsider' })
    assert.match((await outsider.until(m => m.type === 'error')).message, /not found/i)

    host.send({ type: 'create', nickname: 'Nova', avatar: { color: 'red' }, settings: { duration: 2, arenaSize: 40, maxPlayers: 4, movementSpeed: 12 } })
    const { room } = await host.until(m => m.type === 'room')
    assert.match(room.code, /^[A-Z2-9]{6}$/)
    assert.equal(room.hostId, room.localId)
    guest.send({ type: 'join', code: room.code.toLowerCase(), nickname: 'Comet', avatar: { color: 'red', hat: 'cap' } })
    const guestRoom = (await guest.until(m => m.type === 'room')).room
    const joined = (await host.until(m => m.type === 'room' && m.room.players.length === 2)).room
    assert.deepEqual(joined.players, guestRoom.players)
    assert.equal(new Set(joined.players.map(p => p.avatar.color)).size, 2)

    guest.send({ type: 'settings', settings: { arenaSize: 60 } })
    assert.match((await guest.until(m => m.type === 'error')).message, /only the host/i)
    host.send({ type: 'start' })
    assert.match((await host.until(m => m.type === 'error')).message, /ready/i)
    guest.send({ type: 'customize', nickname: 'Comet', avatar: { color: 'purple', hat: 'crown', accessory: 'scarf' } })
    await host.until(m => m.type === 'room' && m.room.players[1]?.avatar.color === 'purple')
    guest.send({ type: 'ready', ready: true })
    await host.until(m => m.type === 'room' && m.room.players.length === 2 && m.room.players.every(p => p.ready))
    host.send({ type: 'start' })

    const starts = await Promise.all([host.until(m => m.type === 'match'), guest.until(m => m.type === 'match')])
    assert.deepEqual(starts[0], starts[1])
    assert.equal(starts[0].snapshot.territory.length, 1600)
    assert.equal(starts[0].snapshot.players.length, 2)
    outsider.clear()
    outsider.send({ type: 'join', code: room.code })
    assert.match((await outsider.until(m => m.type === 'error')).message, /in progress/i)
    await host.until(m => m.type === 'match' && m.snapshot.phase === 'live')
    const base = starts[0].snapshot.players[0]
    const steer = async (x, z, reached) => {
      host.clear()
      const input = { type: 'input', x, z }
      host.send(input)
      const timer = every(() => host.send(input), 70)
      try {
        await host.until(m => m.type === 'match' && reached(m.snapshot.players[0]))
      } finally { clearInterval(timer) }
    }
    await steer(1, 0, p => p.x >= base.x + 7)
    const seen = await guest.until(m => m.type === 'match' && m.snapshot.players[0].x >= base.x + 6)
    assert(seen.snapshot.trail.includes('0'))
    await steer(0, 1, p => p.z >= base.z + 7)
    await steer(-1, 0, p => p.x <= base.x)
    await steer(0, -1, p => p.z <= base.z + 2)
    host.send({ type: 'input', x: 0, z: 0 })
    const captured = await guest.until(m => m.type === 'match' && m.snapshot.players[0].territory > base.territory)
    assert(captured.snapshot.territory.match(/0/g).length > starts[0].snapshot.territory.match(/0/g).length)

    guest.clear()
    guest.send({ type: 'end' })
    assert.match((await guest.until(m => m.type === 'error')).message, /only the host/i)
    host.send({ type: 'end' })
    const results = await Promise.all([host, guest].map(client => client.until(m => m.type === 'match' && m.snapshot.phase === 'ended')))
    assert.deepEqual(results[0], results[1])
    host.socket.close()
    const promoted = await guest.until(m => m.type === 'room' && m.room.hostId === guestRoom.localId)
    assert.equal(promoted.room.players.length, 1)
  } finally {
    for (const client of clients) client.socket.terminate()
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
})
