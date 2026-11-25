import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { COLORS, DEFAULT_AVATAR, type AvatarConfig, type ArenaTheme, type GameSnapshot, type LeaderboardRow, type MatchSettings, type PlayerProfile } from './types'
import { createTerritory, gridCoord, territoryPercent } from './territory'
import { TurfMatch, practiceRoster, type RuleEvent } from './match'

export type EngineEvent = RuleEvent | { type: 'step' } | { type: 'finished'; snapshot: GameSnapshot }

export interface EngineCallbacks {
  onEvent: (event: EngineEvent) => void
  onSnapshot: (snapshot: GameSnapshot) => void
}

const THEME_COLORS: Record<ArenaTheme, { neutral: string; ground: string; edge: string }> = {
  meadow: { neutral: '#2a2619', ground: '#13110d', edge: '#b28a28' },
  desert: { neutral: '#eadfc8', ground: '#d5bd91', edge: '#a9895b' },
  ice: { neutral: '#d5eaf1', ground: '#aacedd', edge: '#78a7bd' },
  neon: { neutral: '#1b2a3a', ground: '#101b29', edge: '#385c76' },
  candy: { neutral: '#f6dfea', ground: '#efc3d8', edge: '#c989b0' },
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }

class RobotAvatar {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly leftArm = new THREE.Group()
  private readonly rightArm = new THREE.Group()
  private readonly leftLeg = new THREE.Group()
  private readonly rightLeg = new THREE.Group()
  private readonly antenna = new THREE.Group()
  private readonly cap = new THREE.Group()
  private readonly headCrown = new THREE.Group()
  private readonly shades = new THREE.Group()
  private readonly scarf = new THREE.Group()
  private readonly visor = new THREE.Group()
  private readonly badge = new THREE.Group()
  private readonly eyes: THREE.Mesh[] = []
  private readonly mouth = new THREE.Group()
  private readonly smile = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.035, 8, 16, Math.PI), new THREE.MeshStandardMaterial({ color: '#182338' }))
  private readonly roundMouth = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), this.smile.material)
  private readonly accent: THREE.MeshStandardMaterial
  private readonly primary: THREE.MeshStandardMaterial
  private readonly face: THREE.MeshStandardMaterial
  private readonly nameSprite: THREE.Sprite
  private readonly modelRoot = new THREE.Group()
  private mixer?: THREE.AnimationMixer
  private idleAction?: THREE.AnimationAction
  private runAction?: THREE.AnimationAction
  private gait = 0
  private stridePhase = 0
  private elapsed = Math.random() * 3
  private config: AvatarConfig = { ...DEFAULT_AVATAR }
  private name: string
  private usingGeneratedModel = false

  constructor(name: string, config: AvatarConfig, isLocal = false) {
    this.config = { ...config }
    this.name = name
    this.primary = new THREE.MeshStandardMaterial({ color: COLORS[config.color], roughness: 0.56, metalness: 0.08 })
    this.accent = new THREE.MeshStandardMaterial({ color: isLocal ? '#fff7d6' : '#f8fbff', roughness: 0.35, metalness: 0.14 })
    this.face = new THREE.MeshStandardMaterial({ color: '#182338', roughness: 0.3, metalness: 0.2 })
    this.nameSprite = this.makeName(name, isLocal)
    this.root.add(this.modelRoot, this.body, this.nameSprite)
    this.root.scale.setScalar(1.28)
    this.buildProcedural()
    this.setConfig(config)
    this.nameSprite.position.set(0, 2.85, 0)
    this.nameSprite.scale.set(2.15, 0.48, 1)
  }

  private buildProcedural(): void {
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.92, 0.98), this.primary)
    head.position.y = 1.35
    head.castShadow = true
    this.body.add(head)
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.62), this.primary)
    torso.position.y = 0.55
    torso.castShadow = true
    this.body.add(torso)
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 0.67), this.accent)
    chest.position.set(0, 0.62, 0.03)
    this.body.add(chest)
    const eyeGeometry = new THREE.SphereGeometry(0.12, 12, 8)
    const eyeL = new THREE.Mesh(eyeGeometry, this.accent)
    const eyeR = new THREE.Mesh(eyeGeometry, this.accent)
    eyeL.position.set(-0.23, 1.42, 0.51)
    eyeR.position.set(0.23, 1.42, 0.51)
    this.body.add(eyeL, eyeR)
    this.eyes.push(eyeL, eyeR)
    this.smile.rotation.x = Math.PI
    this.roundMouth.scale.z = 0.35
    this.mouth.position.set(0, 1.18, 0.52)
    this.mouth.add(this.smile, this.roundMouth)
    this.body.add(this.mouth)
    this.attachLimb(this.leftArm, -0.6, 0.62, 0.17, 0.55)
    this.attachLimb(this.rightArm, 0.6, 0.62, 0.17, 0.55)
    this.attachLimb(this.leftLeg, -0.22, 0.02, 0.18, 0.48)
    this.attachLimb(this.rightLeg, 0.22, 0.02, 0.18, 0.48)
    this.body.add(this.leftArm, this.rightArm, this.leftLeg, this.rightLeg)
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.24, 8), this.accent)
    antenna.position.set(0, 1.96, 0)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), new THREE.MeshStandardMaterial({ color: '#ff8c70', emissive: '#522219', emissiveIntensity: 0.8 }))
    tip.position.set(0, 2.1, 0)
    this.antenna.add(antenna, tip)
    const gold = new THREE.MeshStandardMaterial({ color: '#ffcc42', metalness: 0.35, roughness: 0.36 })
    const fabric = new THREE.MeshStandardMaterial({ color: '#fa5967', roughness: 0.9 })
    const glass = new THREE.MeshStandardMaterial({ color: '#36c9f0', roughness: 0.18, metalness: 0.42 })
    const piece = (group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      group.add(mesh)
    }
    piece(this.cap, new THREE.BoxGeometry(1.16, 0.24, 0.98), this.face, 0, 1.88, 0)
    piece(this.cap, new THREE.BoxGeometry(0.85, 0.075, 0.48), gold, 0, 1.79, 0.55)
    piece(this.headCrown, new THREE.CylinderGeometry(0.44, 0.42, 0.13, 12), gold, 0, 1.87, 0)
    for (let index = 0; index < 5; index += 1) {
      const angle = index / 5 * Math.PI * 2
      piece(this.headCrown, new THREE.ConeGeometry(0.13, 0.31, 4), gold, Math.sin(angle) * 0.38, 2.06, Math.cos(angle) * 0.38)
    }
    for (const x of [-0.23, 0.23]) piece(this.shades, new THREE.BoxGeometry(0.36, 0.19, 0.10), this.face, x, 1.42, 0.62)
    piece(this.shades, new THREE.BoxGeometry(0.18, 0.055, 0.10), this.face, 0, 1.45, 0.63)
    piece(this.scarf, new THREE.BoxGeometry(0.91, 0.16, 0.69), fabric, 0, 0.95, 0.03)
    piece(this.scarf, new THREE.BoxGeometry(0.21, 0.36, 0.09), fabric, 0.30, 0.76, 0.39)
    piece(this.visor, new THREE.BoxGeometry(1.13, 0.12, 0.23), glass, 0, 1.63, 0.50)
    piece(this.badge, new THREE.OctahedronGeometry(0.15), gold, 0.24, 0.65, 0.39)
    this.body.add(this.antenna, this.cap, this.headCrown, this.shades, this.scarf, this.visor, this.badge)
  }

  private attachLimb(group: THREE.Group, x: number, y: number, width: number, height: number): void {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(width, height, 5, 10), this.primary)
    group.position.set(x, y + height / 2, 0)
    mesh.position.y = -height / 2
    mesh.castShadow = true
    group.add(mesh)
  }

  private makeName(name: string, local: boolean): THREE.Sprite {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 112
    this.paintName(canvas, name, local)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
  }

  setName(name: string): void {
    if (this.name === name) return
    this.name = name
    const texture = this.nameSprite.material.map
    if (!texture) return
    this.paintName(texture.image as HTMLCanvasElement, name, true)
    texture.needsUpdate = true
  }

  private paintName(canvas: HTMLCanvasElement, name: string, local: boolean): void {
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = `${local ? '700' : '600'} 42px ManusCC0, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(12, 27, 46, 0.78)'
    this.roundedRect(ctx, 8, 11, 496, 86, 26)
    ctx.fill()
    ctx.fillStyle = '#f6fbff'
    ctx.fillText(name.slice(0, 12), 256, 68)
  }

  private roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
  }

  setConfig(config: AvatarConfig): void {
    this.config = { ...config }
    this.primary.color.set(COLORS[config.color])
    this.modelRoot.traverse(object => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
        object.material.color.set(COLORS[config.color])
      }
    })
    this.antenna.visible = config.hat === 'antenna'
    this.cap.visible = config.hat === 'cap'
    this.headCrown.visible = config.hat === 'crown'
    this.shades.visible = config.sunglasses
    this.scarf.visible = config.accessory === 'scarf'
    this.visor.visible = config.accessory === 'visor'
    this.badge.visible = config.accessory === 'badge'
    this.eyes.forEach((eye, index) => {
      eye.scale.set(config.expression === 'surprised' ? 1.22 : 1, config.expression === 'sleepy' ? 0.24 : config.expression === 'focused' ? 0.54 : 1, 1)
      eye.rotation.z = config.expression === 'focused' ? (index === 0 ? -0.36 : 0.36) : 0
    })
    this.smile.visible = config.expression !== 'surprised'
    this.smile.scale.set(1, config.expression === 'sleepy' || config.expression === 'focused' ? 0.22 : 1, 1)
    this.roundMouth.visible = config.expression === 'surprised'
    const usesRig = Boolean(this.mixer) && config.hat === DEFAULT_AVATAR.hat && !config.sunglasses
      && config.expression === DEFAULT_AVATAR.expression && config.accessory === 'none'
    this.modelRoot.visible = usesRig
    this.body.visible = !usesRig
  }

  async loadGeneratedModel(): Promise<void> {
    if (this.usingGeneratedModel) return
    await new Promise<void>(resolve => {
      new GLTFLoader().load('/assets/models/turf-clash-hero-robot-animated.glb', gltf => {
        const model = gltf.scene
        model.scale.setScalar(1.02)
        model.position.y = 0.12
        // The imported rig faces +X. Match the procedural robots' +Z forward axis.
        this.modelRoot.rotation.y = -Math.PI / 2
        model.traverse(object => {
          const mesh = object as THREE.Mesh
          if (mesh.isMesh) {
            mesh.castShadow = true
            mesh.receiveShadow = true
            const material = mesh.material as THREE.MeshStandardMaterial
            if (material?.color) material.color.set(COLORS[this.config.color])
          }
        })
        this.modelRoot.add(model)
        const idle = THREE.AnimationClip.findByName(gltf.animations, 'idle')
        const run = THREE.AnimationClip.findByName(gltf.animations, 'run')
        if (idle && run) {
          this.mixer = new THREE.AnimationMixer(model)
          this.idleAction = this.mixer.clipAction(idle).play()
          this.runAction = this.mixer.clipAction(run).setEffectiveWeight(0).play()
          this.setConfig(this.config)
        } else {
          model.visible = false
        }
        this.usingGeneratedModel = true
        resolve()
      }, undefined, () => resolve())
    })
  }

  update(dt: number, moving: boolean): void {
    this.elapsed += dt
    this.gait = THREE.MathUtils.lerp(this.gait, moving ? 1 : 0, 1 - Math.exp(-dt * 12))
    this.stridePhase += dt * 12
    const stride = Math.sin(this.stridePhase) * this.gait
    this.body.position.y = 0.44 + Math.sin(this.elapsed * 3) * 0.025 + Math.abs(stride) * 0.07
    this.leftArm.rotation.x = -stride * 0.65
    this.rightArm.rotation.x = stride * 0.65
    this.leftLeg.rotation.x = stride * 0.58
    this.rightLeg.rotation.x = -stride * 0.58
    this.idleAction?.setEffectiveWeight(1 - this.gait)
    this.runAction?.setEffectiveWeight(this.gait)
    this.mixer?.update(dt)
  }

  faceDirection(x: number, z: number): void {
    this.root.rotation.y = Math.atan2(x, z)
  }

  drawPortrait(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, crown: THREE.Group, dt: number): void {
    const parent = this.root.parent
    const position = this.root.position.clone()
    const rotation = this.root.rotation.y
    const scale = this.root.scale.x
    const visible = this.root.visible
    scene.add(this.root)
    this.root.visible = true
    this.nameSprite.visible = false
    const headwear = [this.antenna, this.cap, this.headCrown]
    const headwearVisibility = headwear.map(item => item.visible)
    if (crown.visible) headwear.forEach(item => { item.visible = false })
    this.root.position.set(0, 0, 0)
    this.root.rotation.y = Math.sin(this.elapsed * 0.9) * 0.25
    this.root.scale.setScalar(this.body.visible ? 1 : 1.78)
    this.update(dt, false)
    crown.position.y = this.body.visible ? this.body.position.y + 1.87 : 2.10
    try {
      renderer.render(scene, camera)
    } finally {
      parent?.add(this.root)
      this.root.position.copy(position)
      this.root.rotation.y = rotation
      this.root.scale.setScalar(scale)
      this.root.visible = visible
      this.nameSprite.visible = true
      headwear.forEach((item, index) => { item.visible = headwearVisibility[index] })
    }
  }
}

class AvatarPortrait {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30)
  private readonly crown = new THREE.Group()

  constructor(private readonly canvas: HTMLCanvasElement, private readonly avatar: RobotAvatar, crowned: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.camera.position.set(0, 1.77, 5.7)
    this.camera.lookAt(0, 1.42, 0)
    const light = new THREE.DirectionalLight('#fff0d0', 3)
    light.position.set(-3, 5, 4)
    this.scene.add(this.crown, light, new THREE.HemisphereLight('#fff5e5', '#a26d39', 2))
    this.crown.visible = crowned
    if (!crowned) return
    const gold = new THREE.MeshStandardMaterial({ color: '#ffca46', emissive: '#684000', metalness: 0.45, roughness: 0.34 })
    this.crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.34, 0.14, 16, 1, true), gold))
    const point = new THREE.ConeGeometry(0.135, 0.28, 4)
    const jewel = new THREE.SphereGeometry(0.05, 8, 6)
    for (let i = 0; i < 6; i += 1) {
      const angle = i / 6 * Math.PI * 2
      const x = Math.sin(angle) * 0.34
      const z = Math.cos(angle) * 0.34
      const spike = new THREE.Mesh(point, gold)
      spike.position.set(x, 0.18, z)
      const tip = new THREE.Mesh(jewel, gold)
      tip.position.set(x, 0.32, z)
      this.crown.add(spike, tip)
    }
  }

  update(dt: number): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (!width || !height) return
    const dimensions = this.renderer.getSize(new THREE.Vector2())
    if (dimensions.x !== width || dimensions.y !== height) {
      this.renderer.setSize(width, height, false)
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
    this.avatar.drawPortrait(this.renderer, this.scene, this.camera, this.crown, dt)
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>()
    this.crown.traverse(child => { if (child instanceof THREE.Mesh) geometries.add(child.geometry) })
    for (const geometry of geometries) geometry.dispose()
    const band = this.crown.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    band?.material.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}

export class TurfEngine {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600)
  readonly renderer: THREE.WebGLRenderer
  private readonly root = new THREE.Group()
  private readonly board = new THREE.Group()
  private readonly actors = new THREE.Group()
  private readonly tile: THREE.InstancedMesh
  private readonly trailMesh: THREE.InstancedMesh
  private readonly floor: THREE.Mesh
  private readonly themeLight = new THREE.HemisphereLight('#f4fbff', '#99b7b1', 2.2)
  private readonly sun = new THREE.DirectionalLight('#fff6df', 3.2)
  private readonly localAvatar = new RobotAvatar('Nova', DEFAULT_AVATAR, true)
  private readonly avatars = new Map<string, RobotAvatar>()
  private callbacks: EngineCallbacks
  private settings: MatchSettings
  private profile: PlayerProfile
  private players: PlayerProfile[] = []
  private territory: Int8Array = createTerritory(60)
  private trail: Int8Array = new Int8Array(60 * 60).fill(-1)
  private size = 60
  private countdown = 3
  private localMatch?: TurfMatch
  private remoteMatch = false
  private boardVersion = -1
  private timeLeft = 180
  private phase: GameSnapshot['phase'] = 'countdown'
  private preview = true
  private cameraDistance = 40
  private cameraMode: 'follow' | 'overview' | 'pan' = 'follow'
  private readonly cameraTarget = new THREE.Vector3()
  private readonly panTarget = new THREE.Vector3()
  private readonly panRay = new THREE.Raycaster()
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0))
  private boardDirty = true
  private stepDistance = 0
  private champion?: AvatarPortrait
  private lastSnapshot = 0
  private notificationBuffer: string[] = []

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks, settings: MatchSettings) {
    this.callbacks = callbacks
    this.settings = settings
    this.profile = new TurfMatch(settings, practiceRoster('Nova', DEFAULT_AVATAR)).players[0]
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.scene.fog = new THREE.Fog('#c9dedb', 48, 130)
    this.scene.add(this.root)
    this.root.add(this.board, this.actors)
    this.sun.position.set(18, 36, 12)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(1024, 1024)
    this.scene.add(this.themeLight, this.sun)
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ fog: false }))
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = -0.18
    this.root.add(this.floor)
    const tileGeometry = new THREE.BoxGeometry(1, 0.2, 1)
    this.tile = new THREE.InstancedMesh(tileGeometry, new THREE.MeshBasicMaterial({ fog: false }), 60 * 60)
    this.tile.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.tile.castShadow = true
    this.tile.receiveShadow = true
    this.board.add(this.tile)
    const trailMaterial = new THREE.MeshBasicMaterial({ fog: false })
    this.trailMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.72, 0.1, 0.72), trailMaterial, 60 * 60)
    this.trailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.board.add(this.trailMesh)
    void this.localAvatar.loadGeneratedModel()
    this.actors.add(this.localAvatar.root)
    this.resize()
    window.addEventListener('resize', this.resize)
    this.applyTheme(settings.theme)
    this.resetPreview()
  }

  resetPreview(): void {
    this.closeChampion()
    this.localMatch = undefined
    this.remoteMatch = false
    this.preview = true
    this.phase = 'countdown'
    this.localAvatar.root.position.set(0, 0, 0)
    this.localAvatar.root.visible = true
    this.board.visible = true
    this.actors.visible = true
    for (const avatar of this.avatars.values()) avatar.root.visible = false
    this.renderBoard()
    this.cameraDistance = 21
    this.cameraTarget.set(0, 0, 0)
    this.camera.position.set(0, 12, 18)
    this.camera.lookAt(0, 0.2, 0)
  }

  setPreview(config: AvatarConfig, nickname: string): void {
    this.localAvatar.setConfig(config)
    this.localAvatar.setName(nickname)
    this.profile.nickname = nickname
    this.localAvatar.root.visible = true
  }

  start(settings: MatchSettings, nickname: string, avatar: AvatarConfig): void {
    const match = new TurfMatch(settings, practiceRoster(nickname, avatar), event => this.callbacks.onEvent(event))
    this.beginMatch(match.snapshot('local'), false)
    this.localMatch = match
    this.syncLocalMatch()
  }

  beginRemoteMatch(snapshot: GameSnapshot): void {
    this.beginMatch(snapshot, true)
  }

  applyRemoteSnapshot(snapshot: GameSnapshot, boardVersion: number): void {
    if (!this.remoteMatch) return
    this.players = snapshot.players
    this.profile = this.players.find(player => player.id === snapshot.localId) ?? this.profile
    this.phase = snapshot.phase
    this.countdown = snapshot.countdown
    this.timeLeft = snapshot.timeLeft
    if (boardVersion !== this.boardVersion) {
      this.territory = snapshot.territory
      this.trail = snapshot.trail
      this.boardDirty = true
      this.boardVersion = boardVersion
    }
  }

  private beginMatch(snapshot: GameSnapshot, remote: boolean): void {
    this.closeChampion()
    this.localMatch = undefined
    this.remoteMatch = remote
    this.preview = false
    this.settings = snapshot.settings
    this.players = snapshot.players
    this.profile = this.players.find(player => player.id === snapshot.localId)!
    this.territory = snapshot.territory
    this.trail = snapshot.trail
    this.phase = snapshot.phase
    this.countdown = snapshot.countdown
    this.timeLeft = snapshot.timeLeft
    this.size = snapshot.settings.arenaSize
    this.boardVersion = -1
    this.stepDistance = 1.5
    this.lastSnapshot = 0
    this.notificationBuffer = []
    this.avatars.clear()
    this.actors.clear()
    this.actors.add(this.localAvatar.root)
    for (const player of this.players) {
      if (player.id === this.profile.id) continue
      const avatar = new RobotAvatar(player.nickname, player.avatar)
      this.avatars.set(player.id, avatar)
      this.actors.add(avatar.root)
    }
    this.localAvatar.setConfig(this.profile.avatar)
    this.localAvatar.setName(this.profile.nickname)
    this.updateAvatars(0)
    this.followPlayer()
    this.cameraTarget.set(this.profile.x, 0, this.profile.z)
    this.camera.position.copy(this.cameraTarget).add(new THREE.Vector3(0, 14, 20.5))
    this.applyTheme(this.settings.theme)
    this.renderBoard()
  }

  private syncLocalMatch(): void {
    const match = this.localMatch
    if (!match) return
    this.players = match.players
    this.profile = match.players[0]
    this.territory = match.territory
    this.trail = match.trail
    this.phase = match.phase
    this.countdown = match.countdown
    this.timeLeft = match.timeLeft
    if (this.boardVersion !== match.boardVersion) {
      this.boardVersion = match.boardVersion
      this.boardDirty = true
    }
  }

  followPlayer(): void {
    this.cameraMode = 'follow'
    this.cameraDistance = 25
  }

  showArena(): void {
    this.cameraMode = 'overview'
  }

  private overviewDistance(): number {
    const vertical = THREE.MathUtils.degToRad(this.camera.fov / 2)
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect)
    const halfAngle = Math.min(vertical, horizontal)
    return (this.size / Math.SQRT2 + 3) / Math.sin(halfAngle)
  }

  zoom(delta: number): void {
    if (this.cameraMode === 'overview') {
      this.cameraMode = 'pan'
      this.panTarget.set(-0.5, 0, -0.5)
      this.cameraDistance = this.overviewDistance()
    }
    this.cameraDistance = clamp(this.cameraDistance + delta, 17, this.overviewDistance())
  }

  panCamera(fromX: number, fromY: number, toX: number, toY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const hit = (x: number, y: number) => {
      const ndc = new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2)
      this.panRay.setFromCamera(ndc, this.camera)
      return this.panRay.ray.intersectPlane(this.groundPlane, new THREE.Vector3())
    }
    this.camera.updateMatrixWorld()
    const before = hit(fromX, fromY)
    const after = hit(toX, toY)
    if (!before || !after) return
    if (this.cameraMode !== 'pan') {
      if (this.cameraMode === 'overview') this.cameraDistance = this.overviewDistance()
      this.panTarget.copy(this.cameraTarget)
      this.cameraMode = 'pan'
    }
    this.panTarget.add(before.sub(after))
    const half = this.size / 2
    this.panTarget.x = clamp(this.panTarget.x, -half, half - 1)
    this.panTarget.z = clamp(this.panTarget.z, -half, half - 1)
  }
  endNow(): void {
    if (!this.localMatch || this.phase === 'ended') return
    this.localMatch.end()
    this.syncLocalMatch()
    this.finish()
  }
  getPhase(): GameSnapshot['phase'] { return this.phase }
  getPlayers(): PlayerProfile[] { return this.players.map(player => ({ ...player, trail: [...player.trail] })) }
  getLeaderboard(): LeaderboardRow[] { return this.players.map(player => ({ id: player.id, nickname: player.nickname, color: player.color, territory: territoryPercent(this.territory, this.players.indexOf(player)), knockouts: player.knockouts, bot: player.bot })).sort((a, b) => b.territory - a.territory || b.knockouts - a.knockouts) }
  getSettings(): MatchSettings { return { ...this.settings } }
  getLocalPlayer(): PlayerProfile { return { ...this.profile, trail: [...this.profile.trail] } }
  getSnapshot(): GameSnapshot { return { phase: this.phase, countdown: this.countdown, timeLeft: this.timeLeft, players: this.getPlayers(), territory: this.territory.slice(), trail: this.trail.slice(), settings: { ...this.settings }, notifications: [...this.notificationBuffer], localId: this.profile.id } }

  update(dt: number, input: { x: number; z: number }): void {
    if (this.champion) {
      this.champion.update(dt)
      return
    }
    if (this.preview) {
      this.localAvatar.update(dt, false)
      this.localAvatar.root.rotation.y += dt * 0.28
      this.render(dt)
      return
    }
    const match = this.localMatch
    if (match) {
      match.update(dt, new Map([['local', input]]))
      this.syncLocalMatch()
      if (this.phase === 'ended') {
        this.finish()
        return
      }
    }
    this.updateAvatars(dt)
    this.render(dt)
    this.lastSnapshot += dt
    if (this.lastSnapshot >= 0.08) {
      this.lastSnapshot = 0
      this.callbacks.onSnapshot(this.getSnapshot())
    }
  }

  showChampion(canvas: HTMLCanvasElement, winnerId: string): void {
    this.closeChampion()
    const avatar = winnerId === this.profile.id ? this.localAvatar : this.avatars.get(winnerId)
    if (avatar) this.champion = new AvatarPortrait(canvas, avatar, true)
  }

  showAvatarPreview(canvas: HTMLCanvasElement): void {
    this.closeChampion()
    this.champion = new AvatarPortrait(canvas, this.localAvatar, false)
  }

  closeChampion(): void {
    this.champion?.dispose()
    this.champion = undefined
  }

  private finish(): void {
    const snapshot = this.getSnapshot()
    this.callbacks.onEvent({ type: 'finished', snapshot })
    this.callbacks.onSnapshot(snapshot)
  }

  private applyTheme(theme: ArenaTheme): void {
    const colors = THEME_COLORS[theme]
    this.scene.fog = new THREE.Fog(colors.ground, 46, 128)
    this.themeLight.color.set(theme === 'neon' ? '#a4c9ff' : '#f4fbff')
    this.sun.color.set(theme === 'desert' ? '#ffe8bd' : '#fff6df')
  }

  private renderBoard(): void {
    const previewColors = THEME_COLORS[this.settings.theme]
    const neutral = new THREE.Color(this.preview ? previewColors.neutral : '#ffffff')
    const alternate = new THREE.Color(this.preview ? previewColors.neutral : '#ebedf0')
    const floorSize = this.preview ? 120 : this.size
    const floorCenter = this.preview ? 0 : -0.5
    this.floor.position.set(floorCenter, -0.18, floorCenter)
    this.floor.scale.set(floorSize, floorSize, 1)
    ;(this.floor.material as THREE.MeshBasicMaterial).color.set(this.preview ? previewColors.ground : '#ffffff')
    const ownerColors = this.preview ? [] : this.players.map(player => new THREE.Color(COLORS[player.color]))
    const temp = new THREE.Object3D()
    this.tile.count = this.size * this.size
    let trailSlot = 0
    for (let index = 0; index < this.tile.count; index += 1) {
      const { x, z } = gridCoord(index, this.size)
      const ownerColor = ownerColors[this.territory[index]]
      temp.position.set(x - this.size / 2, ownerColor ? 0.04 : 0, z - this.size / 2)
      const tileWidth = ownerColor ? 1 : 0.92
      temp.scale.set(tileWidth, ownerColor ? 1.2 : 0.75, tileWidth)
      temp.updateMatrix()
      this.tile.setMatrixAt(index, temp.matrix)
      this.tile.setColorAt(index, ownerColor ?? ((x + z) % 2 === 0 ? neutral : alternate))

      const trailColor = ownerColors[this.trail[index]]
      if (!trailColor) continue
      temp.position.y = 0.18
      temp.scale.setScalar(1)
      temp.updateMatrix()
      this.trailMesh.setMatrixAt(trailSlot, temp.matrix)
      this.trailMesh.setColorAt(trailSlot, trailColor)
      trailSlot += 1
    }
    this.trailMesh.count = trailSlot
    this.tile.instanceMatrix.needsUpdate = true
    this.trailMesh.instanceMatrix.needsUpdate = true
    if (this.tile.instanceColor) this.tile.instanceColor.needsUpdate = true
    if (this.trailMesh.instanceColor) this.trailMesh.instanceColor.needsUpdate = true
    this.tile.computeBoundingSphere()
    this.trailMesh.computeBoundingSphere()
    this.boardDirty = false
  }

  private updateAvatars(dt: number): void {
    for (const player of this.players) {
      const avatar = player.id === this.profile.id ? this.localAvatar : this.avatars.get(player.id)
      if (!avatar) continue
      const wasVisible = avatar.root.visible
      const dx = player.x - avatar.root.position.x
      const dz = player.z - avatar.root.position.z
      const distance = Math.hypot(dx, dz)
      const moving = this.phase === 'live' && player.alive && wasVisible
        && distance > 0.001 && dt > 0 && distance <= (this.remoteMatch ? 2 : this.settings.movementSpeed * dt + 0.001)
      if (moving) avatar.faceDirection(dx, dz)
      if (moving && player.id === this.profile.id) {
        this.stepDistance += this.remoteMatch ? Math.min(distance, this.settings.movementSpeed * dt) : distance
        if (this.stepDistance >= 2) {
          this.stepDistance -= 2
          this.callbacks.onEvent({ type: 'step' })
        }
      }
      const blend = this.remoteMatch && moving ? 1 - Math.exp(-dt * 24) : 1
      avatar.root.position.set(avatar.root.position.x + dx * blend, 0.16, avatar.root.position.z + dz * blend)
      avatar.root.visible = player.alive
      avatar.update(dt, moving)
    }
  }

  private render(dt: number): void {
    if (this.boardDirty) this.renderBoard()
    const overview = !this.preview && this.cameraMode === 'overview'
    const target = new THREE.Vector3()
    if (overview) target.set(-0.5, 0, -0.5)
    else if (!this.preview && this.cameraMode === 'pan') target.copy(this.panTarget)
    else if (!this.preview) target.set(this.profile.x, 0, this.profile.z)
    const distance = overview ? this.overviewDistance() : this.cameraDistance
    const easing = 1 - Math.exp(-dt * 12)
    this.cameraTarget.lerp(target, easing)
    const desiredHeight = distance * 0.56
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, desiredHeight, easing)
    this.camera.position.x = this.cameraTarget.x
    this.camera.position.z = this.cameraTarget.z + this.camera.position.y * (0.82 / 0.56)
    this.camera.lookAt(this.cameraTarget)
    this.renderer.render(this.scene, this.camera)
  }

  resize = (): void => {
    const width = this.renderer.domElement.clientWidth || window.innerWidth
    const height = this.renderer.domElement.clientHeight || window.innerHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
  }

  pushNotification(message: string): void {
    this.notificationBuffer = [message, ...this.notificationBuffer].slice(0, 4)
  }

  setCallbacks(callbacks: EngineCallbacks): void { this.callbacks = callbacks }
}
