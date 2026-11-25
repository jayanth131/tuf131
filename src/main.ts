import './styles/main.css'
import { TurfApp } from './turf/app'
import { TurfEngine } from './turf/engine'
import { DEFAULT_SETTINGS } from './turf/types'

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
const root = document.querySelector<HTMLElement>('#ui')

if (!canvas || !root) throw new Error('Turf Clash shell is missing its canvas or UI root')

let app: TurfApp
const engine = new TurfEngine(canvas, {
  onEvent: event => app?.handleEngineEvent(event),
  onSnapshot: () => undefined,
}, DEFAULT_SETTINGS)
app = new TurfApp(root, engine)

let previous = performance.now()
function frame(now: number): void {
  const dt = Math.min((now - previous) / 1000, 0.05)
  previous = now
  app.update(dt)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

window.addEventListener('beforeunload', () => app.dispose())
