import { VictoryFireworks } from './victoryFireworks'
import { Audio, type Sfx } from '../engine/audio'
import { appStore } from '../stores/appStore'
import { MultiplayerClient, type RoomMessage, type RoomState } from '../services/websocket'
import { COLORS, COLOR_LABELS, type AvatarAccessory, type AvatarExpression, type AvatarHat, type GameMode, type GameSnapshot, type MatchSettings, type PlayerColor, type Screen } from './types'
import { TurfEngine, type EngineEvent } from './engine'

const colorOrder: PlayerColor[] = ['yellow', 'green', 'blue', 'red', 'purple', 'orange', 'pink', 'cyan']
const colorIcons: Record<PlayerColor, string> = { yellow: '●', green: '●', blue: '●', red: '●', purple: '●', orange: '●', pink: '●', cyan: '●' }

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character)
}
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
function cleanCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) }

export class TurfApp {
  private readonly root: HTMLElement
  private readonly engine: TurfEngine
  private readonly multiplayer = new MultiplayerClient(message => this.receiveRoom(message), code => this.roomDisconnected(code))
  private screen: Screen = 'home'
  private pendingMode: GameMode = 'practice'
  private room?: RoomState
  private roomCode = ''
  private roomMessage = ''
  private connecting = false
  private matchId = 0
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private lastMatchMessageAt = 0
  private seatToken?: string
  private watching = false
  private autoDirection = { x: 0, z: 0 }
  private inputTimer = 0
  private remoteBoardVersion = -1
  private remoteTerritory = new Int8Array()
  private remoteTrail = new Int8Array()
  private lobbySettings?: MatchSettings
  private returnToLobbyFromSettings = false
  private toastTimer?: number
  private toastText = ''
  private input = { x: 0, z: 0 }
  private held = new Set<string>()
  private hudTimer?: number
  private musicOn = true
  private sfxOn = true
  private audio?: Audio
  private fireworks?: VictoryFireworks
  private editingLobbyAvatar = false
  private scoresHidden = false

