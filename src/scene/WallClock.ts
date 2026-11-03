import * as THREE from 'three'

// Clock styling constants
const BRASS_COLOR = 0xb5a642

export class WallClock {
  public group: THREE.Group
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private lastSecond: number = -1

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'wallClock'

    // Create canvas for digital display
    this.canvas = document.createElement('canvas')
    this.canvas.width = 256
    this.canvas.height = 96
    this.ctx = this.canvas.getContext('2d')!

    // Initial render
    this.renderTime()

    // Create texture from canvas
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter

    // Clock frame (brass rectangle)
    const frameWidth = 0.7
    const frameHeight = 0.3
    const frameDepth = 0.05

    // Back panel (wood)
    const backGeometry = new THREE.BoxGeometry(frameWidth + 0.06, frameHeight + 0.06, frameDepth)
    const woodMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c4a3a,
      roughness: 0.8,
      metalness: 0.1,
    })
    const back = new THREE.Mesh(backGeometry, woodMaterial)
    back.position.z = -frameDepth / 2
    this.group.add(back)

    // Brass frame border
    const brassMaterial = new THREE.MeshStandardMaterial({
      color: BRASS_COLOR,
      roughness: 0.4,
      metalness: 0.7,
    })

    // Top border
    const borderThickness = 0.025
    const topBorder = new THREE.Mesh(
      new THREE.BoxGeometry(frameWidth + 0.06, borderThickness, frameDepth + 0.02),
      brassMaterial
    )
    topBorder.position.set(0, (frameHeight + 0.06) / 2, 0)
    this.group.add(topBorder)

    // Bottom border
    const bottomBorder = new THREE.Mesh(
      new THREE.BoxGeometry(frameWidth + 0.06, borderThickness, frameDepth + 0.02),
      brassMaterial
    )
    bottomBorder.position.set(0, -(frameHeight + 0.06) / 2, 0)
    this.group.add(bottomBorder)

    // Left border
    const leftBorder = new THREE.Mesh(
      new THREE.BoxGeometry(borderThickness, frameHeight + 0.06, frameDepth + 0.02),
      brassMaterial
    )
    leftBorder.position.set(-(frameWidth + 0.06) / 2, 0, 0)
    this.group.add(leftBorder)

    // Right border
    const rightBorder = new THREE.Mesh(
      new THREE.BoxGeometry(borderThickness, frameHeight + 0.06, frameDepth + 0.02),
      brassMaterial
    )
    rightBorder.position.set((frameWidth + 0.06) / 2, 0, 0)
    this.group.add(rightBorder)

    // Digital display face
    const displayGeometry = new THREE.PlaneGeometry(frameWidth, frameHeight)
    const displayMaterial = new THREE.MeshStandardMaterial({
      map: this.texture,
      roughness: 0.3,
      metalness: 0.0,
    })
    const display = new THREE.Mesh(displayGeometry, displayMaterial)
    display.position.z = 0.01
    this.group.add(display)
  }

  // Epoch schedule: when set, the clock counts down to the next epoch
  // instead of showing wall time — the lab's own heartbeat matters more
  // to a viewer than the viewer's timezone.
  private nextEpochAt: number | null = null
  private epochRunning = false
  private gpuTraining = false

  public setEpochInfo(nextEpochAt: number | null, running: boolean, training = false): void {
    this.nextEpochAt = nextEpochAt
    this.epochRunning = running
    this.gpuTraining = training
    this.renderTime()
    this.texture.needsUpdate = true
  }

  private renderTime(): void {
    const now = new Date()

    this.ctx.fillStyle = '#1a1a1a'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.textAlign = 'center'

    let big: string
    let label: string
    let color: string

    if (this.gpuTraining) {
      // the run itself — the number is being earned right now
      big = now.getSeconds() % 2 === 0 ? 'TRAINING' : 'TRAINING·'
      label = 'GPU LIVE · 300s BUDGET'
      color = '#ffb454'
    } else if (this.epochRunning) {
      // amber, blinking while the models are actually computing
      big = now.getSeconds() % 2 === 0 ? 'EPOCH LIVE' : 'EPOCH LIVE·'
      label = 'MODELS WORKING'
      color = '#ffb74d'
    } else if (this.nextEpochAt !== null) {
      const msLeft = Math.max(0, this.nextEpochAt - Date.now())
      const totalS = Math.floor(msLeft / 1000)
      const h = Math.floor(totalS / 3600)
      const m = Math.floor((totalS % 3600) / 60)
      const s = totalS % 60
      big = h > 0
        ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
        : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      label = 'NEXT EPOCH'
      color = '#7cb342'
    } else {
      big = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
      label = 'LAB TIME'
      color = '#7cb342'
    }

    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    this.ctx.font = '600 14px "Courier New", monospace'
    this.ctx.textBaseline = 'top'
    this.ctx.fillText(label, this.canvas.width / 2, 8)

    this.ctx.fillStyle = color
    this.ctx.font = 'bold 44px "Courier New", monospace'
    this.ctx.textBaseline = 'middle'
    this.ctx.fillText(big, this.canvas.width / 2, 58)
    this.ctx.shadowColor = color
    this.ctx.shadowBlur = 10
    this.ctx.fillText(big, this.canvas.width / 2, 58)
    this.ctx.shadowBlur = 0
  }

  public update(_deltaTime: number): void {
    const now = new Date()
    const currentSecond = now.getSeconds()

    // Only update when second changes
    if (currentSecond !== this.lastSecond) {
      this.lastSecond = currentSecond
      this.renderTime()
      this.texture.needsUpdate = true
    }
  }
}
