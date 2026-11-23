import * as THREE from 'three'
import {
  activityAge, newestAge, tubeGlow, tubeMouthPosition,
  type ChatActivity,
} from '../systems/speakingTube'

// The glow at the mouth of the Commentator's speaking tube: one additive
// sprite, drawn only while a real reply is recent (see systems/speakingTube.ts
// for what counts and for the fade). It adds no light and changes none of the
// tube's own meshes. At rest, with the chat off, or while no experiment is
// connected, the sprite is hidden and costs nothing. Lit, it costs one draw
// call and two triangles. Nothing here moves on a timer: update() only works
// out the glow from the age of a stored time.

const SIZE = 0.42
const PEAK = 0.9

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export class SpeakingTubeGlow {
  /** Added to the scene directly, never to a group that is merged. */
  readonly sprite: THREE.Sprite
  private material: THREE.SpriteMaterial
  private activity: ChatActivity | null = null
  private receivedAtPerf = 0
  /** Wall clock time (ms) of this visitor's own last real reply. */
  private ownAtMs: number | null = null
  private chatOn = false
  private simulation = false
  private reduced = false

  constructor() {
    this.material = new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffd98a, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, toneMapped: false, opacity: 0,
    })
    this.sprite = new THREE.Sprite(this.material)
    this.sprite.name = 'speaking_tube_glow'
    this.sprite.scale.set(SIZE, SIZE, 1)
    const p = tubeMouthPosition()
    this.sprite.position.set(p.x, p.y, p.z)
    this.sprite.visible = false
    this.sprite.raycast = () => {} // not an exhibit: nothing to hover or click
  }

  /** The room's state: the server's record of the newest good reply, or none. */
  setActivity(activity: ChatActivity | null, simulation: boolean): void {
    this.simulation = simulation
    if (activity?.serverNowMs !== this.activity?.serverNowMs || activity?.atMs !== this.activity?.atMs) {
      this.receivedAtPerf = performance.now()
    }
    this.activity = activity
    this.apply()
  }

  /** The chat is switched on or off. Off forgets everything: the tube goes dark. */
  setChatOn(on: boolean): void {
    this.chatOn = on
    if (!on) {
      this.activity = null
      this.ownAtMs = null
    }
    this.apply()
  }

  /** This visitor really received a reply from a trained model. `ms` is the wall clock time. */
  noteOwnReply(ms: number): void {
    if (!Number.isFinite(ms)) return
    this.ownAtMs = ms
    this.apply()
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on
    this.apply()
  }

  /** Brightness now, 0 to 1. */
  glow(): number {
    if (!this.chatOn || this.simulation) return 0
    const server = this.activity ? activityAge(this.activity, this.receivedAtPerf, performance.now()) : null
    const own = this.ownAtMs !== null ? Math.max(0, (Date.now() - this.ownAtMs) / 1000) : null
    return tubeGlow(newestAge(server, own), this.reduced)
  }

  /** Recomputes from the age of a stored time. With no stored time it does nothing at all. */
  update(_dt: number): void {
    if (this.activity === null && this.ownAtMs === null) return
    this.apply()
  }

  private apply(): void {
    const g = this.glow()
    this.material.opacity = g * PEAK
    this.sprite.visible = g > 0
  }

  dispose(): void {
    this.material.map?.dispose()
    this.material.dispose()
  }
}
