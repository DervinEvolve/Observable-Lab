import * as THREE from 'three'

// ScannerDrone — ambient lab robotics (NOT a subagent). A small maintenance
// probe that patrols the terrarium, sweeps a scan beam across the plant while
// the lab works, and perches on the brass rim between shifts.
//
// Tech-art: the body is a single seamless form — spheres/ellipsoids/capsules
// fused by an SDF smooth-min inside one raymarched billboard quad (bounded
// march, early-exit, gl_FragDepth so it composites with the room). Toon-banded
// in the lab's own palette (porcelain, brass, warm ink, amber lens). Zero rigs:
// all motion is procedural (hover bob, banking, rotor blur, scan sweeps).

const MAXS = 14
const MAXC = 6

// Lab palette
const PORCELAIN = new THREE.Color(0xece7db)
const BRASS = new THREE.Color(0xb5a642)
const INK = new THREE.Color(0x3a3128)
const AMBER = new THREE.Color(0xffb454)

// Terrarium geometry (matches GlassTerrarium constants)
const DOME_R = 1.0
const DOME_BASE_Y = 0.3

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

uniform vec4  uSph[${MAXS}];      // xyz local, w radius
uniform vec3  uSphScale[${MAXS}]; // ellipsoid scale
uniform vec3  uSphCol[${MAXS}];
uniform float uSphGlow[${MAXS}];
uniform vec4  uCapA[${MAXC}];
uniform vec4  uCapB[${MAXC}];
uniform vec3  uCapCol[${MAXC}];
uniform int   uNS;
uniform int   uNC;
uniform float uK;
uniform vec3  uPos;
uniform vec2  uYaw;   // (sin, cos)
uniform vec2  uRoll;  // (sin, cos)
uniform float uPop;
uniform vec3  uBC;
uniform float uBR;
uniform vec3  uInk;
uniform vec3  uLight;
uniform mat4  uProjView;

vec3 toLocal(vec3 wp) {
  vec3 p = wp - uPos;
  p = vec3(uYaw.y * p.x - uYaw.x * p.z, p.y, uYaw.x * p.x + uYaw.y * p.z);   // yaw⁻¹
  p = vec3(uRoll.y * p.x + uRoll.x * p.y, -uRoll.x * p.x + uRoll.y * p.y, p.z); // roll⁻¹
  return p / max(uPop, 0.001);
}

float sdEllip(vec3 p, vec3 c, float r, vec3 s) {
  vec3 q = (p - c) / s;
  return (length(q) - r) * min(s.x, min(s.y, s.z));
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// smooth-min blending color + glow
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
    float di = sdEllip(p, uSph[i].xyz, uSph[i].w, uSphScale[i]);
    sminC(d, col, glow, di, uSphCol[i], uSphGlow[i], uK);
  }
  for (int i = 0; i < ${MAXC}; i++) {
    if (i >= uNC) break;
    float di = sdCapsule(p, uCapA[i].xyz, uCapB[i].xyz, uCapA[i].w);
    sminC(d, col, glow, di, uCapCol[i], 0.0, uK);
  }
}

