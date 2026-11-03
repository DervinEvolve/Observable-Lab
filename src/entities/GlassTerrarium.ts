import * as THREE from 'three'
import { COLORS } from '../scene/colors'

// Glass terrarium states based on physical plant contact
export type GlassState = 'pristine' | 'touched' | 'cracked' | 'shattered'

// Terrarium physical dimensions
const DOME_RADIUS = 1.0
const DOME_INNER_RADIUS = 0.95 // Account for glass thickness
const DOME_BASE_Y = 0.3

// Thresholds for breaking
const BRANCHES_TO_SHATTER = 3 // Shatter when 3+ branches exceed bounds
const VOLUME_THRESHOLD = 0.7 // Shatter when plant fills 70%+ of terrarium volume

// Shard configuration
const SHARD_COUNT = 10
const SHARD_FALL_DURATION = 1.5 // seconds
const CRACK_SPREAD_DURATION = 0.5 // seconds

interface ContactPoint {
  position: THREE.Vector3
  normal: THREE.Vector3 // Direction from center to contact
}

interface ShardData {
  mesh: THREE.Mesh
  velocity: THREE.Vector3
  rotationVelocity: THREE.Vector3
  grounded: boolean
  groundY: number
}

export class GlassTerrarium {
  public group: THREE.Group

  private dome: THREE.Mesh | null = null
  private domeGeometry: THREE.SphereGeometry | null = null
  private domeMaterial: THREE.MeshPhysicalMaterial | null = null
  private crackOverlay: THREE.Mesh | null = null
  private crackCanvas: HTMLCanvasElement | null = null
  private crackTexture: THREE.CanvasTexture | null = null

  private shards: ShardData[] = []
  private shardsGroup: THREE.Group
  private brassRing: THREE.Mesh | null = null
  private atmosphere: THREE.Mesh | null = null
  private atmosphereMat: THREE.ShaderMaterial | null = null
  private time = 0

  private currentState: GlassState = 'pristine'
  private isShattered: boolean = false
  private isAnimatingShatter: boolean = false
  private shatterStartTime: number = 0
  private crackProgress: number = 0

  // Contact tracking for physics-based cracks
  private contactPoints: ContactPoint[] = []
  private branchesExceedingBounds: number = 0
  private estimatedPlantVolume: number = 0

  // Callbacks
  public onShatter: (() => void) | null = null

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'glassTerrarium'

    this.shardsGroup = new THREE.Group()
    this.shardsGroup.name = 'shards'
    this.group.add(this.shardsGroup)

