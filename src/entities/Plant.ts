import * as THREE from 'three'
import { COLORS } from '../scene/colors'
import { WILDCARD_ACCENTS } from '../shared/types'
import type { PlantGeometry, ConflictMarker } from '../shared/types'

// The plant — the agent spec made visible — rendered as ONE seamless living
// organism: trunk, branches and foliage are spheres/capsules fused by an SDF
// smooth-min inside a single raymarched billboard quad (same tech-art approach
// as the scanner probes: bounded march, early-exit, gl_FragDepth). Toon-banded,
// ink-edged, swaying with per-branch wind phase. Zero rigs; all motion is
// procedural and every radius/color is driven by the real experiment state.
//
// Extra life: a soft caustic light disc under it that grows with the plant,
// a gold shimmer pulse that travels up the trunk when real code merges, and
// falling leaves when the reviewers prune.

const MAXS = 30
const MAXC = 14

const NORTH_GREEN = new THREE.Color(WILDCARD_ACCENTS.north)
const CODE_GOLD = new THREE.Color(0xffc94a)
const INK = new THREE.Color(0x3a3128)

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
function trunkColor(h: number): THREE.Color {
  const alive = new THREE.Color(0x7a5a3a)
  const dead = new THREE.Color(0x4a3a2e)
  return dead.clone().lerp(alive, THREE.MathUtils.clamp(h, 0, 1))
}

const VERT = /* glsl */ `
out vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const FRAG = /* glsl */ `
precision highp float;
in vec3 vWorldPos;
out vec4 outColor;

uniform vec4  uSph[${MAXS}];
uniform vec3  uSphCol[${MAXS}];
uniform float uSphGlow[${MAXS}];
uniform vec4  uCapA[${MAXC}];
uniform vec4  uCapB[${MAXC}];
uniform vec3  uCapCol[${MAXC}];
uniform float uCapR2[${MAXC}]; // end radius (tapered capsules)
uniform int   uNS;
uniform int   uNC;
uniform float uK;
uniform vec3  uPos;
uniform vec3  uBC;
uniform float uBR;
uniform vec3  uInk;
uniform vec3  uLight;
uniform float uPulseY;   // gold pulse height (world-local y); <0 = off
uniform float uPulseA;   // pulse strength
uniform float uAwake;
uniform float uT;
uniform mat4  uProjView;

