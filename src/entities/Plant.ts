import * as THREE from 'three'
import { COLORS } from '../scene/colors'
import type { PlantGeometry, ConflictMarker } from '../shared/types'

// The plant's spec-side state. The plant itself is drawn by the overgrowth as
// one flowering plant in the dome (specimen.ts), grown from the real growth
// record and events; this keeps what the spec says about it (health,
// conflicts, North's and code-backed items, for the overgrowth to show) and
// the moments around it: a soft caustic light disc under it, a gold pulse up
// the stem and spores from the flower when real code merges, falling leaves
// when the reviewers prune.

const CODE_GOLD = new THREE.Color(0xffc94a)

// Plant state that drives visualization (public shape preserved)
export interface PlantState {
  growthStage: number      // 0-1: seed(0) → stable(1)
  healthScore: number      // 0-1
  stabilityScore: number   // 0-1
  capabilities: number     // branches
  constraints: number      // roots
  behaviors: number        // leaves per branch
  conflicts: number        // stress marks
  northLeaves?: number     // North's contributions (green cluster)
  codePrLeaves?: number    // real merged code (gold cluster)
  isAwake?: boolean
  agentName?: string
}

const DEFAULT_STATE: PlantState = {
  growthStage: 0.7, healthScore: 0.8, stabilityScore: 0.6,
  capabilities: 5, constraints: 4, behaviors: 3, conflicts: 1,
  northLeaves: 0, codePrLeaves: 0,
}

function healthColor(h: number): THREE.Color {
  const healthy = new THREE.Color(COLORS.states.healthy)
  const working = new THREE.Color(COLORS.states.working)
  const blocked = new THREE.Color(COLORS.states.blocked)
  // Bias the upper half toward green (exponent < 1): backend leaf health
  // hovers ~0.8, and a linear lerp left the whole canopy mustard.
  return h > 0.5
    ? working.clone().lerp(healthy, Math.pow((h - 0.5) * 2, 0.55))
    : blocked.clone().lerp(working, h * 2)
}

interface BranchDef {
  height: number   // attach height along trunk (world y)
  angle: number
  length: number
  health: number
  isStump: boolean
  leafCount: number
  leafHealth: number
  phase: number    // wind phase
}

export class Plant {
  public group: THREE.Group

  private state: PlantState
  private geometryData: {
    trunkHeight: number
    trunkRadius: number
    trunkHealth: number
    branches: Array<{ height: number; angle: number; length: number; health: number; isStump: boolean; leafCount: number; leafHealth: number }>
    conflictMarkers: ConflictMarker[]
  } | null = null

  private proxies: THREE.Group           // named 'branches' — terrarium shatter physics reads this
  private proxyMat: THREE.MeshBasicMaterial
  private caustic: THREE.Mesh
  private causticMat: THREE.ShaderMaterial
  private branches: BranchDef[] = []
  private trunkH = 0.5

  private time = 0
  private pulseT = -1 // <0 idle; else 0..1 progress of gold pulse
  private leaves: Array<{ mesh: THREE.Mesh; t: number; life: number; sway: number }> = []
  private spores: THREE.Points | null = null
  private sporeVel: Float32Array | null = null
  private sporeT = -1

