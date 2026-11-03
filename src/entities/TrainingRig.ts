import * as THREE from 'three'
import { COLORS } from '../scene/colors'

// The lab's compute corner comes alive while a REAL GPU training run is in
// flight: the rack's status lamps go frantic, a cooling fan blurs, amber data
// pulses travel the cable run from the rack to the terrarium (the model under
// training IS the plant), and a brass gauge tracks best val_bpb — the number
// this whole lab exists to push down.
//
// Idle state is quiet-science calm: lamps breathe slow green, fan barely
// turns, no pulses, needle at rest.

const AMBER = new THREE.Color(0xffb454)
const IDLE_GREEN = new THREE.Color(0x7cb342)

export class TrainingRig {
  public group: THREE.Group

  private lamps: THREE.Mesh[] = []
  private lampMats: THREE.MeshBasicMaterial[] = []
  private fan: THREE.Mesh
  private fanMat: THREE.ShaderMaterial
  private pulses: THREE.Points
  private pulseT: Float32Array
  private curve: THREE.QuadraticBezierCurve3
  private gaugeCanvas: HTMLCanvasElement
  private gaugeTexture: THREE.CanvasTexture
  private active = false
  private activeAmount = 0 // eased 0..1
  private bestBpb: number | null = null
  private baselineBpb: number | null = null
  private time = 0
  private fanAngle = 0
  private lastGaugeDraw = -1