float sdSphere(vec3 p, vec3 c, float r) { return length(p - c) - r; }
// tapered capsule (round cone)
float sdCone(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 ba = b - a; vec3 pa = p - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

void sminC(inout float dA, inout vec3 cA, inout float gA, float dB, vec3 cB, float gB, float k) {
  float h = clamp(0.5 + 0.5 * (dA - dB) / k, 0.0, 1.0);
  dA = mix(dA, dB, h) - k * h * (1.0 - h);
  cA = mix(cA, cB, h);
  gA = mix(gA, gB, h);
}

void map(vec3 p, out float d, out vec3 col, out float glow) {
  d = 1e5; col = vec3(1.0); glow = 0.0;
  for (int i = 0; i < ${MAXS}; i++) {
    if (i >= uNS) break;
    float di = sdSphere(p, uSph[i].xyz, uSph[i].w);
    sminC(d, col, glow, di, uSphCol[i], uSphGlow[i], uK);
  }
  for (int i = 0; i < ${MAXC}; i++) {
    if (i >= uNC) break;
    float di = sdCone(p, uCapA[i].xyz, uCapB[i].xyz, uCapA[i].w, uCapR2[i]);
    sminC(d, col, glow, di, uCapCol[i], 0.0, uK);
  }
}
float mapD(vec3 p) { float d; vec3 c; float g; map(p, d, c, g); return d; }

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0025, -0.0025);
  return normalize(
    e.xyy * mapD(p + e.xyy) + e.yyx * mapD(p + e.yyx) +
    e.yxy * mapD(p + e.yxy) + e.xxx * mapD(p + e.xxx));
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - ro);

  vec3 oc = ro - uBC;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - uBR * uBR;
  float disc = b * b - c;
  if (disc < 0.0) discard;
  float sq = sqrt(disc);
  float t = max(-b - sq, 0.02);
  float tEnd = -b + sq;

  float d; vec3 col; float glow;
  vec3 pw = vec3(0.0);
  bool hit = false;
  for (int i = 0; i < 64; i++) {
    pw = ro + rd * t;
    map(pw - uPos, d, col, glow);
    if (d < 0.0016 * t) { hit = true; break; }
    t += d * 0.94;
    if (t > tEnd) break;
  }
  if (!hit) discard;

  vec3 pl = pw - uPos;
  vec3 n = calcNormal(pl);

  float lum = dot(n, uLight) * 0.5 + 0.5;
  float s1 = smoothstep(0.34, 0.38, lum);
  float s2 = smoothstep(0.62, 0.66, lum);
  vec3 shade = col * (0.62 + 0.28 * s1 + 0.18 * s2);
  shade = mix(shade * vec3(0.95, 0.97, 1.04), shade, s1);
  shade = mix(shade, shade * vec3(1.06, 1.02, 0.9), s2 * 0.5);

  // soft occlusion toward the soil
  shade *= 0.8 + 0.2 * smoothstep(0.0, 0.35, pl.y);

  float ndv = max(dot(n, -rd), 0.0);
  shade = mix(shade, uInk, smoothstep(0.24, 0.11, ndv) * 0.8);

  // per-leaf glow accents (north green / merge gold)
  shade = mix(shade, col * 1.6, clamp(glow, 0.0, 1.0) * (0.8 + 0.2 * sin(uT * 2.2)));

  // gold shimmer pulse traveling up the trunk on a real merge
  if (uPulseA > 0.001) {
    float band = exp(-pow((pl.y - uPulseY) * 9.0, 2.0));
    shade += vec3(1.0, 0.8, 0.35) * band * uPulseA;
  }

  // awakened: gentle whole-plant breathing light
  shade += vec3(0.5, 0.9, 0.6) * uAwake * (0.05 + 0.04 * sin(uT * 1.4));

  outColor = vec4(shade, 1.0);
  vec4 clip = uProjView * vec4(pw, 1.0);
  gl_FragDepth = (clip.z / clip.w + 1.0) * 0.5;
}
`

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

  private material: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private proxies: THREE.Group           // named 'branches' — terrarium shatter physics reads this
  private proxyMat: THREE.MeshBasicMaterial
  private caustic: THREE.Mesh
  private causticMat: THREE.ShaderMaterial
  private branches: BranchDef[] = []
  private trunkH = 0.5
  private trunkR = 0.05
  private trunkHealth = 0.8

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

    const uni: Record<string, THREE.IUniform> = {
      uSph: { value: Array.from({ length: MAXS }, () => new THREE.Vector4()) },
      uSphCol: { value: Array.from({ length: MAXS }, () => new THREE.Color()) },
      uSphGlow: { value: new Array(MAXS).fill(0) },
      uCapA: { value: Array.from({ length: MAXC }, () => new THREE.Vector4()) },
      uCapB: { value: Array.from({ length: MAXC }, () => new THREE.Vector4()) },
      uCapCol: { value: Array.from({ length: MAXC }, () => new THREE.Color()) },
      uCapR2: { value: new Array(MAXC).fill(0.02) },
      uNS: { value: 0 }, uNC: { value: 0 },
      uK: { value: 0.035 },
      uPos: { value: new THREE.Vector3() },
      uBC: { value: new THREE.Vector3() },
      uBR: { value: 1 },
      uInk: { value: INK },
      uLight: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uPulseY: { value: -1 }, uPulseA: { value: 0 },
      uAwake: { value: 0 },
      uT: { value: 0 },
      uProjView: { value: new THREE.Matrix4() },
    }
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: uni,
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material)
    this.quad.frustumCulled = false
    this.group.add(this.quad)

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
    this.trunkR = g ? Math.max(g.trunkRadius, 0.028) : 0.03 + s.stabilityScore * 0.04
    this.trunkHealth = g ? g.trunkHealth : s.healthScore

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
  // per-frame uniforms (wind, breathing, clusters)
  // ---------------------------------------------------------------------------
  private pushUniforms(): void {
    const u = this.material.uniforms
    const s = this.state
    const t = this.time
    let si = 0, ci = 0
    const sph = (x: number, y: number, z: number, r: number, col: THREE.Color, glow = 0) => {
      if (si >= MAXS) return
      ;(u.uSph.value as THREE.Vector4[])[si].set(x, y, z, r)
      ;(u.uSphCol.value as THREE.Color[])[si].copy(col)
      ;(u.uSphGlow.value as number[])[si] = glow
      si++
    }
    const cone = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number, col: THREE.Color) => {
      if (ci >= MAXC) return
      ;(u.uCapA.value as THREE.Vector4[])[ci].set(ax, ay, az, ra)
      ;(u.uCapB.value as THREE.Vector4[])[ci].set(bx, by, bz, 0)
      ;(u.uCapR2.value as number[])[ci] = rb
      ;(u.uCapCol.value as THREE.Color[])[ci].copy(col)
      ci++
    }

    const H = this.trunkH
    const R = this.trunkR
    const tCol = trunkColor(this.trunkHealth)
    const sway = Math.sin(t * 0.8) * 0.015 * (1 + s.growthStage)

    // trunk: two tapered segments with a gentle S-bend
    const bend = (1 - s.stabilityScore) * 0.03
    cone(0, -0.02, 0, bend, H * 0.5, bend * 0.5, R * 1.5, R * 0.95, tCol)
    cone(bend, H * 0.5, bend * 0.5, sway, H, -bend * 0.4, R * 0.95, R * 0.55, tCol)

    // roots (constraints) — small dark tendrils at the base
    const roots = Math.min(s.constraints, 4)
    for (let i = 0; i < roots; i++) {
      const a = (i / Math.max(roots, 1)) * Math.PI * 2 + 0.7
      cone(0, 0.02, 0, Math.cos(a) * 0.12, -0.01, Math.sin(a) * 0.12, R * 0.5, R * 0.22, trunkColor(this.trunkHealth * 0.7))
    }

    // crown blob at the trunk top — the plant's heart
    const breathe = 1 + 0.025 * Math.sin(t * 1.6)
    const crownR = (0.042 + s.growthStage * 0.055 + Math.min(s.behaviors, 8) * 0.004) * breathe
    const crownCol = healthColor(s.healthScore)
    sph(sway, H + crownR * 0.5, 0, crownR, crownCol)

    // branches with foliage
    for (const b of this.branches) {
      const ay = b.height * H
      const wind = t * 1.2 + b.phase
      const tip = this.branchTip(b, wind)
      const bCol = trunkColor(b.health)
      if (b.isStump) {
        cone(0, ay, 0, tip.x, ay + tip.y, tip.z, R * 0.5, R * 0.3, trunkColor(0.25))
        continue
      }
      cone(0, ay, 0, tip.x, ay + tip.y, tip.z, R * 0.55, R * 0.28, bCol)
      if (b.leafCount > 0) {
        const lr = (0.032 + Math.min(b.leafCount, 5) * 0.007) * (0.75 + s.growthStage * 0.35)
        const bob = Math.sin(wind * 1.4) * 0.012
        const lCol = healthColor(b.leafHealth)
        sph(tip.x, ay + tip.y + lr * 0.5 + bob, tip.z, lr, lCol)
        if (b.leafCount > 2) {
          sph(tip.x * 1.18, ay + tip.y + lr * 0.9 - bob, tip.z * 1.18, lr * 0.58, lCol.clone().multiplyScalar(0.94))
        }
      }
    }

    // Accent berries perched ON the crown surface so they read at a glance:
    // North's teal-green cluster on one side, merge-gold on the other.
    const crownY = H + crownR * 0.5
    const nGlow = 0.45 + 0.15 * Math.sin(t * 2.6)
    const berry = (count: number, sideAngle: number, col: THREE.Color) => {
      for (let i = 0; i < Math.min(count, 6); i++) {
        const a = sideAngle + (i - Math.min(count, 6) / 2) * 0.55
        const tilt = 0.3 + (i % 3) * 0.35 // spread up the crown's flank
        const rr = 0.02 + (i % 3) * 0.004
        const rad = crownR * 0.92 + rr * 0.5
        sph(
          sway + Math.cos(a) * rad * Math.cos(tilt),
          crownY + rad * Math.sin(tilt) + Math.sin(t * 1.6 + i) * 0.006,
          Math.sin(a) * rad * Math.cos(tilt),
          rr, col, nGlow
        )
      }
    }
    berry(s.northLeaves ?? 0, 2.4, NORTH_GREEN)
    berry(s.codePrLeaves ?? 0, -0.7, CODE_GOLD)

    // conflict stress spots — dull dark blemishes on the crown
    const conf = Math.min(s.conflicts, 3)
    for (let i = 0; i < conf; i++) {
      const a = 1.1 + i * 2.0
      sph(Math.cos(a) * crownR * 0.8 + sway, H + crownR * 0.5 + Math.sin(a * 2) * crownR * 0.4, Math.sin(a) * crownR * 0.8, crownR * 0.24, new THREE.Color(0x5a4632))
    }

    u.uNS.value = si; u.uNC.value = ci
    u.uT.value = t

    // world placement + bounds
    const world = new THREE.Vector3()
    this.group.getWorldPosition(world)
    ;(u.uPos.value as THREE.Vector3).copy(world)
    const top = H + crownR * 2 + 0.15
    const spread = Math.max(0.45, ...this.branches.map(b => b.length + 0.2))
    const bR = Math.max(top * 0.6, spread) * 1.25
    ;(u.uBC.value as THREE.Vector3).set(world.x, world.y + top * 0.5, world.z)
    u.uBR.value = bR

    this.quad.position.set(0, top * 0.5, 0)
    this.quad.scale.setScalar(bR * 2.3)
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
    this.material.uniforms.uAwake.value = awake ? 1 : 0
  }
  public getIsAwake(): boolean { return !!this.state.isAwake }
  public getAgentName(): string | undefined { return this.state.agentName }

  public setProjView(projView: THREE.Matrix4): void {
    (this.material.uniforms.uProjView.value as THREE.Matrix4).copy(projView)
  }

  public update(deltaTime: number, camera?: THREE.Camera): void {
    const dt = Math.min(deltaTime, 0.05)
    this.time += dt

    // billboard the raymarch quad — orbiting past the plane's edge would
    // otherwise leave the shader zero pixels to draw into
    if (camera) this.quad.quaternion.copy(camera.quaternion)

    // gold pulse travels base → crown, then fades
    const u = this.material.uniforms
    if (this.pulseT >= 0) {
      this.pulseT += dt * 1.1
      if (this.pulseT >= 1.3) {
        this.pulseT = -1
        u.uPulseA.value = 0
      } else {
        u.uPulseY.value = this.pulseT * (this.trunkH + 0.25)
        u.uPulseA.value = 0.55 * (1 - Math.max(this.pulseT - 0.85, 0) / 0.45)
      }
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

    this.pushUniforms()
  }

  public dispose(): void {
    this.quad.geometry.dispose()
    this.material.dispose()
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
