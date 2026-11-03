import * as THREE from 'three'
import gsap from 'gsap'

// J-SPACE LENS — a skeuomorphic instrument inspired by Anthropic's Jacobian
// lens (transformer-circuits.pub/2026/workspace): a readout of what a model is
// *about to say* from its internal layers, before it says it.
//
// The real lens needs activations, so it can't point at cloud models — but
// this lab holds something almost as good: each scientist's actual pre-verbal
// REASONING text and the REMARK it became. The lens dramatizes exactly that
// mapping, in the paper's visual language:
//   · early band  — noise (paper: early layers are noise)
//   · workspace   — ghost tokens drawn from the scientist's real reasoning,
//                   with rank superscripts (paper: "workspace range" where
//                   unspoken concepts like 'spider' surface before "8 legs")
//   · motor band  — the actual remark typewriting into place (paper: "motor
//                   regime" encoding imminent output)
// plus a guard-confidence sparkline, as in the released tool's UI.

const W = 512
const H = 300

export class JSpaceLens {
  public group: THREE.Group

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private panel: THREE.Mesh

  private target: THREE.Object3D | null = null
  private modelName = ''
  private reasoningWords: string[] = []
  private remark = ''
  private ranks: number[] = []
  private ghostSeeds: number[] = []
  private guard: number[] = []
  private time = 0
  private lastDraw = 0
  private typeStart = 0

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'jspace_lens'
    this.group.visible = false