  constructor(rackAngleDeg = -54, rackRadius = 6.9) {
    this.group = new THREE.Group()
    this.group.name = 'training_rig'

    const a = (rackAngleDeg * Math.PI) / 180
    const rackPos = new THREE.Vector3(Math.cos(a) * rackRadius, 0, Math.sin(a) * rackRadius)
    // inward-facing direction (toward room center)
    const inward = rackPos.clone().multiplyScalar(-1).setY(0).normalize()

    // --- status lamp stack on the rack's inner face ---
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: IDLE_GREEN.clone(), transparent: true, opacity: 0.65 })
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), mat)
      lamp.position.copy(rackPos)
        .addScaledVector(inward, 0.33)
        .add(new THREE.Vector3(0, 1.28 + i * 0.12, 0))
      // offset sideways along the rack face
      const side = new THREE.Vector3(-inward.z, 0, inward.x)
      lamp.position.addScaledVector(side, 0.18)
      this.group.add(lamp)
      this.lamps.push(lamp)
      this.lampMats.push(mat)
    }

    // --- cooling fan: rotating streak disc (same trick as drone rotors) ---
    this.fanMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 }, uA: { value: 0.12 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uT; uniform float uA;
        void main(){
          float r = length(vUv);
          if (r > 1.0) discard;
          float ang = atan(vUv.y, vUv.x);
          float streak = 0.5 + 0.5 * sin(ang * 5.0 + uT);
          float band = smoothstep(0.2, 0.45, r) * (1.0 - smoothstep(0.85, 1.0, r));
          gl_FragColor = vec4(vec3(0.75, 0.78, 0.8), streak * band * uA);
        }`,
    })
    this.fan = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24), this.fanMat)
    this.fan.position.copy(rackPos).addScaledVector(inward, 0.33).add(new THREE.Vector3(0, 0.62, 0))
    const side = new THREE.Vector3(-inward.z, 0, inward.x)
    this.fan.position.addScaledVector(side, -0.12)
    this.fan.lookAt(this.fan.position.clone().add(inward))
    this.group.add(this.fan)

    // --- data pulses: rack → terrarium along a sagging cable arc ---
    this.curve = new THREE.QuadraticBezierCurve3(
      rackPos.clone().add(new THREE.Vector3(0, 0.15, 0)).addScaledVector(inward, 0.4),
      rackPos.clone().multiplyScalar(0.45).setY(0.02), // sag to the floor midway
      new THREE.Vector3(0, 0.35, 0).addScaledVector(rackPos.clone().normalize(), 1.15)
    )
    const N = 10
    this.pulseT = new Float32Array(N)
    for (let i = 0; i < N; i++) this.pulseT[i] = i / N
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    this.pulses = new THREE.Points(geo, new THREE.PointsMaterial({
      color: AMBER, size: 0.035, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }))
    this.pulses.frustumCulled = false
    this.group.add(this.pulses)

    // --- brass gauge on the wall above the rack ---
    this.gaugeCanvas = document.createElement('canvas')
    this.gaugeCanvas.width = 256
    this.gaugeCanvas.height = 256
    this.gaugeTexture = new THREE.CanvasTexture(this.gaugeCanvas)
    const gaugeFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 32),
      new THREE.MeshStandardMaterial({ map: this.gaugeTexture, roughness: 0.35 })
    )
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.018, 8, 32),
      new THREE.MeshStandardMaterial({ color: COLORS.structure.brass, roughness: 0.4, metalness: 0.7 })
    )
    const wallPos = rackPos.clone().normalize().multiplyScalar(7.82)
    wallPos.y = 2.15
    for (const m of [gaugeFace, rim]) {
      m.position.copy(wallPos)
      m.lookAt(new THREE.Vector3(0, 2.15, 0))
      this.group.add(m)
    }
    this.drawGauge(0)
  }

  private drawGauge(needle01: number): void {
    const ctx = this.gaugeCanvas.getContext('2d')!
    const c = 128
    ctx.fillStyle = '#efe9db'
    ctx.fillRect(0, 0, 256, 256)
    // arc ticks
    ctx.strokeStyle = '#5a5044'
    ctx.lineWidth = 3
    for (let i = 0; i <= 10; i++) {
      const ang = Math.PI * (1 + i / 10) // lower half-arc, left to right
      const r1 = 92, r2 = i % 5 === 0 ? 78 : 84
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(ang) * r1, c - Math.sin(ang) * r1 + 40)
      ctx.lineTo(c + Math.cos(ang) * r2, c - Math.sin(ang) * r2 + 40)
      ctx.stroke()
    }
    ctx.fillStyle = '#3a3128'
    ctx.font = '600 20px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.fillText('TRAINING', c, 190)
    ctx.font = '600 26px "Courier New", monospace'
    ctx.fillStyle = this.bestBpb !== null && this.baselineBpb !== null && this.bestBpb < this.baselineBpb ? '#4a7a34' : '#3a3128'
    ctx.fillText(this.bestBpb !== null ? this.bestBpb.toFixed(4) : '—', c, 224)
    ctx.font = '500 13px Georgia, serif'
    ctx.fillStyle = '#8a8072'
    ctx.fillText('best val_bpb', c, 242)
    // needle
    const ang = Math.PI * (1 + Math.min(Math.max(needle01, 0), 1))
    ctx.strokeStyle = '#a33d2f'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(c, c + 40)
    ctx.lineTo(c + Math.cos(ang) * 72, c - Math.sin(ang) * 72 + 40)
    ctx.stroke()
    ctx.fillStyle = '#8a7a32'
    ctx.beginPath()
    ctx.arc(c, c + 40, 9, 0, Math.PI * 2)
    ctx.fill()
    this.gaugeTexture.needsUpdate = true
  }

  public setActive(active: boolean): void {
    this.active = active
  }

  public setResearch(best: number | null, baseline: number | null): void {
    if (best !== this.bestBpb || baseline !== this.baselineBpb) {
      this.bestBpb = best
      this.baselineBpb = baseline
      this.lastGaugeDraw = -1 // force redraw
    }
  }

  public update(dt: number): void {
    const fdt = Math.min(dt, 0.05)
    this.time += fdt
    this.activeAmount += ((this.active ? 1 : 0) - this.activeAmount) * Math.min(1, fdt * 2)
    const k = this.activeAmount

    // lamps: slow green breathing idle → frantic amber chase while training
    for (let i = 0; i < this.lamps.length; i++) {
      const mat = this.lampMats[i]
      const idle = 0.45 + 0.2 * Math.sin(this.time * 1.2 + i * 2.1)
      const frantic = Math.sin(this.time * 9 + i * 2.4) > 0.2 ? 1 : 0.15
      mat.opacity = idle * (1 - k) + frantic * k
      mat.color.copy(IDLE_GREEN).lerp(AMBER, k)
    }

    // fan spins up
    this.fanAngle += fdt * (2 + k * 55)
    this.fanMat.uniforms.uT.value = this.fanAngle
    this.fanMat.uniforms.uA.value = 0.1 + k * 0.35

    // data pulses flow only while training
    ;(this.pulses.material as THREE.PointsMaterial).opacity = k * 0.85
    if (k > 0.02) {
      const pos = (this.pulses.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
      const v = new THREE.Vector3()
      for (let i = 0; i < this.pulseT.length; i++) {
        this.pulseT[i] = (this.pulseT[i] + fdt * 0.22) % 1
        this.curve.getPoint(this.pulseT[i], v)
        pos[i * 3] = v.x
        pos[i * 3 + 1] = v.y + Math.sin(this.pulseT[i] * Math.PI) * 0.04
        pos[i * 3 + 2] = v.z
      }
      ;(this.pulses.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    }

    // gauge: needle rests at 0 idle, quivers high while training; redraw at
    // ~6fps only when something moves (canvas redraws aren't free)
    const needle = k * (0.78 + 0.06 * Math.sin(this.time * 11) + 0.04 * Math.sin(this.time * 23))
    const bucket = Math.round(needle * 40) + (this.bestBpb ?? 0) * 1000
    if (bucket !== this.lastGaugeDraw && this.time % 0.16 < fdt) {
      this.lastGaugeDraw = bucket
      this.drawGauge(needle)
    }
  }

  public dispose(): void {
    this.group.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose()
        const m = (o as THREE.Mesh).material
        Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose()
      }
    })
    this.gaugeTexture.dispose()
  }
}