float mapD(vec3 p) { float d; vec3 c; float g; map(p, d, c, g); return d; }

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.002, -0.002);
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

  float ds = max(uPop, 0.001);
  vec3 col; float glow; float d;
  vec3 pw = vec3(0.0);
  bool hit = false;
  for (int i = 0; i < 56; i++) {
    pw = ro + rd * t;
    map(toLocal(pw), d, col, glow);
    d *= ds;
    if (d < 0.0015 * t) { hit = true; break; }
    t += d * 0.95;
    if (t > tEnd) break;
  }
  if (!hit) discard;

  vec3 nl = calcNormal(toLocal(pw));
  // rotate normal to world (roll then yaw)
  vec3 n = vec3(uRoll.y * nl.x - uRoll.x * nl.y, uRoll.x * nl.x + uRoll.y * nl.y, nl.z);
  n = vec3(uYaw.y * n.x + uYaw.x * n.z, n.y, -uYaw.x * n.x + uYaw.y * n.z);

  float lum = dot(n, uLight) * 0.5 + 0.5;
  float s1 = smoothstep(0.34, 0.38, lum);
  float s2 = smoothstep(0.63, 0.67, lum);
  vec3 shade = col * (0.58 + 0.28 * s1 + 0.2 * s2);
  shade = mix(shade * vec3(1.02, 0.94, 0.85), shade, s1); // warm lab shadows
  shade = mix(shade, shade * vec3(1.06, 1.0, 0.9), s2 * 0.55);

  float ndv = max(dot(n, -rd), 0.0);
  shade = mix(shade, uInk, smoothstep(0.24, 0.11, ndv) * 0.85); // ink edge
  shade = mix(shade, col * 1.75, clamp(glow, 0.0, 1.0));        // emissive lens

  outColor = vec4(shade, 1.0);
  vec4 clip = uProjView * vec4(pw, 1.0);
  gl_FragDepth = (clip.z / clip.w + 1.0) * 0.5;
}
`

type Mode = 'patrol' | 'scan' | 'perch'

export class ScannerDrone {
  public group: THREE.Group

  private material: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private discs: THREE.Mesh[] = []
  private discMats: THREE.ShaderMaterial[] = []
  private beam: THREE.Mesh
  private beamMat: THREE.ShaderMaterial
  private dot: THREE.Sprite

  private time: number
  private mode: Mode = 'patrol'
  private modeT = 0
  private modeDur = 6
  private busy = false

  // flight
  private angle: number
  private angVel: number
  private radius = 1.8
  private height = 1.35
  private pos = new THREE.Vector3()
  private vel = new THREE.Vector3()
  private yaw = 0
  private roll = 0
  private targetPos = new THREE.Vector3()
  private perchAngle: number
  private rotorSpin = 1 // 0..1 rotor intensity
  private lensGlow = 0.8

  constructor(seedAngle: number, spinSign: 1 | -1) {
    this.group = new THREE.Group()
    this.group.name = 'scanner_drone'
    this.time = Math.random() * 100
    this.angle = seedAngle
    this.angVel = 0.38 * spinSign
    this.perchAngle = seedAngle + Math.PI * 0.35

    // ---- SDF body ----
    const uni: Record<string, THREE.IUniform> = {
      uSph: { value: Array.from({ length: MAXS }, () => new THREE.Vector4()) },
      uSphScale: { value: Array.from({ length: MAXS }, () => new THREE.Vector3(1, 1, 1)) },
      uSphCol: { value: Array.from({ length: MAXS }, () => new THREE.Color()) },
      uSphGlow: { value: new Array(MAXS).fill(0) },
      uCapA: { value: Array.from({ length: MAXC }, () => new THREE.Vector4()) },
      uCapB: { value: Array.from({ length: MAXC }, () => new THREE.Vector4()) },
      uCapCol: { value: Array.from({ length: MAXC }, () => new THREE.Color()) },
      uNS: { value: 0 }, uNC: { value: 0 },
      uK: { value: 0.045 },
      uPos: { value: new THREE.Vector3() },
      uYaw: { value: new THREE.Vector2(0, 1) },
      uRoll: { value: new THREE.Vector2(0, 1) },
      uPop: { value: 0 },
      uBC: { value: new THREE.Vector3() },
      uBR: { value: 0.5 },
      uInk: { value: INK },
      uLight: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uProjView: { value: new THREE.Matrix4() },
    }
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT, fragmentShader: FRAG, uniforms: uni,
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material)
    this.quad.frustumCulled = false
    this.group.add(this.quad)

    // ---- rotor blur discs (regular transparent meshes; composite via fragDepth) ----
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uT: { value: 0 }, uA: { value: 0.4 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv*2.-1.; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `
          varying vec2 vUv; uniform float uT; uniform float uA;
          void main(){
            float r = length(vUv);
            if (r > 1.0) discard;
            float ang = atan(vUv.y, vUv.x);
            float streak = 0.55 + 0.45 * sin(ang * 3.0 + uT * 42.0);
            float band = smoothstep(0.25, 0.5, r) * (1.0 - smoothstep(0.82, 1.0, r));
            gl_FragColor = vec4(vec3(0.32, 0.28, 0.24), streak * band * uA);
          }`,
      })
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.085, 20), mat)
      disc.rotation.x = -Math.PI / 2
      this.discs.push(disc); this.discMats.push(mat)
      this.group.add(disc)
    }

    // ---- scan beam (thin additive cone) + surface dot ----
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      side: THREE.DoubleSide, // normal alpha blending — additive vanished against the bright walls
      uniforms: { uT: { value: 0 }, uA: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        varying vec2 vUv; uniform float uT; uniform float uA;
        void main(){
          float along = vUv.y;                       // 0 lens → 1 target
          float flicker = 0.85 + 0.15 * sin(uT * 30.0 + along * 12.0);
          float a = (1.0 - along * 0.45) * flicker * uA;
          gl_FragColor = vec4(vec3(1.0, 0.62, 0.22), a * 0.5);
        }`,
    })
    // unit cone: tip at origin pointing +Y, we scale/orient per frame
    const cone = new THREE.CylinderGeometry(0.07, 0.008, 1, 10, 1, true)
    cone.translate(0, 0.5, 0)
    this.beam = new THREE.Mesh(cone, this.beamMat)
    this.beam.visible = false
    this.group.add(this.beam)

    // scan dot sprite
    const cnv = document.createElement('canvas')
    cnv.width = cnv.height = 64
    const ctx = cnv.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
    g.addColorStop(0, 'rgba(255,220,150,1)')
    g.addColorStop(0.4, 'rgba(255,170,70,0.7)')
    g.addColorStop(1, 'rgba(255,150,50,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64)
    this.dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cnv), transparent: true, depthWrite: false,
    }))
    this.dot.scale.setScalar(0.16)
    this.dot.visible = false
    this.group.add(this.dot)

    // start on patrol at seed position
    this.pos.set(Math.cos(this.angle) * this.radius, this.height, Math.sin(this.angle) * this.radius)
  }

  // Lab activity hook: during a live epoch the probes scan more eagerly.
  public setBusy(b: boolean): void { this.busy = b }

  private pickNextMode(): void {
    this.modeT = 0
    if (this.mode === 'patrol') {
      const scanChance = this.busy ? 0.75 : 0.45
      if (Math.random() < scanChance) { this.mode = 'scan'; this.modeDur = 6 + Math.random() * 5 }
      else { this.mode = 'perch'; this.modeDur = 8 + Math.random() * 7 }
    } else {
      this.mode = 'patrol'
      this.modeDur = 7 + Math.random() * 8
      this.angVel = (0.3 + Math.random() * 0.25) * (Math.random() < 0.5 ? 1 : -1)
      this.radius = 1.6 + Math.random() * 0.7
      this.height = 1.15 + Math.random() * 0.75
      if (this.mode === 'patrol') this.perchAngle = Math.random() * Math.PI * 2
    }
  }

  public update(dt: number, camera: THREE.Camera, plantHeight = 0.9): void {
    // Clamp dt: after a tab-throttle/backgrounded stretch, one giant dt would
    // teleport the integrator (confirmed live — drones ended up 30 units out).
    dt = Math.min(dt, 0.05)
    this.time += dt
    const t = this.time

    // Safety net: if anything ever blows up, respawn on the patrol ring.
    if (!Number.isFinite(this.pos.x) || this.pos.length() > 10) {
      this.pos.set(Math.cos(this.angle) * this.radius, this.height, Math.sin(this.angle) * this.radius)
      this.vel.set(0, 0, 0)
    }
    const u = this.material.uniforms

    // spawn pop
    if ((u.uPop.value as number) < 1) u.uPop.value = Math.min(1, (u.uPop.value as number) + dt * 1.4)
    const pop = u.uPop.value as number

    // ---- mode state machine ----
    this.modeT += dt
    if (this.modeT > this.modeDur) this.pickNextMode()

    let desired = this.targetPos
    let rotorTarget = 1
    let beamOn = false

    if (this.mode === 'patrol') {
      this.angle += this.angVel * dt
      const wob = Math.sin(t * 0.7) * 0.25
      desired = this.targetPos.set(
        Math.cos(this.angle) * (this.radius + wob * 0.3),
        this.height + Math.sin(t * 1.1) * 0.12,
        Math.sin(this.angle) * (this.radius + wob * 0.3)
      )
    } else if (this.mode === 'scan') {
      // hold a standoff point facing the plant, sweep the beam
      desired = this.targetPos.set(
        Math.cos(this.angle) * 1.45,
        1.05 + Math.sin(t * 0.5) * 0.1,
        Math.sin(this.angle) * 1.45
      )
      beamOn = this.modeT > 0.8 // settle first
      rotorTarget = 0.75
    } else { // perch on the brass rim
      const px = Math.cos(this.perchAngle) * DOME_R
      const pz = Math.sin(this.perchAngle) * DOME_R
      const settleY = DOME_BASE_Y + 0.065 // smaller body sits lower on the rim
      // approach: fly above the point, then descend
      const above = this.modeT < 1.6
      desired = this.targetPos.set(px, above ? settleY + 0.5 : settleY, pz)
      const settled = this.pos.distanceTo(desired) < 0.06 && !above
      rotorTarget = settled ? 0.06 : 0.9
    }

    // steer
    const steer = desired.clone().sub(this.pos)
    const maxV = this.mode === 'perch' && this.modeT >= 1.6 ? 0.55 : 1.1
    this.vel.lerp(steer.multiplyScalar(2.2), Math.min(1, dt * 3))
    if (this.vel.length() > maxV) this.vel.setLength(maxV)
    this.pos.addScaledVector(this.vel, dt)

    // Glass keep-out: never cut through the dome. Perching may touch the rim
    // (r≈1.0); everything else stays clear of the glass while below its apex.
    const rr = Math.hypot(this.pos.x, this.pos.z)
    const minR = this.mode === 'perch' ? 0.98 : 1.32
    if (this.pos.y < 1.55 && rr < minR && rr > 1e-4) {
      const k = minR / rr
      this.pos.x *= k; this.pos.z *= k
    }

    // yaw: face travel while patrolling, face the plant while scanning/perched
    let targetYaw: number
    if (this.mode === 'patrol' && this.vel.lengthSq() > 0.005) {
      targetYaw = Math.atan2(this.vel.x, this.vel.z)
    } else {
      targetYaw = Math.atan2(-this.pos.x, -this.pos.z) // toward center
    }
    let dy = targetYaw - this.yaw
    while (dy > Math.PI) dy -= Math.PI * 2
    while (dy < -Math.PI) dy += Math.PI * 2
    this.yaw += dy * Math.min(1, dt * 4)

    // bank into lateral velocity
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const latV = this.vel.dot(right)
    this.roll += ((-latV * 0.5) - this.roll) * Math.min(1, dt * 5)

    // rotors ease
    this.rotorSpin += (rotorTarget - this.rotorSpin) * Math.min(1, dt * 3)
    // lens: brighter while scanning, dim while perched
    const glowTarget = beamOn ? 1.0 : this.mode === 'perch' ? 0.25 : 0.7
    this.lensGlow += (glowTarget - this.lensGlow) * Math.min(1, dt * 4)

    this.group.position.copy(this.pos)

    // ---- build body primitives (local, +Z forward) ----
    const S = 0.5 // global body scale — probes read as small instruments, not aircraft
    let si = 0, ci = 0
    const sph = (x: number, y: number, z: number, r: number, col: THREE.Color, glow = 0, sx = 1, sy = 1, sz = 1) => {
      if (si >= MAXS) return
      ;(u.uSph.value as THREE.Vector4[])[si].set(x * S, y * S, z * S, r * S)
      ;(u.uSphScale.value as THREE.Vector3[])[si].set(sx, sy, sz)
      ;(u.uSphCol.value as THREE.Color[])[si].copy(col)
      ;(u.uSphGlow.value as number[])[si] = glow
      si++
    }
    const cap = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, col: THREE.Color) => {
      if (ci >= MAXC) return
      ;(u.uCapA.value as THREE.Vector4[])[ci].set(ax * S, ay * S, az * S, r * S)
      ;(u.uCapB.value as THREE.Vector4[])[ci].set(bx * S, by * S, bz * S, 0)
      ;(u.uCapCol.value as THREE.Color[])[ci].copy(col)
      ci++
    }

    const breathe = 1 + Math.sin(t * 2.3) * 0.015
    // chassis + brass belly pan
    sph(0, 0, 0, 0.125 * breathe, PORCELAIN, 0, 1, 0.62, 1.18)
    sph(0, -0.055, 0.01, 0.095, BRASS, 0, 1, 0.5, 1.05)
    // lens housing + glowing amber lens
    sph(0, -0.005, 0.135, 0.052, INK)
    const lensPulse = this.lensGlow * (0.85 + 0.15 * Math.sin(t * (beamOn ? 9 : 3)))
    sph(0, -0.005, 0.163, 0.033, AMBER, lensPulse)
    // rotor arms + pods
    cap(-0.07, 0.02, 0, -0.185, 0.045, 0, 0.013, INK)
    cap(0.07, 0.02, 0, 0.185, 0.045, 0, 0.013, INK)
    sph(-0.185, 0.05, 0, 0.036, BRASS)
    sph(0.185, 0.05, 0, 0.036, BRASS)
    // tail fin + antenna with blinking light
    sph(0, 0.045, -0.115, 0.045, PORCELAIN, 0, 0.55, 1, 1.15)
    cap(0, 0.075, -0.07, 0, 0.155, -0.095, 0.006, INK)
    const blink = (Math.sin(t * 2.6) > 0.88 ? 1 : 0.25) * 0.9
    sph(0, 0.165, -0.098, 0.014, AMBER, blink)
    // landing nubs
    sph(-0.05, -0.105, 0.015, 0.02, INK)
    sph(0.05, -0.105, 0.015, 0.02, INK)

    u.uNS.value = si; u.uNC.value = ci
    u.uPos.value.copy(this.pos)
    ;(u.uYaw.value as THREE.Vector2).set(Math.sin(this.yaw), Math.cos(this.yaw))
    ;(u.uRoll.value as THREE.Vector2).set(Math.sin(this.roll), Math.cos(this.roll))

    const bR = 0.18 * Math.max(pop, 0.05)
    ;(u.uBC.value as THREE.Vector3).copy(this.pos)
    u.uBR.value = bR

    // billboard (group has no rotation, so world-align directly)
    this.quad.position.set(0, 0, 0)
    this.quad.quaternion.copy((camera as THREE.PerspectiveCamera).quaternion)
    this.quad.scale.setScalar(bR * 2.25)

    // rotor discs follow pods (local offsets rotated by yaw/roll ≈ yaw only, small roll)
    const podL = new THREE.Vector3(-0.185 * S, 0.085 * S, 0)
    const podR = new THREE.Vector3(0.185 * S, 0.085 * S, 0)
    for (const [disc, off] of [[this.discs[0], podL], [this.discs[1], podR]] as Array<[THREE.Mesh, THREE.Vector3]>) {
      const o = off.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), this.roll).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw)
      disc.position.copy(o)
      disc.rotation.z = this.roll
      disc.scale.setScalar(pop * (S / 0.95)) // disc geometry was authored at S=0.95
    }
    for (const m of this.discMats) {
      m.uniforms.uT.value = t * (0.4 + this.rotorSpin)
      m.uniforms.uA.value = 0.38 * this.rotorSpin * pop
    }

    // ---- scan beam + dot ----
    if (beamOn) {
      const sweep = (Math.sin(t * 0.9) * 0.5 + 0.5)
      const targetY = 0.35 + sweep * Math.max(plantHeight, 0.5)
      // point on plant axis, nudged toward the drone so the dot sits on foliage
      const toDrone = this.pos.clone().setY(0).normalize()
      const target = new THREE.Vector3(0, targetY, 0).addScaledVector(toDrone, 0.22)
      const lensWorld = new THREE.Vector3(0, -0.005 * S, 0.163 * S)
        .applyAxisAngle(new THREE.Vector3(0, 0, 1), this.roll)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw)
        .add(this.pos)

      const dir = target.clone().sub(lensWorld)
      const len = dir.length()
      this.beam.visible = true
      this.beam.position.copy(lensWorld).sub(this.pos)
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
      this.beam.scale.set(0.6, len, 0.6)
      this.beamMat.uniforms.uT.value = t
      this.beamMat.uniforms.uA.value = Math.min(this.beamMat.uniforms.uA.value + dt * 2, 0.95)

      this.dot.visible = true
      this.dot.position.copy(target).sub(this.pos)
      this.dot.scale.setScalar(0.09 + 0.035 * Math.sin(t * 7))
    } else {
      this.beamMat.uniforms.uA.value = Math.max(this.beamMat.uniforms.uA.value - dt * 3, 0)
      if (this.beamMat.uniforms.uA.value <= 0.01) { this.beam.visible = false; this.dot.visible = false }
    }
  }

  public setProjView(projView: THREE.Matrix4): void {
    (this.material.uniforms.uProjView.value as THREE.Matrix4).copy(projView)
  }

  public dispose(): void {
    this.quad.geometry.dispose(); this.material.dispose()
    for (const d of this.discs) (d.geometry as THREE.BufferGeometry).dispose()
    for (const m of this.discMats) m.dispose()
    this.beam.geometry.dispose(); this.beamMat.dispose()
    ;(this.dot.material as THREE.SpriteMaterial).map?.dispose()
    ;(this.dot.material as THREE.SpriteMaterial).dispose()
  }
}
