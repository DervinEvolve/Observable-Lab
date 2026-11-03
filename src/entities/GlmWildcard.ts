import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'

// GLM — a wildcard R&D model, embodied as a small hovering ship. It stays in the
// same spot in front of the neural-net artwork (station gap at angle 162°), drifting
// on a bounded Lissajous-style wander so the motion reads as alive, not mechanical.
// Works with North on their own branch experiments.
const GLM_GLB = '/models/glm/spaceship.glb'
const ANGLE = (162 * Math.PI) / 180
const RADIUS = 6.0          // floor spot in front of the wall art
const SHIP_SIZE = 0.5       // small — a notch bigger than the ~0.34 subagent drones

const HALF_WIDTH = 0.8      // lateral wander bound (left-right along the wall)
const DEPTH = 0.3           // forward/back wander bound (toward/away from the wall)
const BASE_HEIGHT = 1.55    // hovers roughly at head height
const BOB_AMP = 0.16        // vertical bob amplitude

// Two incommensurate frequencies per axis so the drift never quite repeats.
const LAT_F1 = 0.21, LAT_A1 = HALF_WIDTH * 0.62
const LAT_F2 = 0.47, LAT_A2 = HALF_WIDTH * 0.38
const DEP_F1 = 0.33, DEP_A1 = DEPTH * 0.65
const DEP_F2 = 0.61, DEP_A2 = DEPTH * 0.35
const BOB_F = 0.9
const DRIFT_F = 0.15, DRIFT_A = 0.1

// Shortest-path angular interpolation (radians).
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

export class GlmWildcard {
  public group: THREE.Group
  public labelEl: HTMLElement | null = null
  public readonly name = 'GLM'
  public readonly modelId = 'z-ai/glm-5.2'
  public readonly accent = 0xb07cff

  private model: THREE.Group | null = null
  private mixer: THREE.AnimationMixer | null = null
  private loaded = false
  private time = 0
  private heading = 0
  private center: THREE.Vector3
  private tangent: THREE.Vector3
  private normal: THREE.Vector3

  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'glm_wildcard'
    this.center = new THREE.Vector3(Math.cos(ANGLE) * RADIUS, 0, Math.sin(ANGLE) * RADIUS)
    this.tangent = new THREE.Vector3(-Math.sin(ANGLE), 0, Math.cos(ANGLE))
    this.normal = new THREE.Vector3(Math.cos(ANGLE), 0, Math.sin(ANGLE)) // toward/away from the wall
    this.group.position.copy(this.center).setY(BASE_HEIGHT)
    this.heading = Math.atan2(this.tangent.x, this.tangent.z)
    this.group.rotation.y = this.heading
  }

  public isLoaded(): boolean {
    return this.loaded
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader()
    const gltf = (await loader.loadAsync(GLM_GLB)) as GLTF
    this.model = gltf.scene

    // Auto-scale small and recenter, same approach as the subagent drones.
    const box = new THREE.Box3().setFromObject(this.model)
    const size = new THREE.Vector3()
    box.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    this.model.scale.setScalar(SHIP_SIZE / maxDim)
    const box2 = new THREE.Box3().setFromObject(this.model)
    const center = new THREE.Vector3()
    box2.getCenter(center)
    this.model.position.sub(center)

    this.model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    this.group.add(this.model)

    if (gltf.animations && gltf.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(this.model)
      gltf.animations.forEach((c) => this.mixer!.clipAction(c).play())
    }
    this.loaded = true
    console.log(`[GLM] loaded (wildcard: ${this.modelId})`)
  }

  public update(dt: number): void {
    this.time += dt
    if (this.mixer) this.mixer.update(dt)
    const t = this.time

    // Bounded Lissajous-style wander: two off-ratio sine waves per axis so the
    // ship drifts around the spot without ever tracing the same loop twice.
    const lat = LAT_A1 * Math.sin(LAT_F1 * t) + LAT_A2 * Math.sin(LAT_F2 * t + 1.3)
    const dep = DEP_A1 * Math.sin(DEP_F1 * t + 0.7) + DEP_A2 * Math.sin(DEP_F2 * t + 2.1)
    const bob = BOB_AMP * Math.sin(BOB_F * t) + DRIFT_A * Math.sin(DRIFT_F * t + 0.5)

    this.group.position.copy(this.center)
      .addScaledVector(this.tangent, lat)
      .addScaledVector(this.normal, dep)
    this.group.position.y = BASE_HEIGHT + bob

    // Face the direction it's actually drifting (analytic velocity), so it noses
    // around naturally instead of sliding sideways; holds heading when nearly still.
    const latVel = LAT_A1 * LAT_F1 * Math.cos(LAT_F1 * t) + LAT_A2 * LAT_F2 * Math.cos(LAT_F2 * t + 1.3)
    const depVel = DEP_A1 * DEP_F1 * Math.cos(DEP_F1 * t + 0.7) + DEP_A2 * DEP_F2 * Math.cos(DEP_F2 * t + 2.1)
    const speed = Math.hypot(latVel, depVel)
    if (speed > 0.01) {
      const dir = this.tangent.clone().multiplyScalar(latVel)
        .addScaledVector(this.normal, depVel)
        .normalize()
      const targetYaw = Math.atan2(dir.x, dir.z)
      this.heading = lerpAngle(this.heading, targetYaw, Math.min(1, dt * 2.5))
    }
    this.group.rotation.y = this.heading

    // Gentle bank + pitch so the hover reads as a craft, not a sliding prop.
    if (this.model) {
      this.model.rotation.z = THREE.MathUtils.clamp(-latVel * 0.5, -0.35, 0.35)
      this.model.rotation.x = THREE.MathUtils.clamp(depVel * 0.4, -0.25, 0.25)
    }
  }

  public dispose(): void {
    this.mixer?.stopAllAction()
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
  }
}
