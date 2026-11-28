import { randomInt, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { TurfMatch } from '../src/turf/match.ts'
import { COLORS, DEFAULT_AVATAR, DEFAULT_SETTINGS } from '../src/turf/types.ts'

const root = process.env.STATIC_ROOT ? resolve(process.env.STATIC_ROOT) : fileURLToPath(new URL('../dist', import.meta.url))
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean))
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const media = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
}
const rooms = new Map()
const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false })
const tickLength = 1 / 30
const seatGraceMs = 120_000

function send(socket, message) {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(typeof message === 'string' ? message : JSON.stringify(message))
}

function error(socket, message) { send(socket, { type: 'error', message }) }
function choose(value, options, fallback) { return options.includes(value) ? value : fallback }
function limit(value, min, max, fallback) { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback }
function nickname(value) { return typeof value === 'string' ? value.trim().slice(0, 14) || 'Nova' : 'Nova' }
function codes(room, id) { return [...room.members.values()].filter(member => member.player.id !== id).map(member => member.player.avatar.color) }

function avatar(value, room, id) {
  const source = value ?? {}
  const used = codes(room, id)
  const available = Object.keys(COLORS).filter(color => !used.includes(color))
  return {
    ...DEFAULT_AVATAR,
    color: choose(source.color, available, available[0]),
    hat: choose(source.hat, ['none', 'cap', 'crown', 'antenna'], DEFAULT_AVATAR.hat),
    sunglasses: source.sunglasses === true,
    expression: choose(source.expression, ['happy', 'focused', 'sleepy', 'surprised'], DEFAULT_AVATAR.expression),
    accessory: choose(source.accessory, ['none', 'scarf', 'visor', 'badge'], DEFAULT_AVATAR.accessory),
  }
}

function settings(value) {
  const source = value ?? {}
  return {
    ...DEFAULT_SETTINGS,
    duration: choose(source.duration, [2, 3, 5], DEFAULT_SETTINGS.duration),
    maxPlayers: choose(source.maxPlayers, [4, 6, 8], DEFAULT_SETTINGS.maxPlayers),
    arenaSize: choose(source.arenaSize, [40, 50, 60], DEFAULT_SETTINGS.arenaSize),
    movementSpeed: limit(source.movementSpeed, 5, 12, DEFAULT_SETTINGS.movementSpeed),
    respawnDuration: limit(source.respawnDuration, 1, 6, DEFAULT_SETTINGS.respawnDuration),
    theme: choose(source.theme, ['meadow', 'desert', 'ice', 'neon', 'candy'], DEFAULT_SETTINGS.theme),
  }
}

function roomCode() {
  let code
  do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('') }
  while (rooms.has(code))
  return code
}

function active(room) { return room.match && room.match.phase !== 'ended' }

function recipients(room) {
  return [...Array.from(room.members.values(), member => member.socket).filter(Boolean), ...room.spectators]
}

function sendRoom(room, socket) {
  const member = room.members.get(socket.playerId)
  send(socket, {
    type: 'room',
    seatToken: member?.seatToken,
    room: {
      code: room.code, hostId: room.hostId, settings: room.settings,
      players: [...room.members.values()].map(({ player, socket }) => ({ ...player, connected: Boolean(socket) })),
      phase: room.match?.phase ?? 'lobby',
      localId: member?.player.id ?? '',
    },
  })
}

function broadcastRoom(room) {
  for (const socket of recipients(room)) sendRoom(room, socket)
}

function gridString(grid) {
  return Array.from(grid, owner => owner < 0 ? '.' : String(owner)).join('')
}

function matchPayload(room) {
  const { localId: _, territory, trail, ...snapshot } = room.match.snapshot()
  if (room.gridVersion !== room.match.boardVersion) {
    room.gridVersion = room.match.boardVersion
    room.territory = gridString(territory)
    room.trail = gridString(trail)
  }
  return snapshot
}

function sendMatch(room, socket, snapshot, events = []) {
  socket.pendingEvents.push(...events)
  if (socket.pendingEvents.length > 32) socket.pendingEvents.splice(0, socket.pendingEvents.length - 32)
  if (snapshot.phase !== 'ended' && socket.bufferedAmount > 64_000) return
  const includeGrid = !socket.compact || socket.sentMatchId !== room.matchId || socket.sentGridVersion !== room.gridVersion
  send(socket, {
    type: 'match', matchId: room.matchId, boardVersion: room.gridVersion, events: socket.pendingEvents.splice(0),
    snapshot: { ...snapshot, ...(includeGrid && { territory: room.territory, trail: room.trail }) },
  })
  socket.sentMatchId = room.matchId
  socket.sentGridVersion = room.gridVersion
}