  constructor(root: HTMLElement, engine: TurfEngine) {
    this.root = root
    this.engine = engine
    const state = appStore.get()
    this.musicOn = state.settings.music
    this.sfxOn = state.settings.sfx
    this.bindEvents()
    this.roomCode = cleanCode(new URLSearchParams(window.location.search).get('room') ?? '')
    if (this.roomCode) {
      this.pendingMode = 'room'
      this.renderLobby()
    } else {
      this.renderHome()
    }
    window.addEventListener('keydown', event => {
      if (this.screen !== 'game') return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName ?? '')) return
      if (event.code === 'Space' && (this.autoDirection.x || this.autoDirection.z || !(event.target instanceof HTMLButtonElement))) {
        this.stopMovement()
        event.preventDefault()
        return
      }
      const key = event.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        if (!event.repeat && !this.watching) {
          this.held.add(key)
          const direction = this.keyboardDirection()
          if (direction.x || direction.z) this.autoDirection = direction
        }
        event.preventDefault()
      }
    })
    window.addEventListener('keyup', event => this.held.delete(event.key.toLowerCase()))
    window.addEventListener('blur', () => this.stopMovement())
    this.hudTimer = window.setInterval(() => this.updateHud(), 100)
  }

  private keyboardDirection(): { x: number; z: number } {
    const keyboard = { x: 0, z: 0 }
    if (this.held.has('a') || this.held.has('arrowleft')) keyboard.x -= 1
    if (this.held.has('d') || this.held.has('arrowright')) keyboard.x += 1
    if (this.held.has('w') || this.held.has('arrowup')) keyboard.z -= 1
    if (this.held.has('s') || this.held.has('arrowdown')) keyboard.z += 1
    return keyboard
  }

  update(dt: number): void {
    const steering = Math.hypot(this.input.x, this.input.z) > 0.05 ? this.input : this.keyboardDirection()
    if (steering.x || steering.z) this.autoDirection = steering
    const desired = this.watching ? { x: 0, z: 0 } : appStore.get().autoRun ? this.autoDirection : steering
    if (this.room && this.screen === 'game' && !this.reconnectAttempts
      && performance.now() - this.lastMatchMessageAt > 8000) {
      this.multiplayer.disconnect()
      this.roomDisconnected()
    }
    if (this.room && this.screen === 'game' && !this.watching && !this.reconnectAttempts) {
      this.inputTimer += dt
      if (this.inputTimer >= 0.045) {
        this.inputTimer = 0
        this.multiplayer.send({ type: 'input', ...desired })
      }
    }
    this.engine.update(dt, desired)
  }

  dispose(): void {
    if (this.hudTimer) window.clearInterval(this.hudTimer)
    window.clearTimeout(this.reconnectTimer)
    this.multiplayer.disconnect()
    this.closeCelebration()
    this.audio?.stopMusic()
    void this.audio?.ctx.close()
  }

  private bindEvents(): void {
    this.root.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
      if (!target) return
      const action = target.dataset.action
      if (!action) return
      this.enableAudio()
      this.handleAction(action, target)
      if (this.screen !== 'results') {
        this.fireworks?.dispose()
        this.fireworks = undefined
      }
      this.playSound('ui')
    })
    this.root.addEventListener('submit', event => {
      const form = event.target as HTMLFormElement
      if (!form.matches('[data-join-form]')) return
      event.preventDefault()
      this.enableAudio()
      this.connectToRoom(false)
    })
    this.root.addEventListener('input', event => {
      const target = event.target as HTMLInputElement
      if (target.dataset.field === 'room') this.roomCode = cleanCode(target.value)
      if (target.dataset.field === 'nickname') {
        appStore.update({ nickname: target.value.slice(0, 14) })
        this.engine.setPreview(appStore.get().avatar, target.value)
      }
    })
    this.root.addEventListener('change', event => {
      const target = event.target as HTMLInputElement | HTMLSelectElement
      this.enableAudio()
      if (target.dataset.field === 'duration') this.updateMatchSettings({ duration: Number(target.value) as 2 | 3 | 5 })
      if (target.dataset.field === 'maxPlayers') this.updateMatchSettings({ maxPlayers: Number(target.value) as 4 | 6 | 8 })
      if (target.dataset.field === 'arenaSize') this.updateMatchSettings({ arenaSize: Number(target.value) as 40 | 50 | 60 })
      if (target.dataset.field === 'speed') this.updateMatchSettings({ movementSpeed: Number(target.value) })
      if (target.dataset.field === 'respawn') this.updateMatchSettings({ respawnDuration: Number(target.value) })
      if (target.dataset.field === 'theme') this.updateMatchSettings({ theme: target.value as 'meadow' | 'desert' | 'ice' | 'neon' | 'candy' })
      if (target.dataset.field === 'music' && target instanceof HTMLInputElement) { this.musicOn = target.checked; appStore.updateSettings({ music: target.checked }); this.syncAudio() }
      if (target.dataset.field === 'sfx' && target instanceof HTMLInputElement) { this.sfxOn = target.checked; appStore.updateSettings({ sfx: target.checked }); this.syncAudio() }
      if (target.dataset.field === 'auto-run' && target instanceof HTMLInputElement) {
        appStore.update({ autoRun: target.checked })
        this.stopMovement()
      }
    })
  }

  private handleAction(action: string, target: HTMLElement): void {
    switch (action) {
      case 'play-friends': this.pendingMode = 'room'; this.renderLobby(); break
      case 'quick-play': this.pendingMode = 'quick'; this.renderCustomize(); break
      case 'practice': this.pendingMode = 'practice'; this.renderCustomize(); break
      case 'howto': this.renderHowto(); break
      case 'settings':
        this.returnToLobbyFromSettings = Boolean(this.room && (this.screen === 'lobby' || this.screen === 'results'))
        if (this.returnToLobbyFromSettings && this.room && this.isHost()) this.lobbySettings = { ...this.room.settings }
        this.renderSettings()
        break
      case 'back':
        if (this.returnToLobbyFromSettings) {
          if (this.lobbySettings) this.multiplayer.send({ type: 'settings', settings: this.lobbySettings })
          this.lobbySettings = undefined
          this.returnToLobbyFromSettings = false
          this.renderLobby()
        } else if (this.editingLobbyAvatar) {
          if (this.room) this.saveRoomAvatar()
          this.renderLobby()
        } else {
          this.leaveRoom()
          this.renderHome()
        }
        break
      case 'select-color': appStore.setColor(target.dataset.color as PlayerColor); this.engine.setPreview(appStore.get().avatar, appStore.get().nickname); this.renderCustomize(); break
      case 'select-hat': appStore.updateAvatar({ hat: target.dataset.hat as AvatarHat }); this.renderCustomize(); break
      case 'toggle-sunglasses': appStore.updateAvatar({ sunglasses: !appStore.get().avatar.sunglasses }); this.renderCustomize(); break
      case 'select-expression': appStore.updateAvatar({ expression: target.dataset.expression as AvatarExpression }); this.renderCustomize(); break
      case 'select-accessory': appStore.updateAvatar({ accessory: target.dataset.accessory as AvatarAccessory }); this.renderCustomize(); break
      case 'edit-lobby-avatar':
        this.editingLobbyAvatar = true
        if (this.room && this.localRoomPlayer()?.ready && !this.isHost()) this.multiplayer.send({ type: 'ready', ready: false })
        this.renderCustomize()
        break
      case 'continue-customize':
        if (this.pendingMode === 'room' || this.room) {
          if (this.room) this.saveRoomAvatar()
          this.renderLobby()
        } else this.startGame(this.pendingMode)
        break
      case 'create-room': this.connectToRoom(true); break
      case 'toggle-ready': this.multiplayer.send({ type: 'ready', ready: !this.localRoomPlayer()?.ready }); break
      case 'copy-room': this.copyRoom(); break
      case 'start-room': this.multiplayer.send({ type: 'start' }); break
      case 'leave-room': this.leaveRoom(); this.renderHome(); break
      case 'end-match': this.room ? this.multiplayer.send({ type: 'end' }) : this.engine.endNow(); break
      case 'stop-moving': this.stopMovement(); break
      case 'show-arena': this.engine.showArena(); break
      case 'follow-player': this.engine.followPlayer(); break
      case 'toggle-scores':
        this.scoresHidden = !this.scoresHidden
        this.updateScoreVisibility()
        break
      case 'zoom-in': this.engine.zoom(-3); break
      case 'zoom-out': this.engine.zoom(3); break
      case 'toggle-sfx': this.sfxOn = !this.sfxOn; appStore.updateSettings({ sfx: this.sfxOn }); this.syncAudio(); target.classList.toggle('is-active', this.sfxOn); target.setAttribute('aria-pressed', String(this.sfxOn)); break
      case 'toggle-music': this.musicOn = !this.musicOn; appStore.updateSettings({ music: this.musicOn }); this.syncAudio(); target.textContent = this.musicOn ? '\u25D2' : '\u25CC'; target.setAttribute('aria-pressed', String(this.musicOn)); break
      case 'replay-celebration': this.fireworks?.replay(); break
      case 'play-again': this.room ? this.multiplayer.send({ type: 'start' }) : this.startGame(this.pendingMode); break
      case 'results-lobby': {
        const room = this.room
        if (room && !room.localId) {
          this.leaveRoom()
          this.roomCode = room.code
          this.connectToRoom(false)
        } else this.renderLobby()
        break
      }
      case 'change-avatar': this.editingLobbyAvatar = Boolean(this.room); this.renderCustomize(); break
      case 'share-results': this.shareResults(); break
      case 'exit-game': this.leaveRoom(); this.renderHome(); break
      case 'fullscreen': document.documentElement.requestFullscreen?.().catch(() => undefined); break
    }
  }

  private renderHome(): void {
    this.screen = 'home'
    this.engine.resetPreview()
    this.engine.setPreview(appStore.get().avatar, appStore.get().nickname)
    this.root.innerHTML = `<div class="app-shell home-screen">
      ${this.topbar('home')}
      <main class="home-content">
        <section class="hero-copy">
          <div class="eyebrow"><span class="eyebrow-dot"></span> FRIENDS-ONLY TERRITORY CLASH</div>
          <h1>Claim your<br><span>corner.</span></h1>
          <p class="hero-tagline">Challenge your friends.<br>Rule the arena.</p>
          <p class="hero-description">Draw the boldest line, close the biggest loop, and protect your turf before the clock runs out.</p>
          <div class="hero-actions"><button class="button button-primary" data-action="play-friends"><span>Play with friends</span><span class="button-icon">→</span></button><button class="button button-quiet" data-action="practice"><span>Practice mode</span><span class="button-icon">↗</span></button></div>
          <div class="micro-proof"><span class="avatar-stack"><i style="background:${COLORS.yellow}"></i><i style="background:${COLORS.blue}"></i><i style="background:${COLORS.pink}"></i><i style="background:${COLORS.green}"></i></span><span>Up to 8 players · no sign-up</span></div>
        </section>
        <aside class="home-card glass-card">
          <div class="card-kicker">QUICK DROP-IN</div><h2>Jump in<br><em>and paint.</em></h2>
          <p>Want a quick warm-up? Pick your color and chase the leaderboard.</p>
          <button class="button button-secondary" data-action="quick-play">Quick play <span>↗</span></button>
          <div class="card-divider"></div><div class="mini-stat"><span class="live-dot"></span><strong>Practice arena</strong><span class="status-muted">online-ready</span></div>
        </aside>
      </main>
      <footer class="home-footer"><div class="footer-links"><button class="text-button" data-action="howto">How to play</button><button class="text-button" data-action="settings">Settings</button></div><div class="footer-note"><span class="sound-mark">◒</span> Sound on <span class="footer-separator">·</span> Built for browser play</div></footer>
    </div>`
  }

  private renderCustomize(): void {
    const scrollTop = this.root.querySelector('.customize-screen')?.scrollTop ?? 0
    const preview = this.root.querySelector<HTMLCanvasElement>('.avatar-preview')
    this.screen = 'customize'
    const state = appStore.get()
    if (!preview) this.engine.resetPreview()
    this.engine.setPreview(state.avatar, state.nickname)
    this.root.innerHTML = `<div class="app-shell customize-screen">
      ${this.topbar('customize')}
      <main class="customize-layout">
        <section class="customize-panel glass-card">
          <div class="step-label">01 <span>YOUR ROBOT</span></div><h1>Make it <em>yours.</em></h1><p class="panel-subtitle">Pick a look before you step onto the turf.</p>
          <label class="field-label">Nickname<input maxlength="14" data-field="nickname" value="${escapeHtml(state.nickname)}" placeholder="Enter your nickname"></label>
          <div class="customize-section"><div class="section-title">Color <span>${COLOR_LABELS[state.avatar.color]}</span></div><div class="color-grid">${colorOrder.map(color => `<button aria-label="${COLOR_LABELS[color]}" class="color-swatch ${state.avatar.color === color ? 'selected' : ''}" data-action="select-color" data-color="${color}" style="--swatch:${COLORS[color]}">${state.avatar.color === color ? '✓' : colorIcons[color]}</button>`).join('')}</div></div>
          <div class="customize-section"><div class="section-title">Headwear</div><div class="choice-row">${(['none', 'cap', 'crown', 'antenna'] as AvatarHat[]).map(hat => `<button class="choice-chip ${state.avatar.hat === hat ? 'selected' : ''}" data-action="select-hat" data-hat="${hat}">${hat === 'none' ? 'Bare' : hat[0].toUpperCase() + hat.slice(1)}</button>`).join('')}</div></div>
          <div class="customize-section split-options"><div><div class="section-title">Face</div><div class="choice-row">${(['happy', 'focused', 'sleepy', 'surprised'] as AvatarExpression[]).map(expression => `<button class="choice-chip ${state.avatar.expression === expression ? 'selected' : ''}" data-action="select-expression" data-expression="${expression}">${expression}</button>`).join('')}</div></div><button class="toggle-chip ${state.avatar.sunglasses ? 'selected' : ''}" data-action="toggle-sunglasses">${state.avatar.sunglasses ? '●' : '○'} Shades</button></div>
          <div class="customize-section"><div class="section-title">Accessory</div><div class="choice-row">${(['none', 'scarf', 'visor', 'badge'] as AvatarAccessory[]).map(accessory => `<button class="choice-chip ${state.avatar.accessory === accessory ? 'selected' : ''}" data-action="select-accessory" data-accessory="${accessory}">${accessory}</button>`).join('')}</div></div>
          <button class="button button-primary full-width" data-action="continue-customize">${this.editingLobbyAvatar ? 'Save and return to lobby' : this.pendingMode === 'room' ? 'Continue to room' : 'Enter arena'} <span>→</span></button>
        </section>
        <section class="preview-copy"><div class="preview-badge"><span class="pulse-ring"></span> LIVE PREVIEW</div><div class="avatar-preview-stage"></div></section>
      </main>
    </div>`
    const canvas = preview ?? document.createElement('canvas')
    canvas.className = 'avatar-preview'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Live preview of your customized robot')
    this.root.querySelector('.avatar-preview-stage')?.append(canvas)
    if (!preview) this.engine.showAvatarPreview(canvas)
    const shell = this.root.querySelector('.customize-screen')
    if (shell) shell.scrollTop = scrollTop
  }

  private isHost(): boolean { return Boolean(this.room && this.room.hostId === this.room.localId) }

  private localRoomPlayer() { return this.room?.players.find(player => player.id === this.room?.localId) }

  private updateMatchSettings(patch: Partial<MatchSettings>): void {
    if (this.lobbySettings) this.lobbySettings = { ...this.lobbySettings, ...patch }
    else if (!this.returnToLobbyFromSettings) appStore.updateSettings(patch)
  }

  private saveRoomAvatar(): void {
    const { nickname, avatar } = appStore.get()
    this.multiplayer.send({ type: 'customize', nickname, avatar })
  }

  private connectToRoom(create: boolean): void {
    if (this.connecting || this.room) return
    if (!create && this.roomCode.length !== 6) {
      this.setRoomMessage('Enter the six-character room code.')
      return
    }
    this.pendingMode = 'room'
    this.connecting = true
    this.roomMessage = 'Connecting to the room server...'
    this.renderLobby()
    const { nickname, avatar, settings } = appStore.get()
    this.seatToken = undefined
    if (create) this.multiplayer.connect({ type: 'create', nickname, avatar, settings, compact: true })
    else this.joinSavedRoom()
  }

  private joinSavedRoom(resume = false): void {
    const { nickname, avatar } = appStore.get()
    try { this.seatToken ??= localStorage.getItem('turf-clash-seat:' + this.roomCode) ?? undefined } catch { /* Storage is optional. */ }
    this.multiplayer.connect({ type: 'join', code: this.roomCode, nickname, avatar, compact: true, seatToken: this.seatToken, resume })
  }

  private setRoomMessage(message: string): void {
    this.roomMessage = message
    const status = this.root.querySelector('[data-room-status]')
    if (status) status.textContent = message
  }

  private leaveRoom(): void {
    this.multiplayer.send({ type: 'leave' })
    this.multiplayer.disconnect()
    window.clearTimeout(this.reconnectTimer)
    this.reconnectAttempts = 0
    this.seatToken = undefined
    this.room = undefined
    this.connecting = false
    this.roomCode = ''
    this.roomMessage = ''
    this.matchId = 0
    this.editingLobbyAvatar = false
    this.lobbySettings = undefined
    this.returnToLobbyFromSettings = false
    this.watching = false
    this.stopMovement()
  }

  private roomDisconnected(code?: number): void {
    if (this.room && code !== 4001) {
      this.stopMovement()
      this.reconnectAttempts += 1
      this.setRoomMessage('Connection interrupted. Reconnecting to your room...')
      this.reconnectTimer = window.setTimeout(() => this.joinSavedRoom(true), Math.min(750 * 2 ** (this.reconnectAttempts - 1), 8000))
      return
    }
    this.showRoomFailure(code === 4001 ? 'Your seat was opened in another tab.' : 'Could not reach the room server. Check your connection and try again.')
  }

  private showRoomFailure(message: string): void {
    const code = this.roomCode
    this.leaveRoom()
    this.closeCelebration()
    this.roomCode = code
    this.roomMessage = message
    this.renderLobby()
  }

  private receiveRoom(message: RoomMessage): void {
    if (message.type === 'error') {
      if (this.connecting || this.reconnectAttempts) this.showRoomFailure(message.message)
      else this.setRoomMessage(message.message)
      return
    }
    if (message.type === 'room') {
      const firstRoomUpdate = !this.room
      this.room = message.room
      this.roomCode = message.room.code
      this.connecting = false
      this.reconnectAttempts = 0
      this.lastMatchMessageAt = performance.now()
      this.setRoomMessage('')
      if (message.seatToken) {
        this.seatToken = message.seatToken
        try { localStorage.setItem('turf-clash-seat:' + this.roomCode, message.seatToken) } catch { /* Storage is optional. */ }
      }
      if (firstRoomUpdate || this.screen === 'lobby') {
        const local = this.localRoomPlayer()
        if (local && local.avatar.color !== appStore.get().avatar.color) appStore.updateAvatar({ color: local.avatar.color })
      }
      if (this.screen === 'lobby') this.renderLobby()
      this.updateHostControls()
      return
    }
    const room = this.room
    if (!room) return
    const current = message.snapshot
    this.lastMatchMessageAt = performance.now()
    if (current.territory !== undefined && current.trail !== undefined
      && (message.matchId !== this.matchId || message.boardVersion !== this.remoteBoardVersion)) {
      const decodeGrid = (grid: string) => Int8Array.from(grid, cell => cell === '.' ? -1 : Number(cell))
      this.remoteTerritory = decodeGrid(current.territory)
      this.remoteTrail = decodeGrid(current.trail)
      this.remoteBoardVersion = message.boardVersion
    }
    const snapshot: GameSnapshot = { ...current, localId: room.localId, territory: this.remoteTerritory, trail: this.remoteTrail }
    if (message.matchId !== this.matchId || (this.screen === 'lobby' && snapshot.phase !== 'ended')) {
      this.matchId = message.matchId
      this.editingLobbyAvatar = false
      this.lobbySettings = undefined
      this.returnToLobbyFromSettings = false
      this.startGame('room', snapshot)
    } else {
      this.engine.applyRemoteSnapshot(snapshot, message.boardVersion)
    }
    for (const event of message.events) this.handleEngineEvent(event)
    if (snapshot.phase === 'ended' && this.screen === 'game') this.showResults(snapshot)
  }

  private renderLobby(): void {
    this.screen = 'lobby'
    this.editingLobbyAvatar = false
    this.engine.resetPreview()
    const room = this.room
    if (!room) {
      const disabled = this.connecting ? 'disabled' : ''
      this.root.innerHTML = `<div class="app-shell lobby-screen">${this.topbar('lobby')}
        <main class="lobby-layout room-entry"><section class="lobby-main glass-card">
          <h1>Play with friends</h1>
          <div class="room-entry-actions">
            <button class="button button-primary" data-action="create-room" ${disabled}>Create room</button>
            <form data-join-form>
              <label class="field-label">Room code<input data-field="room" maxlength="6" value="${this.roomCode}" autocapitalize="characters" autocomplete="off" required></label>
              <button class="button button-secondary" type="submit" ${disabled}>Join room</button>
            </form>
          </div>
          <button class="text-button" data-action="edit-lobby-avatar">Customize avatar</button>
          <p class="room-status" data-room-status role="status">${escapeHtml(this.roomMessage)}</p>
        </section></main>
      </div>`
      return
    }
    const host = this.isHost()
    const local = this.localRoomPlayer()
    const connected = room.players.filter(player => player.connected !== false)
    const canStart = connected.length >= 2 && connected.every(player => player.ready)
    const roomBusy = room.phase === 'countdown' || room.phase === 'live'
    const waiting = roomBusy ? 'The match is starting.' : canStart ? 'Everyone is ready.' : 'At least two players must join and be ready.'
    this.root.innerHTML = `<div class="app-shell lobby-screen">${this.topbar('lobby')}
      <main class="lobby-layout"><section class="lobby-main glass-card">
        <div class="lobby-heading"><div><div class="step-label">FRIEND LOBBY</div><h1>Your room</h1></div>
          <div class="room-code-wrap"><span>ROOM CODE</span><strong>${room.code}</strong><button class="icon-button" data-action="copy-room" aria-label="Copy invite link">&#10697;</button></div>
        </div>
        <div class="invite-strip"><span>Share the code or invite link with friends</span><button class="text-button" data-action="copy-room">Copy invite link</button></div>
        <input class="room-invite-link" data-invite-link aria-label="Invite link" readonly hidden>
        <div class="players-heading"><span>PLAYERS <b>${room.players.length}/${room.settings.maxPlayers}</b></span><span class="connection-state"><i></i> Connected</span></div>
        <div class="player-grid">
          ${room.players.map(player => `<div class="player-card ${player.id === room.localId ? 'is-local' : ''}" style="--swatch:${COLORS[player.avatar.color]}">
            <div class="player-dot" aria-hidden="true">&#9679;</div><div><strong>${escapeHtml(player.nickname)}</strong><span>${player.id === room.hostId ? 'Host' : 'Player'}${player.id === room.localId ? ' (you)' : ''}</span></div>
            <span class="ready-state ${player.ready ? 'ready' : ''}">${player.connected === false ? 'RECONNECTING' : player.ready ? 'READY' : 'WAITING'}</span>
          </div>`).join('')}
          ${Array.from({ length: room.settings.maxPlayers - room.players.length }, () => '<div class="player-card empty-slot"><div class="empty-plus">+</div><span>Open slot</span></div>').join('')}
        </div>
        <div class="lobby-actions">
          <button class="button button-secondary" data-action="toggle-ready">${local?.ready ? 'Set unready' : 'Ready up'}</button>
          ${host ? `<button class="button button-primary" data-action="start-room" ${canStart && !roomBusy ? '' : 'disabled'}>Start match</button>` : '<span class="lobby-note">The host starts the match.</span>'}
        </div>
        <p class="room-status" data-room-status role="status">${escapeHtml(this.roomMessage || waiting)}</p>
      </section><aside class="lobby-side">
        <button class="button button-secondary lobby-customize" data-action="edit-lobby-avatar">Customize avatar</button>
        <div class="glass-card settings-card">
          <div class="card-kicker">MATCH SETTINGS</div>
          <div class="lobby-setting"><span>Duration</span><strong>${room.settings.duration} min</strong></div>
          <div class="lobby-setting"><span>Arena</span><strong>${this.themeLabel(room.settings.theme)}</strong></div>
          <div class="lobby-setting"><span>Grid</span><strong>${room.settings.arenaSize} &times; ${room.settings.arenaSize}</strong></div>
          ${host ? '<button class="text-button" data-action="settings">Edit settings</button>' : ''}
        </div>
        <button class="button button-quiet leave-room" data-action="leave-room">Leave room</button>
      </aside></main>
    </div>`
  }

  private startGame(mode: GameMode, shared?: GameSnapshot): void {
    this.pendingMode = mode
    this.screen = 'game'
    this.closeCelebration()
    this.stopMovement()
    if (shared) this.engine.beginRemoteMatch(shared)
    else this.engine.start(appStore.get().settings, appStore.get().nickname, appStore.get().avatar)
    const player = this.engine.getLocalPlayer()
    this.watching = !player || Boolean(player.eliminated)
    const settings = this.engine.getSettings()
    const announcement = document.querySelector('#match-announcement')
    if (announcement) announcement.textContent = ''
    this.root.innerHTML = `<div class="app-shell game-screen">
      <div class="arena-pan" data-arena-pan></div>
      <div class="game-hud">
        <div class="hud-top">
          <div class="hud-score-controls">
            <button class="round-icon score-toggle" data-action="toggle-scores" aria-controls="player-score leaderboard-panel minimap-panel">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/><path class="eye-slash" d="m3 3 18 18"/>
              </svg>
            </button>
            <div id="player-score" class="hud-player glass-card" data-score-panel>
              <div class="hud-avatar" style="--swatch:${COLORS[player?.color ?? 'yellow']}">&#10022;</div>
              <div><span class="hud-kicker" data-hud="role">YOU ARE</span><strong>${escapeHtml(player?.nickname ?? 'Spectator')}</strong><span class="hud-score" ${player ? '' : 'hidden'}><b data-hud="territory">0.0%</b> turf &middot; <b data-hud="knockouts">0</b> KOs</span></div>
            </div>
          </div>
          <div class="match-clock"><span class="match-status" data-hud="status">READY UP</span><strong data-hud="timer">03:00</strong><span class="match-sub">TURF CLASH &middot; <b>${this.themeLabel(settings.theme).toUpperCase()}</b></span></div>
          <div class="hud-actions">
            <button class="round-icon" data-action="show-arena" aria-label="Show entire arena" title="Show entire arena">&#9638;</button>
            <button class="round-icon" data-action="follow-player" aria-label="Follow player" title="Follow player">&#9678;</button>
            <button class="round-icon" data-action="fullscreen" aria-label="Fullscreen" title="Fullscreen">&#9974;</button>
          </div>
        </div>
        <div class="hud-middle"><div id="leaderboard-panel" class="leaderboard glass-card" data-score-panel><div class="leaderboard-title"><span>LEADERBOARD</span><span>LIVE</span></div><div data-hud="leaderboard"></div></div></div>
        <div class="hud-bottom">
          <div id="minimap-panel" class="minimap glass-card" data-score-panel><div class="minimap-head"><span>ARENA MAP</span><span data-hud="map-theme">MEADOW</span></div><canvas width="160" height="160" data-hud="minimap"></canvas></div>
          <div class="game-controls">
            <div class="joystick" data-joystick="true"><div class="joystick-knob"></div></div>
            <div class="control-stack">
              <button class="round-icon" data-action="zoom-in" aria-label="Zoom in">+</button>
              <button class="round-icon" data-action="zoom-out" aria-label="Zoom out">&minus;</button>
              ${appStore.get().autoRun ? '<button class="round-icon" data-action="stop-moving" aria-label="Stop auto-run" title="Stop auto-run (Space)">&#9208;</button>' : ''}
              <button class="round-icon ${this.sfxOn ? 'is-active' : ''}" data-action="toggle-sfx" aria-label="Sound effects" aria-pressed="${this.sfxOn}">&#9682;</button>
              <button class="round-icon" data-action="end-match" aria-label="End match" title="End match">&#9632;</button>
              ${this.room ? '<button class="round-icon" data-action="leave-room" aria-label="Leave room" title="Leave room">&times;</button>' : ''}
            </div>
          </div>
        </div>
        <div class="countdown-overlay" data-hud="countdown">3</div>
        <p class="match-connection room-status" data-room-status role="status"></p>
      </div>
    </div>`
    this.bindArenaPan()
    this.bindJoystick()
    this.updateScoreVisibility()
    this.updateHostControls()
    this.updateHud()
  }

  private updateHud(): void {
    if (this.screen !== 'game') return
    const snapshot = this.engine.getSnapshot()
    const local = snapshot.players.find(player => player.id === snapshot.localId)
    const watching = !local || Boolean(local.eliminated)
    if (watching && !this.watching) {
      this.stopMovement()
      this.engine.showArena()
    }
    this.watching = watching
    this.root.querySelectorAll<HTMLElement>('[data-joystick], [data-action="stop-moving"], [data-action="follow-player"]').forEach(control => { control.hidden = watching })
    const territory = this.engine.getLeaderboard().find(row => row.id === local?.id)
    const set = (key: string, value: string) => { const element = this.root.querySelector<HTMLElement>(`[data-hud="${key}"]`); if (element) element.textContent = value }
    set('countdown', snapshot.phase === 'countdown' ? String(snapshot.countdown) : '')
    set('territory', `${territory?.territory.toFixed(1) ?? '0.0'}%`)
    set('knockouts', String(local?.knockouts ?? 0))
    set('timer', formatTime(snapshot.timeLeft))
    set('status', snapshot.phase === 'ended' ? 'MATCH OVER' : watching ? 'SPECTATING' : snapshot.phase === 'countdown' ? 'GET READY' : !local.alive ? 'RESPAWNING' : 'CLAIM TURF')
    set('role', local?.eliminated ? 'ELIMINATED' : watching ? 'WATCHING MATCH' : 'YOU ARE')
    set('map-theme', this.themeLabel(snapshot.settings.theme).toUpperCase())
    const leaderboard = this.root.querySelector<HTMLElement>('[data-hud="leaderboard"]')
    if (leaderboard) leaderboard.innerHTML = this.engine.getLeaderboard().map((row, index) => `<div class="leader-row ${row.id === snapshot.localId ? 'is-you' : ''}"><span class="rank">${String(index + 1).padStart(2, '0')}</span><i style="background:${COLORS[row.color]}"></i><strong>${escapeHtml(row.nickname)}</strong><span>${row.territory.toFixed(1)}%</span></div>`).join('')
    const canvas = this.root.querySelector<HTMLCanvasElement>('[data-hud="minimap"]')
    if (canvas && !this.scoresHidden) this.drawMinimap(canvas, snapshot)
    if (snapshot.phase === 'ended') this.showResults(snapshot)
  }

  private drawMinimap(canvas: HTMLCanvasElement, snapshot: GameSnapshot): void {
    const context = canvas.getContext('2d')!
    const size = snapshot.settings.arenaSize
    const scale = canvas.width / size
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#17150f'; context.fillRect(0, 0, canvas.width, canvas.height)
    for (let index = 0; index < snapshot.territory.length; index += 1) {
      const owner = snapshot.territory[index]
      const player = snapshot.players[owner]
      if (!player) continue
      const x = index % size; const z = Math.floor(index / size)
      context.fillStyle = COLORS[player.color]
      context.globalAlpha = 0.84; context.fillRect(x * scale, z * scale, scale + 0.4, scale + 0.4)
    }
    context.globalAlpha = 1
    for (const player of snapshot.players) { if (!player.alive) continue; context.fillStyle = '#ffffff'; context.beginPath(); context.arc((player.x + size / 2) * scale, (player.z + size / 2) * scale, player.bot ? 2.5 : 4, 0, Math.PI * 2); context.fill() }
  }

  private showResults(snapshot: GameSnapshot): void {
    if (this.screen === 'results') return
    this.screen = 'results'
    this.input = { x: 0, z: 0 }
    this.held.clear()
    const rows = this.engine.getLeaderboard()
    const winner = rows[0]
    const announcement = document.querySelector('#match-announcement')
    if (announcement && winner) announcement.textContent = `${winner.nickname} wins Turf Clash with ${winner.territory.toFixed(1)}% of the arena.`
    this.engine.resetPreview()
    this.root.innerHTML = `<div class="app-shell results-screen" style="--winner:${COLORS[winner?.color ?? 'yellow']}"><div class="victory-sky" aria-hidden="true"></div><canvas class="victory-fireworks" aria-hidden="true"></canvas>${this.topbar('results')}<main class="results-layout"><section class="results-hero"><div class="result-kicker">ARENA CHAMPION</div><div class="champion-stage"><canvas class="champion-portrait" role="img" aria-label="Crowned winning avatar"></canvas></div><h1>${escapeHtml(winner?.nickname ?? 'Nova')} <em>rules the turf.</em></h1><p>${winner?.territory.toFixed(1) ?? '0.0'}% captured · ${winner?.knockouts ?? 0} knockouts · ${formatTime(snapshot.settings.duration * 60)}</p><div class="result-actions"><button class="button button-primary" data-action="play-again" ${this.room && !this.isHost() ? 'disabled' : ''}>${this.room && !this.isHost() ? 'Waiting for host' : 'Play again'} <span>↗</span></button><button class="button button-secondary" data-action="results-lobby">Return to lobby</button></div><p class="room-status" data-room-status role="status"></p><button class="text-button celebration-replay" data-action="replay-celebration">&#10022; Replay fireworks</button></section><section class="results-board glass-card"><div class="results-board-head"><span>FINAL RANKING</span><span>TURF · KOs</span></div>${rows.map((row, index) => `<div class="result-row ${index === 0 ? 'winner-row' : ''}"><span class="result-rank">${index === 0 ? '✦' : String(index + 1).padStart(2, '0')}</span><i style="background:${COLORS[row.color]}"></i><strong>${escapeHtml(row.nickname)}</strong><span>${row.territory.toFixed(1)}%</span><small>${row.knockouts} KO</small></div>`).join('')}<div class="result-footer"><button class="text-button" data-action="change-avatar">Change avatar</button><button class="text-button" data-action="share-results">Share results ↗</button><button class="text-button" data-action="exit-game">Exit game</button></div></section></main></div>`
    const canvas = this.root.querySelector<HTMLCanvasElement>('.victory-fireworks')
    if (canvas) this.fireworks = new VictoryFireworks(canvas, COLORS[winner?.color ?? 'yellow'], sound => this.playSound(sound))
    const portrait = this.root.querySelector<HTMLCanvasElement>('.champion-portrait')
    if (portrait && winner) this.engine.showChampion(portrait, winner.id)
    this.updateHostControls()
  }

  private closeCelebration(): void {
    this.fireworks?.dispose()
    this.fireworks = undefined
    this.engine.closeChampion()

  }

  private renderSettings(): void {
    this.engine.resetPreview()
    this.screen = 'settings'
    const settings = this.lobbySettings ?? this.room?.settings ?? appStore.get().settings
    this.root.innerHTML = `<div class="app-shell settings-screen">${this.topbar('settings')}<main class="settings-layout"><section class="settings-panel glass-card"><div class="step-label">CONTROL ROOM <span>PLAY YOUR WAY</span></div><h1>Dial in<br><em>the arena.</em></h1><p class="panel-subtitle">Balanced defaults are ready. Make the match yours.</p><div class="settings-grid" ${this.returnToLobbyFromSettings && !this.isHost() ? 'hidden' : ''}><label class="setting-field">Match duration<select data-field="duration"><option value="2" ${settings.duration === 2 ? 'selected' : ''}>2 minutes</option><option value="3" ${settings.duration === 3 ? 'selected' : ''}>3 minutes</option><option value="5" ${settings.duration === 5 ? 'selected' : ''}>5 minutes</option></select></label><label class="setting-field">Max players<select data-field="maxPlayers"><option value="4" ${settings.maxPlayers === 4 ? 'selected' : ''}>4 players</option><option value="6" ${settings.maxPlayers === 6 ? 'selected' : ''}>6 players</option><option value="8" ${settings.maxPlayers === 8 ? 'selected' : ''}>8 players</option></select></label><label class="setting-field">Arena theme<select data-field="theme"><option value="meadow" ${settings.theme === 'meadow' ? 'selected' : ''}>Green Meadow</option><option value="desert" ${settings.theme === 'desert' ? 'selected' : ''}>Desert Arena</option><option value="ice" ${settings.theme === 'ice' ? 'selected' : ''}>Ice Arena</option><option value="neon" ${settings.theme === 'neon' ? 'selected' : ''}>Neon Arena</option><option value="candy" ${settings.theme === 'candy' ? 'selected' : ''}>Candy World</option></select></label><label class="setting-field">Grid size<select data-field="arenaSize"><option value="40" ${settings.arenaSize === 40 ? 'selected' : ''}>40 × 40</option><option value="50" ${settings.arenaSize === 50 ? 'selected' : ''}>50 × 50</option><option value="60" ${settings.arenaSize === 60 ? 'selected' : ''}>60 × 60</option></select></label><label class="setting-field">Movement speed<input type="range" min="5" max="12" step="0.5" value="${settings.movementSpeed}" data-field="speed"><output>${settings.movementSpeed.toFixed(1)}</output></label><label class="setting-field">Respawn duration<input type="range" min="1" max="6" step="1" value="${settings.respawnDuration}" data-field="respawn"><output>${settings.respawnDuration}s</output></label></div><div class="toggle-list"><label><span><strong>Auto-run</strong><small>Tap a direction to keep moving. Press Space or the pause button to stop.</small></span><input type="checkbox" data-field="auto-run" ${appStore.get().autoRun ? 'checked' : ''}><i></i></label><label><span><strong>Background music</strong><small>Ambient arena loop</small></span><input type="checkbox" data-field="music" ${this.musicOn ? 'checked' : ''}><i></i></label><label><span><strong>Sound effects</strong><small>Captures, KOs and buttons</small></span><input type="checkbox" data-field="sfx" ${this.sfxOn ? 'checked' : ''}><i></i></label></div><button class="button button-primary" data-action="back">Save and return <span>→</span></button></section></main></div>`
  }

  private renderHowto(): void {
    this.screen = 'howto'
    this.root.innerHTML = `<div class="app-shell howto-screen">${this.topbar('howto')}<main class="howto-layout"><section class="howto-intro"><div class="step-label">FIELD GUIDE <span>THREE MOVES TO WIN</span></div><h1>Think in<br><em>big loops.</em></h1><p>Every bold move starts with a little risk. Leave home, draw a shape, and come back before someone cuts your trail.</p><button class="button button-primary" data-action="practice">Try it now <span>→</span></button></section><section class="howto-cards"><article class="how-card"><span class="how-number">01</span><div class="how-icon">↗</div><h2>Leave your turf</h2><p>Move outside your color to create an exposed trail. The farther you go, the more you can claim.</p></article><article class="how-card"><span class="how-number">02</span><div class="how-icon">◎</div><h2>Close the loop</h2><p>Return to your territory. The enclosed region floods with your color instantly.</p></article><article class="how-card"><span class="how-number">03</span><div class="how-icon">✦</div><h2>Cut the trail</h2><p>Cross an opponent’s exposed trail to knock them out. Your own trail is your weak spot too.</p></article></section></main></div>`
  }

  private topbar(active: string): string {
    return `<header class="topbar"><button class="brand" data-action="back"><span class="brand-mark"><i></i><i></i><i></i></span><span>TURF <b>CLASH</b></span></button><div class="topbar-center"><span class="topbar-status"><i></i> ARENA ONLINE-READY</span></div><div class="topbar-nav"><button class="round-icon" data-action="toggle-music" aria-label="Background music" aria-pressed="${this.musicOn}">${this.musicOn ? '◒' : '◌'}</button><button class="round-icon" data-action="settings" aria-label="Settings">⌘</button>${active !== 'home' ? '<button class="back-link" data-action="back">Exit <span>×</span></button>' : ''}</div></header>`
  }

  private updateHostControls(): void {
    const end = this.root.querySelector<HTMLButtonElement>('[data-action="end-match"]')
    if (end) end.hidden = Boolean(this.room && !this.isHost())
    const rematch = this.root.querySelector<HTMLButtonElement>('[data-action="play-again"]')
    if (rematch && this.room) {
      const host = this.isHost()
      const connected = this.room.players.filter(player => player.connected !== false)
      const ready = connected.length >= 2 && connected.every(player => player.ready)
      rematch.disabled = !host || !ready
      rematch.textContent = host ? (ready ? 'Play again' : 'Waiting for players') : 'Waiting for host'
    }
  }

  private updateScoreVisibility(): void {
    this.root.querySelectorAll<HTMLElement>('[data-score-panel]').forEach(panel => { panel.hidden = this.scoresHidden })
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-scores"]')
    if (!toggle) return
    toggle.setAttribute('aria-expanded', String(!this.scoresHidden))
    const label = this.scoresHidden ? 'Show scores and map' : 'Hide scores and map'
    toggle.setAttribute('aria-label', label)
    toggle.title = label
  }

  private bindArenaPan(): void {
    const surface = this.root.querySelector<HTMLElement>('[data-arena-pan]')
    if (!surface) return
    let drag: { id: number; x: number; y: number } | undefined
    surface.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return
      surface.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    })
    surface.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return
      this.engine.panCamera(drag.x, drag.y, event.clientX, event.clientY)
      drag.x = event.clientX
      drag.y = event.clientY
    })
    surface.addEventListener('lostpointercapture', event => {
      if (drag?.id === event.pointerId) drag = undefined
    })
  }

  private stopMovement(): void {
    this.held.clear()
    this.input = { x: 0, z: 0 }
    this.autoDirection = { x: 0, z: 0 }
    const knob = this.root.querySelector<HTMLElement>('.joystick-knob')
    if (knob) knob.style.transform = 'translate(-50%, -50%)'
    if (this.room?.localId && this.screen === 'game') this.multiplayer.send({ type: 'input', x: 0, z: 0 })
  }

  private bindJoystick(): void {
    const joystick = this.root.querySelector<HTMLElement>('[data-joystick]')
    const knob = joystick?.querySelector<HTMLElement>('.joystick-knob')
    if (!joystick || !knob) return
    const reset = () => { this.input = { x: 0, z: 0 }; knob.style.transform = 'translate(-50%, -50%)' }
    const move = (event: PointerEvent) => {
      const rect = joystick.getBoundingClientRect(); const dx = event.clientX - (rect.left + rect.width / 2); const dy = event.clientY - (rect.top + rect.height / 2); const max = rect.width * 0.34; const length = Math.min(max, Math.hypot(dx, dy)); const angle = Math.atan2(dy, dx); const x = Math.cos(angle) * length; const y = Math.sin(angle) * length; knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`; this.input = { x: x / max, z: y / max }
      if (Math.hypot(this.input.x, this.input.z) > 0.05) this.autoDirection = this.input
    }
    joystick.addEventListener('pointerdown', event => { joystick.setPointerCapture(event.pointerId); move(event) })
    joystick.addEventListener('pointermove', event => { if (joystick.hasPointerCapture(event.pointerId)) move(event) })
    joystick.addEventListener('lostpointercapture', reset)
  }

  private copyRoom(): void {
    const invite = new URL(window.location.href)
    invite.search = ''
    invite.searchParams.set('room', this.roomCode)
    const showLink = () => {
      const input = this.root.querySelector<HTMLInputElement>('[data-invite-link]')
      if (!input) return
      input.value = invite.href
      input.hidden = false
      input.select()
      this.setRoomMessage('Select and copy the invite link.')
    }
    if (!navigator.clipboard) { showLink(); return }
    void navigator.clipboard.writeText(invite.href).then(() => this.setRoomMessage('Invite link copied.')).catch(showLink)
  }

  private shareResults(): void {
    const text = `I just played Turf Clash — claim your corner and beat my score.`
    if (navigator.share) navigator.share({ title: 'Turf Clash', text }).catch(() => undefined)
    else navigator.clipboard?.writeText(text).then(() => this.showToast('Result note copied.')).catch(() => this.showToast(text))
  }

  private showToast(message: string): void {
    this.toastText = message
    this.root.dataset.toast = this.toastText
    if (this.toastTimer) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => { this.toastText = '' }, 2400)
  }

  private themeLabel(theme: string): string { return ({ meadow: 'Green Meadow', desert: 'Desert Arena', ice: 'Ice Arena', neon: 'Neon Arena', candy: 'Candy World' } as Record<string, string>)[theme] ?? 'Green Meadow' }

  private enableAudio(): void {
    if (typeof AudioContext === 'undefined') return
    this.audio ??= new Audio()
    this.audio.unlock()
    this.syncAudio()
  }

  private syncAudio(): void {
    this.audio?.setVolumes(this.musicOn ? 0.55 : 0, this.sfxOn ? 0.65 : 0)
    if (this.musicOn) this.audio?.startMusic()
    else this.audio?.stopMusic()
  }

  private playSound(sound: Sfx): void {
    if (this.sfxOn) this.audio?.play(sound)
  }

  handleEngineEvent(event: EngineEvent): void {
    if (event.type === 'step') this.playSound('step')
    if (event.type === 'countdown') {
      const count = this.root.querySelector('[data-hud="countdown"]')
      if (count) count.textContent = event.value ? String(event.value) : ''
      this.playSound(event.value ? 'count' : 'go')
    }
    if (event.type === 'capture') this.playSound('capture')
    if (event.type === 'knockout') this.playSound(event.playerId === (this.room?.localId ?? 'local') ? 'fall' : 'bump')
    if (event.type === 'respawn' && event.playerId === (this.room?.localId ?? 'local')) this.playSound('join')
    if ((event.type === 'respawn' || event.type === 'knockout' || event.type === 'eliminated')
      && event.playerId === (this.room?.localId ?? 'local')) this.stopMovement()
    if (event.type === 'finished') {
      this.showResults(event.snapshot)
    }
  }
}