  constructor(initialState: Partial<PlantState> = {}) {
    this.state = { ...DEFAULT_STATE, ...initialState }
    this.group = new THREE.Group()
    this.group.name = 'plant'

    // invisible proxy meshes at branch tips — GlassTerrarium.checkPlantBounds
    // traverses a group named 'branches' to detect growth beyond the dome.
    this.proxies = new THREE.Group()
    this.proxies.name = 'branches'
    this.proxyMat = new THREE.MeshBasicMaterial({ visible: false })
    this.group.add(this.proxies)

    // caustic light disc under the plant — grows with the plant
    this.causticMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uA: { value: 0.2 }, uHue: { value: new THREE.Color(0xbfe3a0) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv*2.-1.; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        varying vec2 vUv; uniform float uT; uniform float uA; uniform vec3 uHue;
        void main(){
          float r = length(vUv);
          if (r > 1.0) discard;
          float dapple = 0.75 + 0.25 * sin(vUv.x*7.0 + uT*0.7) * sin(vUv.y*6.0 - uT*0.9);
          float a = pow(1.0 - r, 1.6) * dapple * uA;
          gl_FragColor = vec4(uHue, a);
        }`,
    })
    this.caustic = new THREE.Mesh(new THREE.CircleGeometry(1, 28), this.causticMat)
    this.caustic.rotation.x = -Math.PI / 2
    this.caustic.position.y = 0.005
    this.group.add(this.caustic)

    this.rebuildStructure()
  }

  // ---------------------------------------------------------------------------
  // structure (called on state/geometry change — not per frame)
  // ---------------------------------------------------------------------------
  private rebuildStructure(): void {
    const s = this.state
    const g = this.geometryData

    this.trunkH = g ? g.trunkHeight : 0.12 + s.growthStage * 0.68

    this.branches = []
    if (g) {
      g.branches.forEach((b, i) => this.branches.push({ ...b, phase: i * 1.73 }))
    } else if (s.growthStage >= 0.3) {
      const n = Math.min(s.capabilities, Math.floor(s.growthStage * 8))
      for (let i = 0; i < n; i++) {
        this.branches.push({
          height: 0.5 + (i / Math.max(n, 1)) * 0.42,
          angle: (i / Math.max(n, 1)) * Math.PI * 2 + i * 0.6,
          length: 0.16 + (i % 3) * 0.035,
          health: s.healthScore,
          isStump: false,
          leafCount: Math.min(s.behaviors, Math.floor(s.growthStage * 5)),
          leafHealth: s.healthScore,
          phase: i * 1.73,
        })
      }
    }

    // rebuild shatter proxies at branch tips + crown
    while (this.proxies.children.length) {
      const c = this.proxies.children[0] as THREE.Group
      this.proxies.remove(c)
      c.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    }
    const mkProxy = (x: number, y: number, z: number) => {
      const wrap = new THREE.Group()
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), this.proxyMat)
      m.position.set(x, y, z)
      wrap.add(m)
      this.proxies.add(wrap)
    }
    for (const b of this.branches) {
      const ay = b.height * this.trunkH
      const tip = this.branchTip(b, 0)
      mkProxy(tip.x, ay + tip.y, tip.z)
    }
    mkProxy(0, this.trunkH + 0.1 + this.state.growthStage * 0.12, 0) // crown
  }

  private branchTip(b: BranchDef, wind: number): THREE.Vector3 {
    const up = 0.35 + b.health * 0.3
    const dir = new THREE.Vector3(Math.cos(b.angle), up, Math.sin(b.angle)).normalize()
    const len = b.isStump ? 0.05 : b.length
    return dir.multiplyScalar(len).add(new THREE.Vector3(Math.sin(wind) * 0.02, 0, Math.cos(wind * 0.8) * 0.015))
  }

  // ---------------------------------------------------------------------------
  // public API (unchanged surface)
  // ---------------------------------------------------------------------------
  public getTrunkKeepout(): number {
    return 0.15 + this.state.growthStage * 0.3
  }

  public setState(newState: Partial<PlantState>): void {
    this.state = { ...this.state, ...newState }
    this.geometryData = null
    this.rebuildStructure()
  }

  public setGeometry(geometry: PlantGeometry): void {
    if (!geometry.nodes || geometry.nodes.length === 0) return
    const trunk = geometry.nodes.find(n => n.type === 'trunk')
    if (!trunk) return
    const branchNodes = trunk.children.filter(c => c.type === 'branch')
    const stages: Record<string, number> = { seed: 0.1, sprout: 0.3, growing: 0.6, mature: 0.85, stable: 1.0 }

    this.state.growthStage = stages[geometry.growthStage] || 0.5
    this.state.healthScore = geometry.overallHealth
    this.state.stabilityScore = geometry.overallHealth
    this.state.capabilities = branchNodes.length
    this.state.conflicts = geometry.conflictMarkers.length

    // The backend's raw proportions were authored for the old cylinder-mesh
    // renderer (fat trunk, 20+ branches all attached at one height). Keep its
    // DATA — branch count, radial angles, health, stumps — but lay it out
    // with the same tuned proportions as the count-based path, and sample
    // down to the SDF shader's capsule budget.
    const MAX_BRANCHES = 8
    const stumps = branchNodes.filter(b => b.length <= 0.06).slice(0, 2)
    const live = branchNodes.filter(b => b.length > 0.06)
    const step = Math.max(1, Math.ceil(live.length / (MAX_BRANCHES - stumps.length)))
    const sampled = [...stumps, ...live.filter((_, i) => i % step === 0)].slice(0, MAX_BRANCHES)

    // Foliage from dropped branches folds into the kept ones, so canopy
    // volume still reflects the real spec size.
    const totalLeaves = branchNodes.reduce(
      (sum, b) => sum + b.children.filter(c => c.type === 'leaf').length, 0)
    const leafShare = Math.ceil(totalLeaves / Math.max(sampled.length, 1))

    this.geometryData = {
      trunkHeight: THREE.MathUtils.clamp(trunk.length * 1.15, 0.35, 0.85),
      trunkRadius: THREE.MathUtils.clamp(trunk.thickness * 0.45, 0.028, 0.075),
      trunkHealth: trunk.health,
      branches: sampled.map((b, i) => {
        const leaves = b.children.filter(c => c.type === 'leaf')
        return {
          // spread attach heights up the trunk — the backend parks every
          // branch at the same y, which reads as an umbrella. Start high so
          // bare trunk stays visible below the canopy.
          height: 0.58 + (i / Math.max(sampled.length, 1)) * 0.36,
          angle: Math.atan2(b.direction[2], b.direction[0]),
          length: b.length <= 0.06 ? b.length : THREE.MathUtils.clamp(b.length * 0.75, 0.14, 0.23),
          health: b.health,
          isStump: b.length <= 0.06,
          leafCount: Math.min(leaves.length + leafShare - 1, 5),
          leafHealth: leaves.length > 0
            ? leaves.reduce((sum, l) => sum + l.health, 0) / leaves.length
            : b.health,
        }
      }),
      conflictMarkers: geometry.conflictMarkers,
    }
    this.rebuildStructure()
  }

  public addNorthLeaf(): void {
    this.state.northLeaves = (this.state.northLeaves ?? 0) + 1
  }

  public addCodePrLeaf(): void {
    this.state.codePrLeaves = (this.state.codePrLeaves ?? 0) + 1
    this.pulseGold()
  }

  // Gold shimmer travels up the trunk — a real merge just landed.
  public pulseGold(): void {
    this.pulseT = 0
  }

  // Gold spores erupt from the crown — celebration for a real merge.
  public burstSpores(): void {
    const N = 18
    if (!this.spores) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
      const mat = new THREE.PointsMaterial({
        color: CODE_GOLD, size: 0.022, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      })
      this.spores = new THREE.Points(geo, mat)
      this.spores.frustumCulled = false
      this.group.add(this.spores)
      this.sporeVel = new Float32Array(N * 3)
    }
    const pos = (this.spores.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + Math.random() * 0.5
      pos[i * 3] = Math.cos(a) * 0.04
      pos[i * 3 + 1] = this.trunkH + 0.08
      pos[i * 3 + 2] = Math.sin(a) * 0.04
      this.sporeVel![i * 3] = Math.cos(a) * (0.12 + Math.random() * 0.15)
      this.sporeVel![i * 3 + 1] = 0.3 + Math.random() * 0.25
      this.sporeVel![i * 3 + 2] = Math.sin(a) * (0.12 + Math.random() * 0.15)
    }
    ;(this.spores.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    this.spores.visible = true
    this.sporeT = 0
  }

  // A reviewer pruned something — a leaf falls.
  public dropLeaf(count = 1): void {
    for (let i = 0; i < Math.min(count, 3); i++) {
      const geo = new THREE.CircleGeometry(0.035, 6)
      const mat = new THREE.MeshBasicMaterial({
        color: healthColor(0.4 + Math.random() * 0.3), transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, mat)
      const a = Math.random() * Math.PI * 2
      mesh.position.set(Math.cos(a) * 0.15, this.trunkH + 0.05, Math.sin(a) * 0.15)
      this.group.add(mesh)
      this.leaves.push({ mesh, t: 0, life: 1.8 + Math.random() * 0.8, sway: Math.random() * Math.PI * 2 })
    }
  }

  public setAwake(awake: boolean, agentName?: string): void {
    this.state.isAwake = awake
    if (agentName) this.state.agentName = agentName
  }
  public getIsAwake(): boolean { return !!this.state.isAwake }
  public getAgentName(): string | undefined { return this.state.agentName }

  /**
   * What the spec says about the plant, for the flowering plant to show: leaf
   * health, unresolved conflicts, North's and code-backed items, and where
   * the gold pulse is (0..1.3 up the stem, -1 when there is none).
   */
  public signals(): { health: number; conflicts: number; north: number; gold: number; pulse: number; pulseStrength: number } {
    const s = this.state
    const p = this.pulseT
    return {
      health: s.healthScore,
      conflicts: s.conflicts,
      north: s.northLeaves ?? 0,
      gold: s.codePrLeaves ?? 0,
      pulse: p,
      pulseStrength: p < 0 ? 0 : 0.55 * (1 - Math.max(p - 0.85, 0) / 0.45),
    }
  }

  public update(deltaTime: number): void {
    const dt = Math.min(deltaTime, 0.05)
    this.time += dt

    // gold pulse travels base → crown, then fades
    if (this.pulseT >= 0) {
      this.pulseT += dt * 1.1
      if (this.pulseT >= 1.3) this.pulseT = -1
    }

    // caustic disc: grows with the plant, gentle dapple
    const cs = 0.3 + this.state.growthStage * 0.55
    this.caustic.scale.setScalar(cs)
    this.causticMat.uniforms.uT.value = this.time
    this.causticMat.uniforms.uA.value = 0.14 + this.state.healthScore * 0.1

    // spore burst: rise, drift outward, gravity takes over, fade
    if (this.sporeT >= 0 && this.spores && this.sporeVel) {
      this.sporeT += dt
      const life = 1.4
      if (this.sporeT >= life) {
        this.sporeT = -1
        this.spores.visible = false
      } else {
        const pos = (this.spores.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
        for (let i = 0; i < pos.length; i += 3) {
          this.sporeVel[i + 1] -= dt * 0.5
          pos[i] += this.sporeVel[i] * dt
          pos[i + 1] += this.sporeVel[i + 1] * dt
          pos[i + 2] += this.sporeVel[i + 2] * dt
        }
        ;(this.spores.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
        ;(this.spores.material as THREE.PointsMaterial).opacity = 0.9 * (1 - this.sporeT / life)
      }
    }

    // falling leaves
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const l = this.leaves[i]
      l.t += dt
      const a = l.t / l.life
      if (a >= 1) {
        this.group.remove(l.mesh)
        l.mesh.geometry.dispose()
        ;(l.mesh.material as THREE.Material).dispose()
        this.leaves.splice(i, 1)
        continue
      }
      l.mesh.position.y -= dt * 0.22
      l.mesh.position.x += Math.sin(this.time * 2.2 + l.sway) * dt * 0.12
      l.mesh.rotation.x = Math.sin(this.time * 1.8 + l.sway) * 0.9
      l.mesh.rotation.z += dt * 1.4
      ;(l.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - Math.max(a - 0.7, 0) / 0.3)
    }
  }

  public dispose(): void {
    this.caustic.geometry.dispose()
    this.causticMat.dispose()
    this.proxyMat.dispose()
    if (this.spores) {
      this.spores.geometry.dispose()
      ;(this.spores.material as THREE.Material).dispose()
    }
    for (const l of this.leaves) {
      l.mesh.geometry.dispose()
      ;(l.mesh.material as THREE.Material).dispose()
    }
  }
}