function broadcastMatch(room) {
  const snapshot = matchPayload(room)
  const events = room.events.splice(0)
  for (const socket of recipients(room)) sendMatch(room, socket, snapshot, events)
}

function attach(socket, room, member) {
  socket.room = room
  socket.playerId = member?.player.id
  if (!member) {
    room.spectators.add(socket)
    return
  }
  const previous = member.socket
  member.socket = socket
  member.disconnectedAt = undefined
  member.inputAt = 0
  room.emptySince = undefined
  if (previous) previous.close(4001, 'Seat opened in another tab')
  if (!room.members.get(room.hostId)?.socket) room.hostId = member.player.id
}

function join(socket, message) {
  if (socket.room) return error(socket, 'You are already in a room.')
  socket.compact = message.compact === true
  let room
  if (message.type === 'create') {
    if (rooms.size >= 128) return error(socket, 'The server is full. Try again shortly.')
    room = { code: roomCode(), hostId: '', members: new Map(), spectators: new Set(), settings: settings(message.settings), matchId: 0, gridVersion: -1 }
    rooms.set(room.code, room)
  } else {
    const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : ''
    room = rooms.get(code)
    if (!room) return error(socket, 'Room code not found.')
    const saved = typeof message.seatToken === 'string' && [...room.members.values()].find(member => member.seatToken === message.seatToken)
    if (saved) {
      attach(socket, room, saved)
      broadcastRoom(room)
      if (active(room) || (message.resume === true && room.match?.phase === 'ended')) sendMatch(room, socket, matchPayload(room))
      return
    }
    if (active(room) || (message.resume === true && room.match?.phase === 'ended')) {
      if (!socket.compact) return error(socket, 'Refresh the game to watch this match.')
      if (room.spectators.size >= 16) return error(socket, 'This room has reached its spectator limit.')
      attach(socket, room)
      sendRoom(room, socket)
      sendMatch(room, socket, matchPayload(room))
      return
    }
    if (room.members.size >= room.settings.maxPlayers) return error(socket, 'This room is full.')
  }
  const id = randomUUID()
  if (!room.hostId) room.hostId = id
  const player = { id, nickname: nickname(message.nickname), avatar: avatar(message.avatar, room, id), ready: room.hostId === id }
  const member = { seatToken: randomUUID(), player, input: { x: 0, z: 0 }, inputAt: 0 }
  room.members.set(id, member)
  attach(socket, room, member)
  broadcastRoom(room)
}

function start(room, socket) {
  if (socket.playerId !== room.hostId) return error(socket, 'Only the host can start the match.')
  if (active(room)) return
  const members = [...room.members.values()].filter(member => member.socket)
  if (members.length < 2 || members.some(member => !member.player.ready)) return error(socket, 'At least two players must be ready.')
  for (const [id, member] of room.members) if (!member.socket) room.members.delete(id)
  room.matchId += 1
  room.gridVersion = -1
  room.events = []
  room.match = new TurfMatch(room.settings, members.map(member => member.player), event => room.events.push(event))
  for (const member of members) member.inputAt = 0
  broadcastRoom(room)
  broadcastMatch(room)
}

function receive(socket, message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'create' || message.type === 'join') return join(socket, message)
  const room = socket.room
  if (message.type === 'leave' && room) {
    leave(socket, true)
    socket.close()
    return
  }
  const member = room?.members.get(socket.playerId)
  if (member?.socket !== socket) return
  if (message.type === 'start') return start(room, socket)
  if (message.type === 'end') {
    if (socket.playerId !== room.hostId) return error(socket, 'Only the host can end the match.')
    if (!active(room)) return
    room.match.end()
    broadcastRoom(room)
    broadcastMatch(room)
    return
  }
  if (active(room)) {
    if (message.type === 'input' && Number.isFinite(message.x) && Number.isFinite(message.z)) {
      const player = room.match.players.find(candidate => candidate.id === socket.playerId)
      if (!player?.alive || player.eliminated) return
      member.input = { x: limit(message.x, -1, 1, 0), z: limit(message.z, -1, 1, 0) }
      member.inputAt = performance.now()
    }
    return
  }
  switch (message.type) {
    case 'ready':
      if (typeof message.ready !== 'boolean') return
      member.player.ready = message.ready
      break
    case 'customize':
      member.player.nickname = nickname(message.nickname)
      member.player.avatar = avatar(message.avatar, room, socket.playerId)
      break
    case 'settings': {
      if (socket.playerId !== room.hostId) return error(socket, 'Only the host can change arena settings.')
      const next = settings(message.settings)
      if (next.maxPlayers < room.members.size) return error(socket, 'That player limit is below the current room size.')
      room.settings = next
      break
    }
    default: return
  }
  broadcastRoom(room)
}

