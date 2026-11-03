import * as THREE from 'three'
import gsap from 'gsap'
import { COLORS } from '../scene/colors'

// The Capability Archive — the lab's trophy wall. Every capability the agent
// actually earns (survives review + CI) becomes a glowing specimen jar on a
// brass shelf; merged code and epochs tick up on an etched plaque; bound lab
// notebooks pile up beside it as epochs pass. Viewers who return after a week
// see a visibly fuller wall — the lab itself records the agent's progression.

const JAR_CAP = 24
const JARS_PER_ROW = 12
const BOOK_CAP = 10

const ORB_PALETTE = [
  COLORS.models.gemini,
  COLORS.models.deepseek,
  COLORS.models.claude,
  COLORS.models.gpt,
  COLORS.models.grok,
  COLORS.states.healthy,
]

export class CapabilityArchive {
  public group: THREE.Group

  private jars: Array<{ orb: THREE.Mesh; halo: THREE.Sprite; phase: number }> = []
  private books: THREE.Mesh[] = []
  private plaqueCanvas: HTMLCanvasElement
  private plaqueTexture: THREE.CanvasTexture
  private haloTexture: THREE.Texture
  private time = 0
  private busy = false
  private counts = { capabilities: -1, merges: -1, epochs: -1 }

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'capability_archive'

    const wood = new THREE.MeshStandardMaterial({ color: COLORS.structure.wood, roughness: 0.7 })
    const brass = new THREE.MeshStandardMaterial({ color: COLORS.structure.brass, roughness: 0.4, metalness: 0.7 })

    // Back panel + two shelf boards
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.05, 0.04), wood)
    back.position.y = 0.5
    this.group.add(back)
    for (const y of [0.22, 0.72]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.035, 0.22), brass)
      board.position.set(0, y, 0.1)
      this.group.add(board)
    }

    // Etched plaque under the shelves (canvas text, updated on state change)
    this.plaqueCanvas = document.createElement('canvas')
    this.plaqueCanvas.width = 512
    this.plaqueCanvas.height = 96
    this.plaqueTexture = new THREE.CanvasTexture(this.plaqueCanvas)
    const plaque = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.16, 0.02),
      [brass, brass, brass, brass,
        new THREE.MeshStandardMaterial({ map: this.plaqueTexture, roughness: 0.35, metalness: 0.55 }),
        brass]
    )
    plaque.position.set(0, -0.12, 0.06)
    this.group.add(plaque)
    this.drawPlaque(0, 0, 0)

    // Shared halo sprite texture for the jar orbs
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 16)
    g.addColorStop(0, 'rgba(255,255,255,0.9)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 32, 32)
    this.haloTexture = new THREE.CanvasTexture(c)
  }

  private drawPlaque(caps: number, merges: number, epochs: number): void {
    const ctx = this.plaqueCanvas.getContext('2d')!
    ctx.fillStyle = '#8a7a32'
    ctx.fillRect(0, 0, 512, 96)
    ctx.fillStyle = '#2e2818'
    ctx.font = '600 30px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('AGENT ARCHIVE', 256, 26)
    ctx.font = '500 24px Georgia, serif'
    ctx.fillText(`capabilities ${caps} · merges ${merges} · epoch ${epochs}`, 256, 66)
    this.plaqueTexture.needsUpdate = true
  }

  private addJar(index: number, animate: boolean): void {
    const jar = new THREE.Group()
    const row = Math.floor(index / JARS_PER_ROW)
    const col = index % JARS_PER_ROW
    jar.position.set(-0.825 + col * 0.15, (row === 0 ? 0.22 : 0.72) + 0.018, 0.1)

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.05, 0.11, 10),
      new THREE.MeshStandardMaterial({
        color: COLORS.structure.glass, transparent: true, opacity: 0.22, roughness: 0.15,
      })
    )
    glass.position.y = 0.055
    jar.add(glass)

    const cork = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.036, 0.02, 8),
      new THREE.MeshStandardMaterial({ color: 0x9a7d52, roughness: 0.9 })
    )
    cork.position.y = 0.12
    jar.add(cork)

    const color = new THREE.Color(ORB_PALETTE[index % ORB_PALETTE.length])
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 8, 8),
      new THREE.MeshBasicMaterial({ color })
    )
    orb.position.y = 0.05
    jar.add(orb)

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.haloTexture, color, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    halo.scale.setScalar(0.09)
    halo.position.y = 0.05
    jar.add(halo)

    jar.userData.inspect = { kind: 'capability', index }
    jar.traverse(o => { o.userData.inspect = jar.userData.inspect })
    this.group.add(jar)
    this.jars.push({ orb, halo, phase: index * 1.3 })

    if (animate) {
      jar.scale.setScalar(0.01)
      gsap.to(jar.scale, { x: 1, y: 1, z: 1, duration: 0.8, ease: 'elastic.out(1, 0.45)' })
    }
  }

  private addBook(index: number, animate: boolean): void {
    const hues = [0x6b4f35, 0x4a5568, 0x7a3b2e, 0x3f5c4a]
    const h = 0.035
    const book = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, h, 0.22),
      new THREE.MeshStandardMaterial({ color: hues[index % hues.length], roughness: 0.85 })
    )
    // pile on the floor beside the shelf (group hangs at y≈1.35 on the wall,
    // so floor level is -1.35 in group space)
    book.position.set(1.15, -1.35 + h / 2 + index * h, 0.18)
    book.rotation.y = ((index * 37) % 13 - 6) * 0.035
    this.group.add(book)
    this.books.push(book)
    if (animate) {
      const targetY = book.position.y
      book.position.y = targetY + 0.5
      gsap.to(book.position, { y: targetY, duration: 0.5, ease: 'bounce.out' })
    }
  }

  // Capability metadata for the inspector card, index-aligned with jars.
  private capList: Array<{ name: string; pr: string | null }> = []
  public setCapabilityList(list: Array<{ name: string; pr: string | null }>): void {
    this.capList = list
  }
  public getCapabilityInfo(index: number): { name: string; pr: string | null } | null {
    return this.capList[index] ?? null
  }

  // Called from state updates. First call lays everything out instantly
  // (page load shouldn't replay 20 pops); later increases animate in.
  public setState(caps: number, merges: number, epochs: number): void {
    const first = this.counts.capabilities === -1
    const jarTarget = Math.min(caps, JAR_CAP)
    while (this.jars.length < jarTarget) this.addJar(this.jars.length, !first)
    const bookTarget = Math.min(Math.floor(epochs / 3), BOOK_CAP)
    while (this.books.length < bookTarget) this.addBook(this.books.length, !first)

    if (caps !== this.counts.capabilities || merges !== this.counts.merges || epochs !== this.counts.epochs) {
      this.drawPlaque(caps, merges, epochs)
      this.counts = { capabilities: caps, merges, epochs }
    }
  }

  public setBusy(busy: boolean): void {
    this.busy = busy
  }

  public update(dt: number): void {
    this.time += Math.min(dt, 0.05)
    const speed = this.busy ? 3.2 : 1.4
    for (const j of this.jars) {
      const s = Math.sin(this.time * speed + j.phase)
      j.orb.position.y = 0.05 + s * 0.008
      j.halo.position.y = j.orb.position.y
      ;(j.halo.material as THREE.SpriteMaterial).opacity = 0.4 + 0.2 * s
    }
  }

  public dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        Array.isArray(m) ? m.forEach(x => x.dispose()) : m.dispose()
      }
      if (o instanceof THREE.Sprite) o.material.dispose()
    })
    this.plaqueTexture.dispose()
    this.haloTexture.dispose()
  }
}
