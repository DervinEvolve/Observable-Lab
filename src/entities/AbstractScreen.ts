import * as THREE from 'three'
import gsap from 'gsap'

// Activity states for the screen visualization
export type ScreenActivity =
  | 'idle'
  | 'writing'
  | 'reading'
  | 'testing'
  | 'committing'
  | 'error'

// Configuration for screen appearance
const SCREEN_CONFIG = {
  width: 1.2,
  height: 0.8,
  depth: 0.02,
  hoverHeight: 2.2, // Height above desk
  opacity: 0.15,
  blockSize: 0.06,
  particleCount: 50,
  blockCount: 12,
}

// Colors for different activities
const ACTIVITY_COLORS = {
  idle: 0x4fc3f7, // Light blue
  writing: 0x81c784, // Green
  reading: 0xfff176, // Yellow
  testing: 0x64b5f6, // Blue
  committing: 0xffd54f, // Gold
  error: 0xe57373, // Red
}

// A single floating block in the visualization
class FloatingBlock {
  public mesh: THREE.Mesh
  private basePosition: THREE.Vector3
  private floatOffset: number
  private floatSpeed: number

  constructor(position: THREE.Vector3, size: number, color: number) {
    const geometry = new THREE.BoxGeometry(size, size, size)
    const material = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      emissive: color,
      emissiveIntensity: 0.3,
      metalness: 0.2,
      roughness: 0.8,
    })

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.position.copy(position)
    this.basePosition = position.clone()
    this.floatOffset = Math.random() * Math.PI * 2
    this.floatSpeed = 0.5 + Math.random() * 0.5
  }

  update(time: number, activity: ScreenActivity): void {
    // Gentle floating animation
    const floatAmount = activity === 'idle' ? 0.03 : 0.01
    this.mesh.position.y = this.basePosition.y + Math.sin(time * this.floatSpeed + this.floatOffset) * floatAmount

    // Subtle rotation
    this.mesh.rotation.x += 0.002
    this.mesh.rotation.y += 0.003

    // Update material based on activity
    const mat = this.mesh.material as THREE.MeshStandardMaterial
    const targetColor = ACTIVITY_COLORS[activity]
    const currentColor = new THREE.Color(mat.color.getHex())
    const target = new THREE.Color(targetColor)
    currentColor.lerp(target, 0.05)
    mat.color.copy(currentColor)
    mat.emissive.copy(currentColor)

    // Activity-specific effects
    switch (activity) {
      case 'writing':
        mat.emissiveIntensity = 0.4 + Math.sin(time * 3) * 0.2
        break
      case 'testing':
        mat.emissiveIntensity = 0.3 + Math.sin(time * 5) * 0.3
        break
      case 'committing':
        mat.emissiveIntensity = 0.6
        break
      case 'error':
        mat.emissiveIntensity = 0.5 + Math.sin(time * 8) * 0.3
        // Shake effect
        this.mesh.position.x = this.basePosition.x + (Math.random() - 0.5) * 0.02
        break
      default:
        mat.emissiveIntensity = 0.2
    }
  }

  setForming(forming: boolean): void {
    gsap.to(this.mesh.scale, {
      x: forming ? 1.2 : 1,
      y: forming ? 1.2 : 1,
      z: forming ? 1.2 : 1,
      duration: 0.3,
      ease: 'power2.out',
    })
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

// A flowing particle for the visualization
class FlowingParticle {
  public mesh: THREE.Mesh
  private velocity: THREE.Vector3
  private lifetime: number
  private maxLifetime: number
  private startPosition: THREE.Vector3
  private targetPosition: THREE.Vector3 | null = null

  constructor(position: THREE.Vector3, color: number) {
    const geometry = new THREE.SphereGeometry(0.015, 6, 4)
    const material = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      emissive: color,
      emissiveIntensity: 0.5,
    })

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.position.copy(position)
    this.startPosition = position.clone()
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.02,
      Math.random() * 0.01,
      (Math.random() - 0.5) * 0.02
    )
    this.lifetime = 0
    this.maxLifetime = 2 + Math.random() * 2
  }

  update(deltaTime: number, activity: ScreenActivity): boolean {
    this.lifetime += deltaTime

    const mat = this.mesh.material as THREE.MeshStandardMaterial

    // Update based on activity
    switch (activity) {
      case 'writing':
        // Flow toward center/target blocks
        if (this.targetPosition) {
          const direction = new THREE.Vector3()
            .subVectors(this.targetPosition, this.mesh.position)
            .normalize()
          this.velocity.lerp(direction.multiplyScalar(0.03), 0.1)
        }
        break
      case 'testing':
        // Radiate outward in ripples
        const outward = this.mesh.position.clone().normalize()
        this.velocity.lerp(outward.multiplyScalar(0.02), 0.05)
        break
      case 'error':
        // Scatter chaotically
        this.velocity.add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.01,
            (Math.random() - 0.5) * 0.01,
            (Math.random() - 0.5) * 0.01
          )
        )
        break
      default:
        // Gentle drift
        this.velocity.multiplyScalar(0.98)
    }

    this.mesh.position.add(this.velocity)

    // Fade based on lifetime
    const lifeRatio = this.lifetime / this.maxLifetime
    mat.opacity = Math.max(0, 0.8 * (1 - lifeRatio))

    // Color update
    const targetColor = ACTIVITY_COLORS[activity]
    const currentColor = new THREE.Color(mat.color.getHex())
    currentColor.lerp(new THREE.Color(targetColor), 0.1)
    mat.color.copy(currentColor)
    mat.emissive.copy(currentColor)

    return this.lifetime < this.maxLifetime
  }

  reset(position: THREE.Vector3): void {
    this.mesh.position.copy(position)
    this.startPosition.copy(position)
    this.velocity.set(
      (Math.random() - 0.5) * 0.02,
      Math.random() * 0.01,
      (Math.random() - 0.5) * 0.02
    )
    this.lifetime = 0
    this.maxLifetime = 2 + Math.random() * 2
    ;(this.mesh.material as THREE.MeshStandardMaterial).opacity = 0.8
  }

  setTarget(target: THREE.Vector3 | null): void {
    this.targetPosition = target
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

export class AbstractScreen {
  public group: THREE.Group
  private blocks: FloatingBlock[] = []
  private particles: FlowingParticle[] = []
  private activity: ScreenActivity = 'idle'
  private time: number = 0
  private screenPlane: THREE.Mesh
  private isVisible: boolean = false

  constructor(position: THREE.Vector3, rotation: number = 0) {
    this.group = new THREE.Group()
    this.group.name = 'abstract_screen'
    this.group.position.copy(position)
    this.group.position.y += SCREEN_CONFIG.hoverHeight
    this.group.rotation.y = rotation

    // Hidden by default - only shown when agent is coding
    this.group.visible = false

    // Create semi-transparent backing plane
    const planeGeometry = new THREE.PlaneGeometry(
      SCREEN_CONFIG.width,
      SCREEN_CONFIG.height
    )
    const planeMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      transparent: true,
      opacity: SCREEN_CONFIG.opacity,
      side: THREE.DoubleSide,
      emissive: 0x0a0a1a,
      emissiveIntensity: 0.5,
    })
    this.screenPlane = new THREE.Mesh(planeGeometry, planeMaterial)
    this.group.add(this.screenPlane)

    // Create floating blocks in a grid pattern
    this.createBlocks()

    // Create flowing particles
    this.createParticles()
  }

  private createBlocks(): void {
    const cols = 4
    const rows = 3
    const spacing = SCREEN_CONFIG.blockSize * 2

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const x = (j - (cols - 1) / 2) * spacing
        const y = (i - (rows - 1) / 2) * spacing
        const z = 0.05 + Math.random() * 0.03

        const block = new FloatingBlock(
          new THREE.Vector3(x, y, z),
          SCREEN_CONFIG.blockSize,
          ACTIVITY_COLORS.idle
        )
        this.blocks.push(block)
        this.group.add(block.mesh)
      }
    }
  }

  private createParticles(): void {
    for (let i = 0; i < SCREEN_CONFIG.particleCount; i++) {
      const x = (Math.random() - 0.5) * SCREEN_CONFIG.width * 0.8
      const y = (Math.random() - 0.5) * SCREEN_CONFIG.height * 0.8
      const z = 0.02 + Math.random() * 0.08

      const particle = new FlowingParticle(
        new THREE.Vector3(x, y, z),
        ACTIVITY_COLORS.idle
      )
      this.particles.push(particle)
      this.group.add(particle.mesh)
    }
  }

  public setActivity(activity: ScreenActivity): void {
    if (this.activity === activity) return

    this.activity = activity

    // Show screen when actively coding, hide when idle
    const shouldShow = activity !== 'idle'
    this.setVisible(shouldShow)

    // Activity-specific transitions
    switch (activity) {
      case 'writing':
        // Blocks start forming
        this.blocks.forEach((block, i) => {
          setTimeout(() => block.setForming(true), i * 100)
        })
        // Particles target blocks
        this.particles.forEach((particle, i) => {
          const targetBlock = this.blocks[i % this.blocks.length]
          particle.setTarget(targetBlock.mesh.position)
        })
        break

      case 'committing':
        // Golden flash on all blocks
        this.blocks.forEach((block) => {
          const mat = block.mesh.material as THREE.MeshStandardMaterial
          gsap.to(mat, {
            emissiveIntensity: 1,
            duration: 0.2,
            yoyo: true,
            repeat: 1,
          })
        })
        break

      case 'error':
        // Shake the whole screen briefly
        gsap.to(this.group.position, {
          x: this.group.position.x + 0.05,
          duration: 0.05,
          yoyo: true,
          repeat: 5,
        })
        break

      case 'idle':
        // Return to calm state
        this.blocks.forEach((block) => block.setForming(false))
        this.particles.forEach((particle) => particle.setTarget(null))
        break
    }
  }

  public setVisible(visible: boolean): void {
    if (this.isVisible === visible) return
    this.isVisible = visible

    if (visible) {
      // Fade in
      this.group.visible = true
      gsap.to(this.group, {
        duration: 0.3,
        ease: 'power2.out',
      })
      // Fade in all materials
      this.blocks.forEach((block) => {
        const mat = block.mesh.material as THREE.MeshStandardMaterial
        gsap.fromTo(mat, { opacity: 0 }, { opacity: 0.6, duration: 0.3 })
      })
      this.particles.forEach((particle) => {
        const mat = particle.mesh.material as THREE.MeshStandardMaterial
        gsap.fromTo(mat, { opacity: 0 }, { opacity: 0.8, duration: 0.3 })
      })
      const planeMat = this.screenPlane.material as THREE.MeshStandardMaterial
      gsap.fromTo(planeMat, { opacity: 0 }, { opacity: SCREEN_CONFIG.opacity, duration: 0.3 })
    } else {
      // Fade out
      const onComplete = () => {
        this.group.visible = false
      }
      this.blocks.forEach((block) => {
        const mat = block.mesh.material as THREE.MeshStandardMaterial
        gsap.to(mat, { opacity: 0, duration: 0.3 })
      })
      this.particles.forEach((particle) => {
        const mat = particle.mesh.material as THREE.MeshStandardMaterial
        gsap.to(mat, { opacity: 0, duration: 0.3 })
      })
      const planeMat = this.screenPlane.material as THREE.MeshStandardMaterial
      gsap.to(planeMat, { opacity: 0, duration: 0.3, onComplete })
    }
  }

  public update(deltaTime: number): void {
    this.time += deltaTime

    // Update all blocks
    this.blocks.forEach((block) => {
      block.update(this.time, this.activity)
    })

    // Update all particles, respawning dead ones
    this.particles.forEach((particle) => {
      const alive = particle.update(deltaTime, this.activity)
      if (!alive) {
        // Respawn at edge
        const x = (Math.random() - 0.5) * SCREEN_CONFIG.width * 0.9
        const y = -SCREEN_CONFIG.height * 0.4
        const z = 0.02 + Math.random() * 0.08
        particle.reset(new THREE.Vector3(x, y, z))
      }
    })

    // Gentle hover animation for the whole screen
    this.group.position.y += Math.sin(this.time * 0.5) * 0.0005
  }

  public getActivity(): ScreenActivity {
    return this.activity
  }

  public dispose(): void {
    gsap.killTweensOf(this.group.position)

    // Dispose blocks
    this.blocks.forEach((block) => block.dispose())
    this.blocks = []

    // Dispose particles
    this.particles.forEach((particle) => particle.dispose())
    this.particles = []

    // Dispose screen plane
    this.screenPlane.geometry.dispose()
    ;(this.screenPlane.material as THREE.Material).dispose()
  }
}

// Factory function to create screens for stations
export function createStationScreen(
  stationPosition: THREE.Vector3,
  facingAngle: number
): AbstractScreen {
  return new AbstractScreen(stationPosition, facingAngle)
}
