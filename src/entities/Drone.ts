import * as THREE from 'three'

// A "subagent" drone: spawns when a model deploys a subagent, hovers and flies
// around/above the central terrarium, then despawns when the subagent is done.
// A subagent's current activity (shown live in the hover card).
const TASK_POOL = [
  'Searching documentation',
  'Running unit tests',
  'Fetching API schema',
  'Summarizing results',
  'Refactoring a helper',
  'Validating edge cases',
  'Crawling references',
  'Drafting a patch',
  'Profiling performance',
  'Checking the spec',
]

export class Drone {
  public group: THREE.Group
  public dead = false
  public labelEl: HTMLElement | null = null // HTML "subagent" nameplate (managed by UIOverlay)
  public parentModel = '' // which model deployed this subagent (shown in hover card)
  public currentTask = '' // what it's doing right now (shown live in hover card)
  public lockedTask: string | null = null // when set, shows this REAL task instead of cycling the generic pool

  private model: THREE.Group | null = null
  private rotors: THREE.Mesh[] = []

  // flight params (an orbit around the plant/tree, with a gentle bob).
  // The orbit formula only produces a DESIRED point; actual motion integrates
  // a velocity toward it (same steering model as the scanner probes), so
  // separation pushes and keep-outs bend the path instead of snapping it.
  private orbitAngle: number
  private orbitRadius: number
  private orbitSpeed: number
  private baseHeight: number
  private bobPhase: number
  private bobAmp: number
  private vel = new THREE.Vector3()
  private yaw = 0
  private bank = 0
  private started = false
  private time = 0
  private dying = false
  private taskTimer = 0

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'subagent_drone'
    this.orbitAngle = Math.random() * Math.PI * 2
    this.orbitRadius = 0.55 + Math.random() * 0.85   // closer in, so it weaves among the branches as the tree grows
    this.orbitSpeed = (0.35 + Math.random() * 0.4) * (Math.random() < 0.5 ? 1 : -1)
    this.baseHeight = 1.1 + Math.random() * 0.9
    this.bobPhase = Math.random() * Math.PI * 2
    this.bobAmp = 0.07 + Math.random() * 0.06
    this.currentTask = TASK_POOL[Math.floor(Math.random() * TASK_POOL.length)]
    this.group.scale.setScalar(0.001) // pops in on spawn
  }

  async load(): Promise<void> {
    // Original geometry: the previous imported drone had no recoverable license.
    // Keep the same small footprint and all existing flight/task behavior.
    this.model = new THREE.Group()
    const shell = new THREE.MeshStandardMaterial({ color: 0x37536a, roughness: 0.7 })
    const frame = new THREE.MeshStandardMaterial({ color: 0x25303a, roughness: 0.8 })
    const light = new THREE.MeshStandardMaterial({ color: 0x71e5ef, emissive: 0x256b7a, emissiveIntensity: 0.8 })
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      this.model!.add(mesh)
      return mesh
    }
    add(new THREE.SphereGeometry(0.078, 12, 8), shell).scale.set(1, 0.55, 0.8)
    add(new THREE.SphereGeometry(0.025, 10, 6), light, 0, 0, -0.058)
    for (const x of [-0.105, 0.105]) {
      for (const z of [-0.075, 0.075]) {
        const arm = add(new THREE.CylinderGeometry(0.009, 0.009, Math.hypot(x, z), 6), frame, x / 2, 0, z / 2)
        arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, 0, z).normalize())
        add(new THREE.CylinderGeometry(0.018, 0.018, 0.035, 8), shell, x, 0.01, z)
        const rotor = add(new THREE.BoxGeometry(0.11, 0.004, 0.014), frame, x, 0.031, z)
        rotor.rotation.y = x * z > 0 ? 0.6 : -0.6
        this.rotors.push(rotor)
      }
    }
    this.group.add(this.model)
  }

  // Begin despawn — shrinks out, then flags dead for the manager to remove.
  public kill(): void {
    this.dying = true
  }

  // `others` = the other drones (for separation), `trunkKeepout` = radius of the
  // central tree-trunk no-fly column (drones weave through branches but not the trunk).
  public update(dt: number, others: Drone[] = [], trunkKeepout = 0.22): void {
    this.time += dt
    this.rotors.forEach((rotor, i) => { rotor.rotation.y += Math.min(dt, 0.05) * (i % 2 ? 35 : -35) })

    // cycle the "current task" so the live hover card changes over time —
    // unless this drone has a real, locked task (an actual subagent finding),
    // which stays put rather than getting overwritten by the generic pool.
    if (this.lockedTask) {
      this.currentTask = this.lockedTask
    } else {
      this.taskTimer += dt
      if (this.taskTimer > 4 + Math.random() * 3) {
        this.taskTimer = 0
        this.currentTask = TASK_POOL[Math.floor(Math.random() * TASK_POOL.length)]
      }
    }

    if (this.dying) {
      const s = this.group.scale.x - dt * 2.5
      if (s <= 0.02) {
        this.dead = true
        return
      }
      this.group.scale.setScalar(s)
    } else if (this.group.scale.x < 1) {
      this.group.scale.setScalar(Math.min(1, this.group.scale.x + dt * 3))
    }

    const fdt = Math.min(dt, 0.05) // tab-throttled rAF must not explode the integrator

    // Desired point: an orbit whose radius and height slowly wander, so no
    // two laps trace the same circle.
    this.orbitAngle += this.orbitSpeed * fdt
    const rWander = this.orbitRadius + Math.sin(this.time * 0.31 + this.bobPhase) * 0.14
    const yWander = this.baseHeight
      + Math.sin(this.time * 1.6 + this.bobPhase) * this.bobAmp
      + Math.sin(this.time * 0.23 + this.bobPhase * 2) * 0.1
    const desired = new THREE.Vector3(
      Math.cos(this.orbitAngle) * rWander,
      yWander,
      Math.sin(this.orbitAngle) * rWander
    )

    // Separation and trunk keep-out act on the target, bending the path early
    // instead of shoving the drone after the fact.
    for (const o of others) {
      if (o === this) continue
      const away = this.group.position.clone().sub(o.group.position)
      away.y *= 0.6
      const d = away.length()
      if (d > 1e-4 && d < 0.5) desired.addScaledVector(away.normalize(), (0.5 - d) * 0.9)
    }
    const dhd = Math.hypot(desired.x, desired.z)
    if (dhd > 1e-4 && dhd < trunkKeepout) {
      const k = trunkKeepout / dhd
      desired.x *= k
      desired.z *= k
    }

    // First frame: start at the desired point so there's no spawn lunge.
    if (!this.started) {
      this.started = true
      this.group.position.copy(desired)
    }

    // Steer: velocity eases toward the target, position integrates velocity.
    const steer = desired.sub(this.group.position).multiplyScalar(2.4)
    this.vel.lerp(steer, Math.min(1, fdt * 3.2))
    const maxV = 0.9
    if (this.vel.length() > maxV) this.vel.setLength(maxV)
    this.group.position.addScaledVector(this.vel, fdt)

    // Hard trunk guard on the integrated position (steering is soft)
    const hd = Math.hypot(this.group.position.x, this.group.position.z)
    if (hd > 1e-4 && hd < trunkKeepout) {
      const k = trunkKeepout / hd
      this.group.position.x *= k
      this.group.position.z *= k
    }

    // Face travel smoothly; bank into lateral velocity like a real quad
    if (this.vel.lengthSq() > 0.002) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z)
      let dy = targetYaw - this.yaw
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      this.yaw += dy * Math.min(1, fdt * 4)
    }
    this.group.rotation.y = this.yaw
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const latV = this.vel.dot(right)
    this.bank += ((-latV * 0.6) - this.bank) * Math.min(1, fdt * 5)
    if (this.model) this.model.rotation.z = this.bank + Math.sin(this.time * 2) * 0.04
  }

  public dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      } else if (o instanceof THREE.Sprite) {
        o.material.map?.dispose()
        o.material.dispose()
      }
    })
  }
}
