import * as THREE from 'three'
import gsap from 'gsap'

// The challenger's counterpart to the Capability Archive: a small dark shelf
// where pruned ideas go. One ashen stub jar per pruning, and an etched count.
// The agent is good BECAUSE things die here — the lab should say so.

const JAR_CAP = 10

export class KillWall {
  public group: THREE.Group

  private jars: THREE.Group[] = []
  private plaqueCanvas: HTMLCanvasElement
  private plaqueTexture: THREE.CanvasTexture
  private count = -1

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'kill_wall'

    const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3a2e, roughness: 0.8 })
    const iron = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.55, metalness: 0.6 })

    const back = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.5, 0.035), darkWood)
    this.group.add(back)
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 0.19), iron)
    board.position.set(0, -0.08, 0.08)
    this.group.add(board)

    this.plaqueCanvas = document.createElement('canvas')
    this.plaqueCanvas.width = 384
    this.plaqueCanvas.height = 64
    this.plaqueTexture = new THREE.CanvasTexture(this.plaqueCanvas)
    const plaque = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.11, 0.015),
      [iron, iron, iron, iron,
        new THREE.MeshStandardMaterial({ map: this.plaqueTexture, roughness: 0.4, metalness: 0.5 }),
        iron]
    )
    plaque.position.set(0, -0.32, 0.05)
    this.group.add(plaque)
    this.drawPlaque(0)
  }

  private drawPlaque(n: number): void {
    const ctx = this.plaqueCanvas.getContext('2d')!
    ctx.fillStyle = '#4c4c52'
    ctx.fillRect(0, 0, 384, 64)
    ctx.fillStyle = '#1d1d22'
    ctx.font = '600 26px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`PRUNED · ${n}`, 192, 34)
    this.plaqueTexture.needsUpdate = true
  }

  private addJar(index: number, animate: boolean): void {
    const jar = new THREE.Group()
    jar.position.set(-0.495 + index * 0.11, -0.065 + 0.015, 0.08)

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.034, 0.038, 0.075, 8),
      new THREE.MeshStandardMaterial({
        color: 0x9a9a92, transparent: true, opacity: 0.35, roughness: 0.5,
      })
    )
    glass.position.y = 0.038
    jar.add(glass)

    // the dead idea: a shrivelled dark nub, no glow
    const nub = new THREE.Mesh(
      new THREE.SphereGeometry(0.016, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 1 })
    )
    nub.position.y = 0.022
    nub.scale.y = 0.7
    jar.add(nub)

    this.group.add(jar)
    this.jars.push(jar)

    if (animate) {
      jar.scale.setScalar(0.01)
      gsap.to(jar.scale, { x: 1, y: 1, z: 1, duration: 0.5, ease: 'back.out(1.8)' })
    }
  }

  public setState(prunings: number): void {
    const first = this.count === -1
    const target = Math.min(prunings, JAR_CAP)
    while (this.jars.length < target) this.addJar(this.jars.length, !first)
    if (prunings !== this.count) {
      this.drawPlaque(prunings)
      this.count = prunings
    }
  }

  public dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        Array.isArray(m) ? m.forEach(x => x.dispose()) : m.dispose()
      }
    })
    this.plaqueTexture.dispose()
  }
}
