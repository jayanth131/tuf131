type FireworkSound = 'win' | 'firework-launch' | 'firework-burst'

const displays = [
  { at: 0.02, x: 0.15, y: 0.28, color: 0, radius: 0.25, willow: false },
  { at: 0.58, x: 0.84, y: 0.23, color: 1, radius: 0.27, willow: false },
  { at: 1.72, x: 0.51, y: 0.13, color: 2, radius: 0.20, willow: true },
  { at: 2.70, x: 0.13, y: 0.42, color: 1, radius: 0.24, willow: false },
  { at: 3.12, x: 0.88, y: 0.37, color: 0, radius: 0.26, willow: true },
  { at: 4.38, x: 0.22, y: 0.20, color: 2, radius: 0.25, willow: false },
  { at: 4.64, x: 0.77, y: 0.19, color: 1, radius: 0.28, willow: false },
]
const flightTime = 0.72
const sparkTime = 2.7
const cycleTime = 7.8

export class VictoryFireworks {
  private readonly context: CanvasRenderingContext2D | null
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly palette: string[]
  private readonly sparks = displays.map(shot => Array.from({ length: shot.willow ? 96 : 120 }, () => {
    const azimuth = Math.random() * Math.PI * 2
    const depth = Math.random() * 2 - 1
    const projection = Math.sqrt(1 - depth * depth)
    return {
      x: Math.cos(azimuth) * projection,
      y: Math.sin(azimuth) * projection,
      speed: 0.74 + Math.random() * 0.50,
      life: shot.willow ? 1.5 + Math.random() * 1.14 : 0.85 + Math.random() * 1.32,
      width: 0.6 + Math.random() * 1.15,
      twinkle: Math.random() * 30,
    }
  }))
  private elapsed = 0
  private frame = 0
  private previousTime = performance.now()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    winnerColor: string,
    private readonly playSound: (sound: FireworkSound) => void,
  ) {
    this.context = canvas.getContext('2d')
    this.palette = ['#ffbd58', winnerColor, '#ffdc9d']
    this.playSound('win')
    this.frame = requestAnimationFrame(this.animate)
  }

  replay(): void {
    this.elapsed = 0
    this.playSound('win')
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
  }

  private animate = (time: number): void => {
    const dt = Math.min(0.05, Math.max(0, (time - this.previousTime) / 1000))
    this.previousTime = time
    this.frame = requestAnimationFrame(this.animate)
    this.update(dt)
  }

  private update(dt: number): void {
    const ctx = this.context
    if (!ctx) return
    this.elapsed = (this.elapsed + dt) % cycleTime
    const previous = this.elapsed - dt
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const pixelWidth = Math.round(width * ratio)
    const pixelHeight = Math.round(height * ratio)
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'lighter'
    const unit = Math.min(width, height)

    for (const [index, shot] of displays.entries()) {
      const age = this.elapsed - shot.at
      if (age < 0 || age > flightTime + sparkTime) continue
      if (previous < shot.at) this.playSound('firework-launch')
      if (previous < shot.at + flightTime && age >= flightTime) this.playSound('firework-burst')
      const color = this.palette[shot.color]
      const x = shot.x * width
      const y = shot.y * height
      if (!this.reducedMotion && age < flightTime) {
        this.drawLaunch(ctx, x, y, width, height, age)
        continue
      }
      const time = age - flightTime
      if (time < 0) continue
      const exposure = this.reducedMotion ? Math.sin(Math.PI * time / sparkTime) : 1
      this.drawBurst(ctx, index, x, y, unit, color, this.reducedMotion ? 0.76 : time, exposure)
    }
    ctx.globalAlpha = 1
  }

  private drawLaunch(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, age: number): void {
    const point = (time: number) => {
      const progress = Math.min(1, Math.max(0, time / flightTime))
      return [x + (1 - progress) * (width / 2 - x) * 0.15, y + (height - y) * (1 - progress) ** 1.5]
    }
    const [headX, headY] = point(age)
    const [tailX, tailY] = point(age - 0.16)
    const trail = ctx.createLinearGradient(tailX, tailY, headX, headY)
    trail.addColorStop(0, '#ff862200')
    trail.addColorStop(0.7, '#ffad4277')
    trail.addColorStop(1, '#fff7db')
    ctx.globalAlpha = 0.94
    ctx.strokeStyle = trail
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(headX, headY)
    ctx.stroke()
    ctx.fillStyle = '#fff6db'
    ctx.beginPath()
    ctx.arc(headX, headY, 2.6, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawBurst(ctx: CanvasRenderingContext2D, index: number, x: number, y: number, unit: number, color: string, time: number, exposure: number): void {
    const shot = displays[index]
    const radius = unit * shot.radius
    const flare = radius * 0.62
    const halo = ctx.createRadialGradient(x, y, 0, x, y, flare)
    halo.addColorStop(0, '#fff7d8')
    halo.addColorStop(0.09, color)
    halo.addColorStop(1, color + '00')
    ctx.globalAlpha = exposure * (0.56 * Math.exp(-time * 11) + 0.07 * Math.exp(-time * 1.4))
    ctx.fillStyle = halo
    ctx.fillRect(x - flare, y - flare, flare * 2, flare * 2)

    const drag = shot.willow ? 1.4 : 2.2
    const gravity = unit * (shot.willow ? 0.056 : 0.048)
    const travel = (t: number) => 1 - Math.exp(-t * drag)
    ctx.lineCap = 'round'
    for (const spark of this.sparks[index]) {
      if (time >= spark.life) continue
      const vx = spark.x * radius * spark.speed
      const vy = spark.y * radius * spark.speed
      const head = travel(time)
      const trailTime = Math.max(0, time - (shot.willow ? 0.39 : 0.19))
      const tail = travel(trailTime)
      const headX = x + vx * head
      const headY = y + vy * head + gravity * time ** 2
      const tailX = x + vx * tail
      const tailY = y + vy * tail + gravity * trailTime ** 2
      const life = 1 - time / spark.life
      const brightness = exposure * Math.min(1, life * 2.8)
      const glint = 0.76 + 0.24 * Math.sin(spark.twinkle + time * (shot.willow ? 21 : 32))
      const trail = ctx.createLinearGradient(tailX, tailY, headX, headY)
      trail.addColorStop(0, color + '00')
      trail.addColorStop(0.62, color)
      trail.addColorStop(1, '#fff2c6')
      ctx.strokeStyle = trail
      ctx.beginPath()
      ctx.moveTo(tailX, tailY)
      const middleTime = (trailTime + time) / 2
      const middle = travel(middleTime)
      ctx.quadraticCurveTo(x + vx * middle, y + vy * middle + gravity * middleTime ** 2, headX, headY)
      ctx.globalAlpha = brightness * 0.24
      ctx.lineWidth = spark.width + 2
      ctx.stroke()
      ctx.globalAlpha = brightness * glint
      ctx.lineWidth = spark.width
      ctx.stroke()
      if (life > 0.18 && glint > 0.79) {
        ctx.fillStyle = '#fff7de'
        ctx.beginPath()
        ctx.arc(headX, headY, spark.width * 0.72, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}