    this.canvas = document.createElement('canvas')
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.minFilter = THREE.LinearFilter

    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 0.54),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide })
    )
    this.group.add(this.panel)
    for (let i = 0; i < 60; i++) this.guard.push(0.96)
  }

  public get attachedTo(): THREE.Object3D | null {
    return this.target
  }

  // Attach above a scientist; content = their latest real reasoning + remark.
  public attach(target: THREE.Object3D, modelName: string, reasoning: string, remark: string): void {
    this.target = target
    this.modelName = modelName
    this.remark = (remark || '…').slice(0, 90)
    const words = (reasoning || '')
      .replace(/[^a-zA-Z0-9' -]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && w.length < 16)
    // stable de-dup, keep order of first appearance — these are the "concepts"
    const seen = new Set<string>()
    this.reasoningWords = words.filter(w => {
      const k = w.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }).slice(0, 24)
    if (this.reasoningWords.length === 0) this.reasoningWords = ['no', 'recent', 'readout']
    this.ranks = this.reasoningWords.map((_, i) => 2 + ((i * 7 + 3) % 38))
    this.ghostSeeds = this.reasoningWords.map((_, i) => (i * 137.5) % (Math.PI * 2))
    this.typeStart = this.time

    this.group.visible = true
    this.group.scale.setScalar(0.01)
    gsap.killTweensOf(this.group.scale)
    gsap.to(this.group.scale, { x: 1, y: 1, z: 1, duration: 0.55, ease: 'back.out(1.8)' })
  }

  public detach(): void {
    const g = this.group
    gsap.killTweensOf(g.scale)
    gsap.to(g.scale, {
      x: 0.01, y: 0.01, z: 0.01, duration: 0.25, ease: 'power2.in',
      onComplete: () => { g.visible = false },
    })
    this.target = null
  }

  private draw(): void {
    const ctx = this.ctx
    const t = this.time

    // panel
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(13, 17, 23, 0.94)'
    ctx.beginPath()
    ctx.roundRect(0, 0, W, H, 18)
    ctx.fill()
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)'
    ctx.lineWidth = 2
    ctx.stroke()

    // header
    ctx.fillStyle = '#78c8ff'
    ctx.font = '700 19px "SF Mono", "Courier New", monospace'
    ctx.textAlign = 'left'
    ctx.fillText('◉ J-SPACE LENS', 18, 30)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'right'
    ctx.fillText(this.modelName, W - 18, 30)
    // layer chips
    ctx.font = '600 13px "SF Mono", "Courier New", monospace'
    ctx.textAlign = 'left'
    const chips = ['L18', 'L22', 'L26', 'L30', 'L34']
    let cx = 18
    for (const c of chips) {
      ctx.fillStyle = 'rgba(120, 200, 255, 0.14)'
      ctx.beginPath()
      ctx.roundRect(cx, 40, 40, 20, 5)
      ctx.fill()
      ctx.fillStyle = 'rgba(120, 200, 255, 0.8)'
      ctx.fillText(c, cx + 7, 55)
      cx += 46
    }

    const bandLabel = (label: string, y: number) => {
      ctx.save()
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.font = '600 11px "SF Mono", monospace'
      ctx.textAlign = 'left'
      ctx.fillText(label, 14, y)
      ctx.restore()
    }

    // early band: dim noise glyphs
    bandLabel('EARLY · noise', 84)
    ctx.font = '500 12px "SF Mono", monospace'
    for (let i = 0; i < 26; i++) {
      const x = 18 + ((i * 19 + Math.floor(t * 3) * 7) % (W - 40))
      const ch = String.fromCharCode(33 + ((i * 13 + Math.floor(t * 5)) % 60))
      ctx.fillStyle = `rgba(160, 170, 180, ${0.08 + 0.06 * Math.sin(t * 3 + i)})`
      ctx.fillText(ch, x, 100 + (i % 2) * 13)
    }

    // workspace band: the scientist's REAL reasoning concepts, ghosting
    bandLabel('WORKSPACE · verbalizable', 138)
    for (let i = 0; i < this.reasoningWords.length; i++) {
      const seed = this.ghostSeeds[i]
      const alpha = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.9 + seed))
      const x = 20 + ((i * 83 + Math.sin(t * 0.25 + seed) * 14 + W) % (W - 90))
      const y = 156 + ((i * 37) % 44)
      ctx.font = '600 15px "SF Mono", monospace'
      ctx.fillStyle = `rgba(255, 214, 130, ${alpha.toFixed(3)})`
      ctx.fillText(this.reasoningWords[i], x, y)
      ctx.font = '500 9px "SF Mono", monospace'
      ctx.fillStyle = `rgba(255, 214, 130, ${(alpha * 0.7).toFixed(3)})`
      ctx.fillText(String(this.ranks[i]), x + ctx.measureText(this.reasoningWords[i]).width + 14, y - 7)
    }

    // motor band: the remark typewriting into place
    bandLabel('MOTOR · imminent output', 226)
    const shown = Math.min(this.remark.length, Math.floor((t - this.typeStart) * 14))
    ctx.font = '600 16px "SF Mono", monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    const text = this.remark.slice(0, shown)
    // wrap to two lines max
    const max1 = 52
    ctx.fillText(text.slice(0, max1), 18, 246)
    if (text.length > max1) ctx.fillText(text.slice(max1, max1 + 52), 18, 264)
    if (shown < this.remark.length && Math.floor(t * 3) % 2 === 0) {
      const tail = text.length > max1 ? text.slice(max1) : text
      const row = text.length > max1 ? 264 : 246
      ctx.fillText('▍', 18 + ctx.measureText(tail).width, row)
    }

    // guard confidence sparkline
    this.guard.push(Math.min(0.99, Math.max(0.82, this.guard[this.guard.length - 1] + (Math.random() - 0.5) * 0.02)))
    if (this.guard.length > 60) this.guard.shift()
    ctx.strokeStyle = 'rgba(90, 220, 130, 0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < this.guard.length; i++) {
      const x = 18 + (i / 59) * (W - 110)
      const y = 288 - (this.guard[i] - 0.8) * 60
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.fillStyle = 'rgba(90, 220, 130, 0.95)'
    ctx.font = '600 14px "SF Mono", monospace'
    ctx.textAlign = 'right'
    ctx.fillText(this.guard[this.guard.length - 1].toFixed(2), W - 18, 292)

    this.texture.needsUpdate = true
  }

  public update(dt: number, camera: THREE.Camera): void {
    if (!this.group.visible || !this.target) return
    this.time += Math.min(dt, 0.05)

    // hover WELL above the scientist's head — the HTML name label occupies
    // the band right above them, and the lens must not fight it
    const p = this.target.position
    this.group.position.set(p.x, p.y + 3.05 + Math.sin(this.time * 1.1) * 0.02, p.z)
    // yaw-only billboard
    const cam = camera.position
    this.group.rotation.y = Math.atan2(cam.x - p.x, cam.z - p.z)

    if (this.time - this.lastDraw > 0.12) {
      this.lastDraw = this.time
      this.draw()
    }
  }

  public dispose(): void {
    this.panel.geometry.dispose()
    ;(this.panel.material as THREE.Material).dispose()
    this.texture.dispose()
  }
}
