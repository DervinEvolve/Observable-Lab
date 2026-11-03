import * as THREE from 'three'
import gsap from 'gsap'
import type { ParticlePreset, ExperimentStatus } from '../shared/types'

interface ParticleConfig {
  count: number
  color: number
  size: number
  speed: number
  spread: number
  target?: THREE.Vector3 // For directional movement
  orbital?: boolean // For orbiting behavior
  chaotic?: boolean // For chaotic movement
}

const PARTICLE_CONFIGS: Record<ParticlePreset, ParticleConfig> = {
  green_spores: {
    count: 80,
    color: 0x7cb342,
    size: 0.02,
    speed: 0.3,
    spread: 3,
    target: new THREE.Vector3(0, 1, 0), // Move toward plant
  },
  red_chaotic: {
    count: 60,
    color: 0xe57373,
    size: 0.025,
    speed: 0.8,
    spread: 4,
    chaotic: true,
  },
  blue_orbital: {
    count: 50,
    color: 0x64b5f6,
    size: 0.018,
    speed: 0.2,
    spread: 2,
    orbital: true,
  },
  gold_dust: {
    count: 40,
    color: 0xffb74d,
    size: 0.015,
    speed: 0.1,
    spread: 5,
    target: new THREE.Vector3(0, 1, 0), // Drift upward
  },
}

export class ParticleSystem {
  private scene: THREE.Scene
  private particles: THREE.Points | null = null
  private geometry: THREE.BufferGeometry | null = null
  private material: THREE.PointsMaterial | null = null
  private currentPreset: ParticlePreset = 'gold_dust'
  private velocities: Float32Array | null = null
  private targetPosition: THREE.Vector3 = new THREE.Vector3(0, 1, 0)
  private time: number = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.createParticles('gold_dust')
  }

  private createParticles(preset: ParticlePreset): void {
    // Clean up existing
    this.dispose()

    const config = PARTICLE_CONFIGS[preset]
    const { count, color, size, spread } = config

    // Create geometry
    this.geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(count * 3)
    this.velocities = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      const i3 = i * 3

      // Random starting positions
      positions[i3] = (Math.random() - 0.5) * spread
      positions[i3 + 1] = Math.random() * 3 // Height 0-3
      positions[i3 + 2] = (Math.random() - 0.5) * spread

      // Random velocities
      this.velocities[i3] = (Math.random() - 0.5) * 0.1
      this.velocities[i3 + 1] = (Math.random() - 0.5) * 0.1
      this.velocities[i3 + 2] = (Math.random() - 0.5) * 0.1
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    // Create material
    this.material = new THREE.PointsMaterial({
      color: color,
      size: size,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    // Create points
    this.particles = new THREE.Points(this.geometry, this.material)
    this.scene.add(this.particles)

    this.currentPreset = preset
    if (config.target) {
      this.targetPosition.copy(config.target)
    }
  }

  // Update particles based on experiment state
  public updateFromState(status: ExperimentStatus, stabilityScore: number): void {
    let targetPreset: ParticlePreset

    if (status === 'stable') {
      targetPreset = 'blue_orbital'
    } else if (status === 'growing' && stabilityScore > 0.5) {
      targetPreset = 'green_spores'
    } else if (status === 'growing' && stabilityScore <= 0.5) {
      targetPreset = 'red_chaotic'
    } else {
      targetPreset = 'gold_dust'
    }

    if (targetPreset !== this.currentPreset) {
      this.transitionTo(targetPreset)
    }
  }

  // Transition to a new preset
  public transitionTo(preset: ParticlePreset): void {
    // Fade out current particles
    if (this.material) {
      gsap.to(this.material, {
        opacity: 0,
        duration: 1,
        onComplete: () => {
          // Create new particles
          this.createParticles(preset)
          // Fade in
          if (this.material) {
            this.material.opacity = 0
            gsap.to(this.material, {
              opacity: 0.7,
              duration: 1,
            })
          }
        },
      })
    } else {
      this.createParticles(preset)
    }
  }

  // Called every frame
  public update(deltaTime: number): void {
    if (!this.particles || !this.geometry || !this.velocities) return

    this.time += deltaTime
    const config = PARTICLE_CONFIGS[this.currentPreset]
    const positions = this.geometry.attributes.position.array as Float32Array

    const count = positions.length / 3

    for (let i = 0; i < count; i++) {
      const i3 = i * 3

      if (config.orbital) {
        // Orbital movement around center
        const radius = 1.5 + Math.sin(i * 0.1) * 0.5
        const angle = this.time * config.speed + i * ((Math.PI * 2) / count)
        const height = 0.8 + Math.sin(this.time * 0.5 + i) * 0.3

        positions[i3] = Math.cos(angle) * radius
        positions[i3 + 1] = height
        positions[i3 + 2] = Math.sin(angle) * radius
      } else if (config.chaotic) {
        // Chaotic random movement
        this.velocities[i3] += (Math.random() - 0.5) * 0.02
        this.velocities[i3 + 1] += (Math.random() - 0.5) * 0.02
        this.velocities[i3 + 2] += (Math.random() - 0.5) * 0.02

        // Damping
        this.velocities[i3] *= 0.98
        this.velocities[i3 + 1] *= 0.98
        this.velocities[i3 + 2] *= 0.98

        positions[i3] += this.velocities[i3] * config.speed
        positions[i3 + 1] += this.velocities[i3 + 1] * config.speed
        positions[i3 + 2] += this.velocities[i3 + 2] * config.speed

        // Keep within bounds
        const bound = config.spread / 2
        if (Math.abs(positions[i3]) > bound) this.velocities[i3] *= -1
        if (positions[i3 + 1] < 0 || positions[i3 + 1] > 3) this.velocities[i3 + 1] *= -1
        if (Math.abs(positions[i3 + 2]) > bound) this.velocities[i3 + 2] *= -1
      } else if (config.target) {
        // Move toward target (spores or dust)
        const dx = this.targetPosition.x - positions[i3]
        const dy = this.targetPosition.y - positions[i3 + 1]
        const dz = this.targetPosition.z - positions[i3 + 2]

        positions[i3] += dx * deltaTime * config.speed * 0.5
        positions[i3 + 1] += dy * deltaTime * config.speed * 0.5 + deltaTime * 0.1 // Slight upward drift
        positions[i3 + 2] += dz * deltaTime * config.speed * 0.5

        // Add some noise
        positions[i3] += Math.sin(this.time * 2 + i) * 0.002
        positions[i3 + 2] += Math.cos(this.time * 2 + i) * 0.002

        // Reset particles that get too close to target or too high
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist < 0.3 || positions[i3 + 1] > 4) {
          // Reset to random position at bottom
          positions[i3] = (Math.random() - 0.5) * config.spread
          positions[i3 + 1] = Math.random() * 0.5
          positions[i3 + 2] = (Math.random() - 0.5) * config.spread
        }
      }
    }

    this.geometry.attributes.position.needsUpdate = true
  }

  // Get current preset
  public getCurrentPreset(): ParticlePreset {
    return this.currentPreset
  }

  // Dispose of resources
  public dispose(): void {
    if (this.particles) {
      this.scene.remove(this.particles)
    }
    if (this.geometry) {
      this.geometry.dispose()
    }
    if (this.material) {
      this.material.dispose()
    }
    this.particles = null
    this.geometry = null
    this.material = null
    this.velocities = null
  }
}