function leave(socket, intentional = false) {
  const room = socket.room
  if (!room) return
  socket.room = undefined
  if (room.spectators.delete(socket)) return
  const member = room.members.get(socket.playerId)
  if (member?.socket !== socket) return
  member.socket = undefined
  member.inputAt = 0
  member.disconnectedAt = Date.now()
  if (intentional && !active(room)) room.members.delete(socket.playerId)
  const connected = [...room.members.values()].filter(candidate => candidate.socket)
  if (!connected.length) room.emptySince = Date.now()
  if (room.hostId === socket.playerId && connected.length) {
    room.hostId = connected[0].player.id
    connected[0].player.ready = true
  }
  if (!room.members.size && !room.spectators.size) rooms.delete(room.code)
  else broadcastRoom(room)
}

function inside(base, target) {
  const relativePath = relative(base, target)
  return relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath)
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }))
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }
    const name = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    if (name.split(/[/\\]/).some(part => part.startsWith('.'))) throw new Error('invalid asset')
    const target = resolve(root, name)
    if (!inside(root, target)) throw new Error('invalid asset')
    const physical = await realpath(target)
    const info = await stat(physical)
    if (!inside(await realpath(root), physical) || !info.isFile()) throw new Error('invalid asset')
    response.writeHead(200, {
      'content-type': media[extname(name)] ?? 'application/octet-stream',
      'cache-control': name.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
      'content-length': info.size, 'x-content-type-options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else await pipeline(createReadStream(physical), response)
  } catch {
    if (response.headersSent) response.destroy()
    else response.writeHead(404).end('Not found')
  }
})

server.on('upgrade', (request, socket, head) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const origin = request.headers.origin
    const sameOrigin = typeof origin === 'string' && new URL(origin).host === request.headers.host
    if (pathname !== '/turf-ws' || sockets.clients.size >= 256 || (origin && !sameOrigin && !allowedOrigins.has(origin))) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws))
  } catch { socket.destroy() }
})

sockets.on('connection', socket => {
  socket.missedPongs = 0
  socket.pendingEvents = []
  const joinedBy = setTimeout(() => { if (!socket.room) socket.close() }, 15_000)
  let windowStart = performance.now()
  let messageCount = 0
  socket.on('pong', () => { socket.missedPongs = 0 })
  socket.on('message', (data, binary) => {
    const now = performance.now()
    if (now - windowStart >= 1000) { messageCount = 0; windowStart = now }
    if (binary || ++messageCount > 60) { socket.close(1008); return }
    let message
    try { message = JSON.parse(data.toString()) } catch { return }
    receive(socket, message)
  })
  socket.on('error', () => {})
  socket.on('close', () => { clearTimeout(joinedBy); leave(socket) })
})

let frame = 0
let lastTime = performance.now()
let accumulator = 0
setInterval(() => {
  const now = performance.now()
  accumulator += Math.min((now - lastTime) / 1000, 0.25)
  lastTime = now
  while (accumulator >= tickLength) {
    accumulator -= tickLength
    frame += 1
    for (const room of rooms.values()) {
      if (!active(room)) continue
      const inputs = new Map()
      for (const [id, member] of room.members) {
        if (member.socket && member.inputAt > 0 && now - member.inputAt < 1000) inputs.set(id, member.input)
      }
      room.match.update(tickLength, inputs)
      for (const event of room.events) {
        if (event.type === 'respawn' || event.type === 'knockout' || event.type === 'eliminated') {
          const member = room.members.get(event.playerId)
          if (member) member.inputAt = 0
        }
      }
      const ended = room.match.phase === 'ended'
      if (ended) broadcastRoom(room)
      if (ended || frame % 2 === 0) broadcastMatch(room)
    }
  }
}, 16).unref()

setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (active(room)) continue
    if (room.emptySince && now - room.emptySince >= seatGraceMs) {
      for (const socket of room.spectators) socket.close(1001, 'Room closed')
      rooms.delete(room.code)
      continue
    }
    if (room.match) continue
    let changed = false
    for (const [id, member] of room.members) {
      if (!member.socket && now - member.disconnectedAt >= seatGraceMs) {
        room.members.delete(id)
        changed = true
      }
    }
    if (changed) broadcastRoom(room)
  }
  for (const socket of sockets.clients) {
    if (socket.missedPongs >= 3) socket.terminate()
    else { socket.missedPongs += 1; socket.ping() }
  }
}, 15_000).unref()

server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port, protocol: 'turf-clash' }))
})