    this.buildDome()
    this.buildCrackOverlay()
    this.buildBrassRing()
    this.buildAtmosphere()
  }

  // Fresnel rim light + condensation band near the soil — the glass reads as
  // real glass with a humid microclimate inside, not a ghost hemisphere.
  private buildAtmosphere(): void {
    const geo = new THREE.SphereGeometry(DOME_RADIUS + 0.005, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2)
    this.atmosphereMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      uniforms: { uT: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        varying float vY;
        void main() {
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vY = position.y / ${DOME_RADIUS.toFixed(2)};
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        varying float vY;
        uniform float uT;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec3 v = normalize(cameraPosition - vWorldPos);
          float fresnel = pow(1.0 - abs(dot(normalize(vNormal), v)), 3.5);

          // warm rim catch-light
          vec3 col = vec3(1.0, 0.97, 0.9);
          float a = fresnel * 0.32;

          // condensation: misty band hugging the soil, beaded with droplets
          float band = smoothstep(0.30, 0.03, vY);
          float theta = atan(vWorldPos.z, vWorldPos.x);
          vec2 cell = vec2(theta * 22.0, vY * 34.0 + uT * 0.015);
          float h = hash(floor(cell));
          float drop = smoothstep(0.955, 0.985, h) * band;
          float mist = band * (0.10 + 0.03 * sin(theta * 3.0 + uT * 0.2));
          a += mist + drop * 0.30;
          col = mix(col, vec3(0.94, 0.98, 0.96), band);

          gl_FragColor = vec4(col, a);
        }`,
    })
    this.atmosphere = new THREE.Mesh(geo, this.atmosphereMat)
    this.atmosphere.position.y = DOME_BASE_Y
    this.atmosphere.name = 'terrariumAtmosphere'
    this.group.add(this.atmosphere)
  }

  private buildDome(): void {
    // Glass dome geometry - hemisphere
    this.domeGeometry = new THREE.SphereGeometry(DOME_RADIUS, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2)

    this.domeMaterial = new THREE.MeshPhysicalMaterial({
      color: COLORS.structure.glass,
      transparent: true,
      opacity: 0.15,
      roughness: 0.05,
      metalness: 0.0,
      transmission: 0.9,
      thickness: 0.1,
      side: THREE.DoubleSide,
    })

    this.dome = new THREE.Mesh(this.domeGeometry, this.domeMaterial)
    this.dome.position.y = DOME_BASE_Y
    this.dome.name = 'terrariumDome'
    this.group.add(this.dome)
  }

  private buildCrackOverlay(): void {
    // Canvas for drawing crack lines
    this.crackCanvas = document.createElement('canvas')
    this.crackCanvas.width = 512
    this.crackCanvas.height = 512

    this.crackTexture = new THREE.CanvasTexture(this.crackCanvas)
    this.crackTexture.wrapS = THREE.RepeatWrapping
    this.crackTexture.wrapT = THREE.RepeatWrapping

    // Crack overlay - slightly larger than dome
    const crackGeometry = new THREE.SphereGeometry(DOME_RADIUS + 0.01, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2)
    const crackMaterial = new THREE.MeshBasicMaterial({
      map: this.crackTexture,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    this.crackOverlay = new THREE.Mesh(crackGeometry, crackMaterial)
    this.crackOverlay.position.y = DOME_BASE_Y
    this.crackOverlay.name = 'crackOverlay'
    this.group.add(this.crackOverlay)

    // Clear the canvas initially
    this.clearCracks()
  }

  private buildBrassRing(): void {
    const ringGeometry = new THREE.TorusGeometry(DOME_RADIUS, 0.04, 8, 32)
    const brassMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.structure.brass,
      roughness: 0.4,
      metalness: 0.7,
    })

    this.brassRing = new THREE.Mesh(ringGeometry, brassMaterial)
    this.brassRing.rotation.x = Math.PI / 2
    this.brassRing.position.y = DOME_BASE_Y + 0.02
    this.brassRing.name = 'terrariumRing'
    this.group.add(this.brassRing)
  }

  private clearCracks(): void {
    if (!this.crackCanvas) return
    const ctx = this.crackCanvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, this.crackCanvas.width, this.crackCanvas.height)
    if (this.crackTexture) {
      this.crackTexture.needsUpdate = true
    }
  }

  // Convert 3D contact point to 2D UV coordinates on the dome
  private worldToUV(point: THREE.Vector3): { u: number; v: number } {
    // Normalize to dome-local coordinates (dome center at y=DOME_BASE_Y)
    const localY = point.y - DOME_BASE_Y
    const localX = point.x
    const localZ = point.z

    // Convert to spherical coordinates
    const theta = Math.atan2(localZ, localX) // Azimuthal angle
    const phi = Math.acos(Math.min(1, localY / DOME_RADIUS)) // Polar angle from top

    // Map to UV (0-1)
    const u = (theta + Math.PI) / (2 * Math.PI) // 0-1 around
    const v = phi / (Math.PI / 2) // 0-1 from top to equator

    return { u: u * this.crackCanvas!.width, v: v * this.crackCanvas!.height }
  }

  private drawCracksAtContacts(): void {
    if (!this.crackCanvas || !this.crackOverlay) return
    const ctx = this.crackCanvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, this.crackCanvas.width, this.crackCanvas.height)

    if (this.contactPoints.length === 0) {
      const material = this.crackOverlay.material as THREE.MeshBasicMaterial
      material.opacity = 0
      this.crackTexture!.needsUpdate = true
      return
    }

    // Draw cracks radiating from each contact point
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'

    this.contactPoints.forEach((contact, index) => {
      const uv = this.worldToUV(contact.position)
      const crackCount = 4 + Math.floor(Math.random() * 3)

      for (let j = 0; j < crackCount; j++) {
        this.drawSingleCrack(ctx, uv.u, uv.v, 1.0, index * 17 + j * 31)
      }
    })

    // Set overlay opacity based on number of contacts
    const material = this.crackOverlay.material as THREE.MeshBasicMaterial
    material.opacity = Math.min(0.9, this.contactPoints.length * 0.3)

    this.crackTexture!.needsUpdate = true
  }

  private drawCracksForShatter(progress: number): void {
    if (!this.crackCanvas || !this.crackOverlay) return
    const ctx = this.crackCanvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, this.crackCanvas.width, this.crackCanvas.height)

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'

    // Start from existing contact points, then spread everywhere
    const origins = this.contactPoints.length > 0
      ? this.contactPoints.map(c => this.worldToUV(c.position))
      : [{ u: 256, v: 256 }] // Fallback center

    // Add more random origins as cracks spread
    const additionalOrigins = Math.floor(progress * 8)
    for (let i = 0; i < additionalOrigins; i++) {
      origins.push({
        u: 100 + Math.random() * 312,
        v: 100 + Math.random() * 312,
      })
    }

    origins.forEach((origin, i) => {
      const crackCount = 5 + Math.floor(Math.random() * 4)
      for (let j = 0; j < crackCount; j++) {
        this.drawSingleCrack(ctx, origin.u, origin.v, progress, i * 17 + j * 31)
      }
    })

    const material = this.crackOverlay.material as THREE.MeshBasicMaterial
    material.opacity = progress * 0.95

    this.crackTexture!.needsUpdate = true
  }

  private drawSingleCrack(
    ctx: CanvasRenderingContext2D,
    startX: number,
    startY: number,
    progress: number,
    seed: number
  ): void {
    // Seeded random for consistent cracks
    const random = (offset: number) => {
      const x = Math.sin(seed + offset) * 10000
      return x - Math.floor(x)
    }

    const angle = random(0) * Math.PI * 2
    const maxLength = 60 + random(1) * 80
    const length = maxLength * progress

    ctx.beginPath()
    ctx.moveTo(startX, startY)

    let x = startX
    let y = startY
    const segments = Math.floor(length / 10)

    for (let i = 0; i < segments; i++) {
      const segmentAngle = angle + (random(i + 2) - 0.5) * 0.8
      const segmentLength = 8 + random(i + 3) * 8

      x += Math.cos(segmentAngle) * segmentLength
      y += Math.sin(segmentAngle) * segmentLength
      ctx.lineTo(x, y)

      // Branch cracks
      if (random(i + 10) > 0.7 && i > 1) {
        const branchAngle = segmentAngle + (random(i + 20) - 0.5) * 1.2
        const branchLength = segmentLength * 0.6 * progress
        ctx.moveTo(x, y)
        ctx.lineTo(
          x + Math.cos(branchAngle) * branchLength,
          y + Math.sin(branchAngle) * branchLength
        )
        ctx.moveTo(x, y)
      }
    }

    ctx.stroke()
  }

  private createShards(): void {
    if (!this.dome || !this.domeMaterial) return

    // Hide the dome
    this.dome.visible = false
    if (this.crackOverlay) {
      this.crackOverlay.visible = false
    }
    if (this.atmosphere) {
      this.atmosphere.visible = false
    }

    // Create shard meshes
    const shardMaterial = new THREE.MeshPhysicalMaterial({
      color: COLORS.structure.glass,
      transparent: true,
      opacity: 0.3,
      roughness: 0.1,
      metalness: 0.0,
      transmission: 0.7,
      thickness: 0.05,
      side: THREE.DoubleSide,
    })

    for (let i = 0; i < SHARD_COUNT; i++) {
      const shardGeometry = this.createShardGeometry(i)
      const shard = new THREE.Mesh(shardGeometry, shardMaterial.clone())

      // Position on the dome surface
      const theta = (i / SHARD_COUNT) * Math.PI * 2
      const phi = 0.3 + Math.random() * 0.5

      shard.position.set(
        DOME_RADIUS * Math.sin(phi) * Math.cos(theta),
        DOME_BASE_Y + DOME_RADIUS * Math.cos(phi),
        DOME_RADIUS * Math.sin(phi) * Math.sin(theta)
      )

      shard.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      )

      // Velocity - explode outward and up, then fall
      const outwardDir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        0.5 + Math.random() * 0.5,
        Math.sin(phi) * Math.sin(theta)
      ).normalize()

      const velocity = outwardDir.multiplyScalar(2 + Math.random() * 1.5)

      const shardData: ShardData = {
        mesh: shard,
        velocity,
        rotationVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8
        ),
        grounded: false,
        groundY: 0.05 + Math.random() * 0.1,
      }

      this.shards.push(shardData)
      this.shardsGroup.add(shard)
    }
  }

  private createShardGeometry(_index: number): THREE.BufferGeometry {
    const shape = new THREE.Shape()
    const points = 4 + Math.floor(Math.random() * 3)
    const baseSize = 0.1 + Math.random() * 0.15

    for (let i = 0; i < points; i++) {
      const angle = (i / points) * Math.PI * 2
      const radius = baseSize * (0.6 + Math.random() * 0.4)
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius

      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()

    const extrudeSettings = {
      depth: 0.01 + Math.random() * 0.01,
      bevelEnabled: false,
    }

    return new THREE.ExtrudeGeometry(shape, extrudeSettings)
  }

  // Calculate plant bounds and check for contact with glass
  public checkPlantBounds(plantGroup: THREE.Group): void {
    if (this.isShattered || this.isAnimatingShatter) return

    const newContactPoints: ContactPoint[] = []
    let branchesOutside = 0
    let totalVolume = 0

    // Get world matrix for plant group
    plantGroup.updateMatrixWorld(true)

    // Check branches group
    const branchesGroup = plantGroup.getObjectByName('branches')
    if (branchesGroup) {
      branchesGroup.children.forEach((branch) => {
        // Get branch world position
        const branchWorldPos = new THREE.Vector3()
        branch.getWorldPosition(branchWorldPos)

        // Check all meshes in branch for extremities
        branch.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            // Get bounding box in world space
            const box = new THREE.Box3().setFromObject(child)
            const corners = [
              new THREE.Vector3(box.min.x, box.min.y, box.min.z),
              new THREE.Vector3(box.max.x, box.min.y, box.min.z),
              new THREE.Vector3(box.min.x, box.max.y, box.min.z),
              new THREE.Vector3(box.max.x, box.max.y, box.min.z),
              new THREE.Vector3(box.min.x, box.min.y, box.max.z),
              new THREE.Vector3(box.max.x, box.min.y, box.max.z),
              new THREE.Vector3(box.min.x, box.max.y, box.max.z),
              new THREE.Vector3(box.max.x, box.max.y, box.max.z),
            ]

            corners.forEach((corner) => {
              // Check if point is outside dome
              const relativeY = corner.y - DOME_BASE_Y
              if (relativeY < 0) return // Below dome base

              // Dome is a hemisphere: check if point is outside the spherical surface
              // For a hemisphere, any point where sqrt(x² + z² + (y-base)²) > radius is outside
              const distFromCenter = Math.sqrt(
                corner.x * corner.x +
                corner.z * corner.z +
                relativeY * relativeY
              )

              if (distFromCenter > DOME_INNER_RADIUS) {
                branchesOutside++

                // Calculate contact point on dome surface
                const normal = new THREE.Vector3(corner.x, relativeY, corner.z).normalize()
                const contactPos = normal.clone().multiplyScalar(DOME_RADIUS)
                contactPos.y += DOME_BASE_Y

                newContactPoints.push({
                  position: contactPos,
                  normal: normal,
                })
              }
            })

            // Estimate volume contribution
            const size = new THREE.Vector3()
            box.getSize(size)
            totalVolume += size.x * size.y * size.z
          }
        })
      })
    }

    // Also check leaves group
    const leavesGroup = plantGroup.getObjectByName('leaves')
    if (leavesGroup) {
      leavesGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const worldPos = new THREE.Vector3()
          child.getWorldPosition(worldPos)

          const relativeY = worldPos.y - DOME_BASE_Y
          if (relativeY < 0) return

          const distFromCenter = Math.sqrt(
            worldPos.x * worldPos.x +
            worldPos.z * worldPos.z +
            relativeY * relativeY
          )

          if (distFromCenter > DOME_INNER_RADIUS) {
            const normal = new THREE.Vector3(worldPos.x, relativeY, worldPos.z).normalize()
            const contactPos = normal.clone().multiplyScalar(DOME_RADIUS)
            contactPos.y += DOME_BASE_Y

            newContactPoints.push({
              position: contactPos,
              normal: normal,
            })
          }
        }
      })
    }

    // Update contact tracking
    this.contactPoints = newContactPoints
    this.branchesExceedingBounds = branchesOutside

    // Calculate volume ratio (dome volume = 2/3 * π * r³)
    const domeVolume = (2 / 3) * Math.PI * Math.pow(DOME_INNER_RADIUS, 3)
    this.estimatedPlantVolume = totalVolume / domeVolume

    // Update glass state based on contacts
    this.updateGlassState()
  }

  private updateGlassState(): void {
    if (this.isShattered || this.isAnimatingShatter) return

    // Check shatter conditions
    const shouldShatter =
      this.branchesExceedingBounds >= BRANCHES_TO_SHATTER ||
      this.estimatedPlantVolume > VOLUME_THRESHOLD

    if (shouldShatter) {
      this.triggerShatter()
      return
    }

    // Update crack state based on contacts
    if (this.contactPoints.length === 0) {
      if (this.currentState !== 'pristine') {
        this.currentState = 'pristine'
        this.clearCracks()
      }
    } else if (this.contactPoints.length < 3) {
      this.currentState = 'touched'
      this.drawCracksAtContacts()
    } else {
      this.currentState = 'cracked'
      this.drawCracksAtContacts()
    }
  }

  // For loading persisted state (page reload)
  public setShatteredState(shattered: boolean): void {
    if (shattered && !this.isShattered) {
      this.isShattered = true
      this.currentState = 'shattered'

      if (this.dome) {
        this.dome.visible = false
      }
      if (this.crackOverlay) {
        this.crackOverlay.visible = false
      }
      if (this.atmosphere) {
        this.atmosphere.visible = false
      }

      this.createStaticShards()
    }
  }

  private triggerShatter(): void {
    if (this.isShattered || this.isAnimatingShatter) return

    this.isAnimatingShatter = true
    this.shatterStartTime = performance.now() / 1000
    this.crackProgress = 0
    this.currentState = 'shattered'

    if (import.meta.env.DEV) {
      console.log(
        `%c🔮 Glass shattering! Branches outside: ${this.branchesExceedingBounds}, Volume: ${(this.estimatedPlantVolume * 100).toFixed(1)}%`,
        'color: #64b5f6; font-weight: bold'
      )
    }
  }

  private createStaticShards(): void {
    const shardMaterial = new THREE.MeshPhysicalMaterial({
      color: COLORS.structure.glass,
      transparent: true,
      opacity: 0.3,
      roughness: 0.1,
      metalness: 0.0,
      transmission: 0.7,
      thickness: 0.05,
      side: THREE.DoubleSide,
    })

    for (let i = 0; i < SHARD_COUNT; i++) {
      const shardGeometry = this.createShardGeometry(i)
      const shard = new THREE.Mesh(shardGeometry, shardMaterial.clone())

      const angle = (i / SHARD_COUNT) * Math.PI * 2 + Math.random() * 0.5
      const distance = 0.8 + Math.random() * 0.8

      shard.position.set(
        Math.cos(angle) * distance,
        0.05 + Math.random() * 0.05,
        Math.sin(angle) * distance
      )

      shard.rotation.set(
        Math.PI / 2 + (Math.random() - 0.5) * 0.3,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.2
      )

      this.shardsGroup.add(shard)
    }
  }

  // Animation update
  public update(deltaTime: number): void {
    this.time += Math.min(deltaTime, 0.05)
    if (this.atmosphereMat) this.atmosphereMat.uniforms.uT.value = this.time

    if (!this.isAnimatingShatter) return

    const elapsed = performance.now() / 1000 - this.shatterStartTime

    // Phase 1: Crack spread (0 - 0.5s)
    if (elapsed < CRACK_SPREAD_DURATION) {
      this.crackProgress = elapsed / CRACK_SPREAD_DURATION
      this.drawCracksForShatter(this.crackProgress)
      return
    }

    // Phase 2: Create shards at the moment of shatter
    if (this.shards.length === 0) {
      this.createShards()

      if (this.onShatter) {
        this.onShatter()
      }
    }

    // Phase 3: Shard physics
    const shatterElapsed = elapsed - CRACK_SPREAD_DURATION

    if (shatterElapsed < SHARD_FALL_DURATION) {
      const gravity = 9.8

      this.shards.forEach((shard) => {
        if (shard.grounded) return

        shard.velocity.y -= gravity * deltaTime
        shard.mesh.position.add(shard.velocity.clone().multiplyScalar(deltaTime))

        shard.mesh.rotation.x += shard.rotationVelocity.x * deltaTime
        shard.mesh.rotation.y += shard.rotationVelocity.y * deltaTime
        shard.mesh.rotation.z += shard.rotationVelocity.z * deltaTime

        if (shard.mesh.position.y <= shard.groundY) {
          shard.mesh.position.y = shard.groundY
          shard.grounded = true
          shard.mesh.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.3
          shard.mesh.rotation.z = (Math.random() - 0.5) * 0.2
        }

        shard.velocity.x *= 0.98
        shard.velocity.z *= 0.98
      })
    } else {
      this.isAnimatingShatter = false
      this.isShattered = true

      this.shards.forEach((shard) => {
        if (!shard.grounded) {
          shard.mesh.position.y = shard.groundY
          shard.grounded = true
        }
      })
    }
  }

  public getIsShattered(): boolean {
    return this.isShattered
  }

  public getState(): GlassState {
    return this.currentState
  }

  public getContactCount(): number {
    return this.contactPoints.length
  }

  public getBranchesOutside(): number {
    return this.branchesExceedingBounds
  }

  public dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material.dispose()
        }
      }
    })

    if (this.crackTexture) {
      this.crackTexture.dispose()
    }
  }
}
