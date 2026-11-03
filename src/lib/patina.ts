import * as THREE from 'three'
import gsap from 'gsap'
import { PATINA_LEVELS, type PatinaLevel } from '../shared/types'

interface MaterialRegistry {
  brass: THREE.MeshStandardMaterial[]
  wood: THREE.MeshStandardMaterial[]
}

export class PatinaSystem {
  private materials: MaterialRegistry = {
    brass: [],
    wood: [],
  }
  private currentLevel: string = 'pristine'
  private dustParticles: THREE.Points | null = null
  private scene: THREE.Scene | null = null

  constructor() {}

  // Register materials to be affected by patina
  public registerMaterial(material: THREE.MeshStandardMaterial, type: 'brass' | 'wood'): void {
    if (!this.materials[type].includes(material)) {
      this.materials[type].push(material)
    }
  }

  // Set the scene for dust particles
  public setScene(scene: THREE.Scene): void {
    this.scene = scene
  }

  // Scan a scene for brass and wood materials
  public scanScene(scene: THREE.Scene): void {
    this.scene = scene
    scene.traverse(obj => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
        const mat = obj.material

        // Detect brass by color (roughly 0xB5A642 range)
        if (mat.color.getHex() >= 0x8a7000 && mat.color.getHex() <= 0xd0c000) {
          this.registerMaterial(mat, 'brass')
        }

        // Detect wood by color (roughly 0x8B7355 range) or name
        const woodNames = ['wood', 'desk', 'floor', 'table']
        if (
          (mat.color.getHex() >= 0x5a4030 && mat.color.getHex() <= 0xa08060) ||
          woodNames.some(n => obj.name.toLowerCase().includes(n))
        ) {
          this.registerMaterial(mat, 'wood')
        }
      }
    })

    if (import.meta.env.DEV) {
      console.log(`Patina system registered ${this.materials.brass.length} brass and ${this.materials.wood.length} wood materials`)
    }
  }

  // Update patina based on epoch count
  public updateFromEpoch(epochCount: number): void {
    let targetLevel: string

    if (epochCount < 10) {
      targetLevel = 'pristine'
    } else if (epochCount < 50) {
      targetLevel = 'light_wear'
    } else if (epochCount < 100) {
      targetLevel = 'aged'
    } else {
      targetLevel = 'rich_patina'
    }

    if (targetLevel !== this.currentLevel) {
      this.transitionTo(targetLevel)
    }
  }

  // Transition to a specific patina level
  public transitionTo(levelName: string): void {
    const level = PATINA_LEVELS[levelName]
    if (!level) {
      console.warn(`Unknown patina level: ${levelName}`)
      return
    }

    if (import.meta.env.DEV) console.log(`Transitioning patina to: ${levelName}`)
    this.currentLevel = levelName
    this.applyLevel(level)
  }

  private applyLevel(level: PatinaLevel): void {
    const duration = 3.0 // Slow transition for atmosphere

    // Update brass materials
    this.materials.brass.forEach(mat => {
      gsap.to(mat, {
        roughness: level.brassRoughness,
        duration,
        ease: 'power2.inOut',
      })

      // Color shift for rich patina
      if (level.brassColorShift) {
        const targetColor = new THREE.Color(level.brassColorShift)
        gsap.to(mat.color, {
          r: targetColor.r,
          g: targetColor.g,
          b: targetColor.b,
          duration,
          ease: 'power2.inOut',
        })
      }
    })

    // Update wood materials
    this.materials.wood.forEach(mat => {
      gsap.to(mat, {
        roughness: level.woodRoughness,
        duration,
        ease: 'power2.inOut',
      })
    })

    // Handle dust particles
    if (level.dustParticles && this.scene) {
      this.createDustParticles()
    } else {
      this.removeDustParticles()
    }

    // Handle wear spots (would need specific meshes to work with)
    // For now, we'll just adjust metalness slightly
    if (level.wearSpots) {
      this.materials.brass.forEach(mat => {
        gsap.to(mat, {
          metalness: Math.max(0.3, mat.metalness - 0.1),
          duration,
          ease: 'power2.inOut',
        })
      })
    }
  }

  private createDustParticles(): void {
    if (this.dustParticles || !this.scene) return

    const count = 30
    const geometry = new THREE.BufferGeometry()
    const positions = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      // Distribute dust around the lab
      positions[i3] = (Math.random() - 0.5) * 8
      positions[i3 + 1] = 0.5 + Math.random() * 2
      positions[i3 + 2] = (Math.random() - 0.5) * 8
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const material = new THREE.PointsMaterial({
      color: 0xa09080,
      size: 0.008,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })

    this.dustParticles = new THREE.Points(geometry, material)
    this.scene.add(this.dustParticles)

    // Fade in
    gsap.fromTo(material, { opacity: 0 }, { opacity: 0.3, duration: 2 })
  }

  private removeDustParticles(): void {
    if (!this.dustParticles || !this.scene) return

    const particles = this.dustParticles
    const material = particles.material as THREE.PointsMaterial

    gsap.to(material, {
      opacity: 0,
      duration: 2,
      onComplete: () => {
        this.scene?.remove(particles)
        particles.geometry.dispose()
        material.dispose()
        this.dustParticles = null
      },
    })
  }

  // Update dust particles (call in animation loop)
  public update(deltaTime: number): void {
    if (!this.dustParticles) return

    const positions = this.dustParticles.geometry.attributes.position.array as Float32Array
    const count = positions.length / 3

    for (let i = 0; i < count; i++) {
      const i3 = i * 3

      // Gentle drift
      positions[i3] += Math.sin(Date.now() * 0.0001 + i) * 0.0005
      positions[i3 + 1] += deltaTime * 0.01 // Slow rise
      positions[i3 + 2] += Math.cos(Date.now() * 0.0001 + i) * 0.0005

      // Reset if too high
      if (positions[i3 + 1] > 3) {
        positions[i3 + 1] = 0.5
      }
    }

    this.dustParticles.geometry.attributes.position.needsUpdate = true
  }

  // Get current level
  public getCurrentLevel(): string {
    return this.currentLevel
  }

  // Dispose
  public dispose(): void {
    this.removeDustParticles()
    this.materials.brass = []
    this.materials.wood = []
  }
}
