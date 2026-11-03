import * as THREE from 'three'
import { COLORS } from './colors'
import { LAB_HEIGHT } from './Lab'

// Subtle, additive "AI research lab" set dressing placed in the ring of empty
// space between the desks (radius ~5) and the wall (radius ~8). Purely
// decorative — nothing here touches the existing scene, models, or systems.

// A prop placed at a given angle/radius, rotated so its +Z front faces center.
function place(group: THREE.Object3D, angleDeg: number, radius: number): void {
  const a = (angleDeg * Math.PI) / 180
  group.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius)
  group.rotation.y = -a - Math.PI / 2
}

// Points of interest scientists can walk to (a spot to stand + what to look at).
// `stand` sits a bit inside the prop so they face it from the room side.
export interface LabPOI { name: string; stand: [number, number, number]; look: [number, number, number] }
function poi(name: string, angleDeg: number, propR: number, standR: number): LabPOI {
  const a = (angleDeg * Math.PI) / 180
  return {
    name,
    stand: [Math.cos(a) * standR, 0, Math.sin(a) * standR],
    look: [Math.cos(a) * propR, 0, Math.sin(a) * propR],
  }
}
export const LAB_POIS: LabPOI[] = [
  poi('coffee', 252, 6.8, 5.4),
  poi('whiteboard', 18, 6.3, 5.2),
  poi('bookshelf', -126, 6.95, 5.5),
  // The Capability Archive wall (built in main.ts, state-driven) — scientists
  // wander over to study what the agent has earned so far.
  poi('archive', 180, 7.8, 5.6),
]

// The compute rack — a scientist walks here when accessing Modal (GPU work).
export const LAB_RACK_POI: LabPOI = poi('rack', -54, 6.6, 5.5)

// ---- Compute / server rack (the strongest "AI lab" signal) ----
function makeServerRack(): THREE.Group {
  const rack = new THREE.Group()
  rack.name = 'server_rack'

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x26292e, roughness: 0.55, metalness: 0.45 })
  const w = 0.62, h = 1.7, d = 0.5
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat)
  body.position.y = h / 2
  body.castShadow = true
  body.receiveShadow = true
  rack.add(body)

  // Front face details: vent slots + a column of soft status LEDs
  const faceZ = d / 2 + 0.002
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.8 })
  const ledColors = [0x7cb342, 0xffb74d, 0x64b5f6] // green / amber / blue, soft

  for (let i = 0; i < 8; i++) {
    const y = 0.18 + i * 0.19
    // vent slot
    const slot = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, 0.06, 0.01), slotMat)
    slot.position.set(0, y, faceZ)
    rack.add(slot)

    // two LEDs per unit, varied brightness for life (static = no update hook needed)
    for (let k = 0; k < 2; k++) {
      const c = ledColors[(i + k) % ledColors.length]
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.025, 0.012),
        new THREE.MeshStandardMaterial({
          color: c,
          emissive: c,
          emissiveIntensity: 0.5 + ((i * 2 + k) % 3) * 0.25,
          roughness: 0.4,
        })
      )
      led.position.set(-w / 2 + 0.08 + k * 0.07, y, faceZ + 0.006)
      rack.add(led)
    }
  }
  return rack
}

// ---- Low bookshelf with colored spines ----
function makeBookshelf(): THREE.Group {
  const shelf = new THREE.Group()
  shelf.name = 'bookshelf'
  const woodMat = new THREE.MeshStandardMaterial({ color: COLORS.structure.woodDark, roughness: 0.85 })
  const w = 1.3, h = 0.95, d = 0.32

  // frame
  const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), woodMat)
  back.position.set(0, h / 2, -d / 2)
  shelf.add(back)
  for (const sy of [0.02, h / 2, h - 0.02]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), woodMat)
    board.position.set(0, sy, 0)
    board.castShadow = true
    shelf.add(board)
  }
  for (const sx of [-w / 2 + 0.02, w / 2 - 0.02]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.04, h, d), woodMat)
    side.position.set(sx, h / 2, 0)
    shelf.add(side)
  }

  // books on the two shelves
  const spineColors = [0x8a5a44, 0x4a6b5a, 0x7a6b3a, 0x5a5570, 0x9a4a4a, 0x3a5a6a]
  for (const rowY of [0.07, h / 2 + 0.05]) {
    let x = -w / 2 + 0.1
    while (x < w / 2 - 0.1) {
      const bw = 0.04 + Math.random() * 0.05
      const bh = 0.28 + Math.random() * 0.12
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(bw, bh, 0.22),
        new THREE.MeshStandardMaterial({ color: spineColors[Math.floor(Math.random() * spineColors.length)], roughness: 0.9 })
      )
      book.position.set(x + bw / 2, rowY + bh / 2, 0)
      book.rotation.z = Math.random() < 0.1 ? 0.25 : 0 // an occasional leaning book
      book.castShadow = true
      shelf.add(book)
      x += bw + 0.012
    }
  }
  return shelf
}

// ---- Wall corkboard with pinned sticky notes ----
function makeCorkboard(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'corkboard'
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.8, 0.04),
    new THREE.MeshStandardMaterial({ color: COLORS.structure.brassPatina, roughness: 0.5, metalness: 0.6 })
  )
  g.add(frame)
  const cork = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xc9a36a, roughness: 0.95 })
  )
  cork.position.z = 0.025
  g.add(cork)

  // Notes are pinned dynamically from main.ts — one card per active behavior
  // the agent holds, so the board fills up as the spec grows.
  return g
}

// ---- Framed neural-net diagram (a quiet "AI research" cue) ----
function makeFramedDiagram(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'nn_diagram'
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.8, 0.04),
    new THREE.MeshStandardMaterial({ color: COLORS.structure.brassPatina, roughness: 0.5, metalness: 0.6 })
  )
  g.add(frame)
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.7),
    new THREE.MeshStandardMaterial({ color: 0xf3efe3, roughness: 0.95 })
  )
  panel.position.z = 0.025
  g.add(panel)

  const layers = [3, 4, 4, 2]
  const nodeMat = new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.6 })
  const lineMat = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.8 })
  const cols: THREE.Vector3[][] = []
  const xStart = -0.36, xStep = 0.24
  layers.forEach((count, li) => {
    const col: THREE.Vector3[] = []
    for (let n = 0; n < count; n++) {
      const p = new THREE.Vector3(xStart + li * xStep, (n - (count - 1) / 2) * 0.16, 0.03)
      col.push(p)
      const node = new THREE.Mesh(new THREE.CircleGeometry(0.022, 12), nodeMat)
      node.position.copy(p)
      g.add(node)
    }
    cols.push(col)
  })
  for (let li = 0; li < cols.length - 1; li++) {
    for (const a of cols[li]) for (const b of cols[li + 1]) {
      const dir = new THREE.Vector3().subVectors(b, a)
      const line = new THREE.Mesh(new THREE.BoxGeometry(dir.length(), 0.004, 0.002), lineMat)
      line.position.copy(a.clone().add(b).multiplyScalar(0.5))
      line.position.z = 0.028
      line.rotation.z = Math.atan2(dir.y, dir.x)
      g.add(line)
    }
  }
  return g
}

// ---- Whiteboard on an easel with a few marker strokes ----
function makeWhiteboardEasel(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'whiteboard_easel'
  const woodMat = new THREE.MeshStandardMaterial({ color: COLORS.structure.wood, roughness: 0.8 })

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.65, 0.03),
    new THREE.MeshStandardMaterial({ color: 0xf7f5ef, roughness: 0.6 })
  )
  board.position.y = 1.0
  board.castShadow = true
  g.add(board)

  const legGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.2, 6)
  const mkLeg = (x: number, z: number, rotX: number, rotZ: number) => {
    const leg = new THREE.Mesh(legGeo, woodMat)
    leg.position.set(x, 0.6, z)
    leg.rotation.set(rotX, 0, rotZ)
    leg.castShadow = true
    return leg
  }
  g.add(mkLeg(-0.35, 0.08, 0.12, 0.18))
  g.add(mkLeg(0.35, 0.08, 0.12, -0.18))
  g.add(mkLeg(0, -0.22, -0.26, 0))

  const strokeColors = [0x3a6ea5, 0xb5503a, 0x4a8a5a]
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(0.4 + Math.random() * 0.2, 0.02, 0.005),
      new THREE.MeshStandardMaterial({ color: strokeColors[i], roughness: 0.7 })
    )
    s.position.set(-0.12 + (Math.random() - 0.5) * 0.2, 1.16 - i * 0.16, 0.02)
    s.rotation.z = (Math.random() - 0.5) * 0.1
    g.add(s)
  }
  return g
}

// ---- A second, smaller compute unit (pairs with the rack) ----
function makeComputeTower(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'compute_tower'
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.4 })
  const w = 0.34, h = 0.8, d = 0.42
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  body.position.y = h / 2
  body.castShadow = true
  body.receiveShadow = true
  g.add(body)
  const faceZ = d / 2 + 0.002
  const vent = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.6, 0.3, 0.01),
    new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.8 })
  )
  vent.position.set(0, h * 0.55, faceZ)
  g.add(vent)
  const ledColors = [0x7cb342, 0x64b5f6]
  for (let i = 0; i < 2; i++) {
    const c = ledColors[i]
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.03, 0.012),
      new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.7, roughness: 0.4 })
    )
    led.position.set(-w / 2 + 0.07 + i * 0.07, h * 0.2, faceZ + 0.006)
    g.add(led)
  }
  return g
}

// ---- Floor cables running from the compute corner toward the center ----
function makeCableRun(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'cables'
  const mat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 })
  const a = (-54 * Math.PI) / 180
  const start = new THREE.Vector3(Math.cos(a) * 6.2, 0.02, Math.sin(a) * 6.2)
  for (let i = 0; i < 3; i++) {
    const end = new THREE.Vector3(
      Math.cos(a) * (3.4 + i * 0.3),
      0.02,
      Math.sin(a) * (3.4 + i * 0.3) + (i - 1) * 0.25
    )
    const mid = start.clone().lerp(end, 0.5)
    mid.x += (i - 1) * 0.22
    mid.y = 0.02
    const curve = new THREE.CatmullRomCurve3([
      start.clone().add(new THREE.Vector3((i - 1) * 0.08, 0, 0)),
      mid,
      end,
    ])
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.012, 5, false), mat)
    tube.receiveShadow = true
    g.add(tube)
  }
  return g
}

// ---- Hanging pendant light (decorative — soft emissive bulb, no extra light) ----
function makePendantLight(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'pendant_light'
  const cord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, 1.0, 5),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 })
  )
  cord.position.y = -0.5
  g.add(cord)
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.18, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: COLORS.structure.brass, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide })
  )
  shade.position.y = -1.05
  g.add(shade)
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff1cf, emissive: 0xffcc66, emissiveIntensity: 0.9, roughness: 0.5 })
  )
  bulb.position.y = -1.12
  g.add(bulb)
  return g
}

// ---- Framed results plot (a rising line chart) ----
function makeFramedPlot(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'framed_plot'
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.7, 0.04),
    new THREE.MeshStandardMaterial({ color: COLORS.structure.brassPatina, roughness: 0.5, metalness: 0.6 })
  )
  g.add(frame)
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xf3efe3, roughness: 0.95 })
  )
  panel.position.z = 0.025
  g.add(panel)
  const axisMat = new THREE.MeshStandardMaterial({ color: 0x6a7079 })
  const xaxis = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.006, 0.002), axisMat)
  xaxis.position.set(0, -0.22, 0.03)
  g.add(xaxis)
  const yaxis = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.42, 0.002), axisMat)
  yaxis.position.set(-0.3, -0.01, 0.03)
  g.add(yaxis)
  const lineMat = new THREE.MeshStandardMaterial({ color: 0x4a8a5a })
  let prev = new THREE.Vector3(-0.3, -0.2, 0.032)
  for (let i = 1; i <= 6; i++) {
    const cur = new THREE.Vector3(-0.3 + i * 0.1, -0.2 + (i / 6) * 0.34 + (Math.random() - 0.5) * 0.05, 0.032)
    const dir = new THREE.Vector3().subVectors(cur, prev)
    const seg = new THREE.Mesh(new THREE.BoxGeometry(dir.length(), 0.008, 0.002), lineMat)
    seg.position.copy(prev.clone().add(cur).multiplyScalar(0.5))
    seg.rotation.z = Math.atan2(dir.y, dir.x)
    g.add(seg)
    prev = cur
  }
  return g
}

// ---- Small stack of wooden storage crates ----
function makeCrateStack(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'crates'
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.structure.wood, roughness: 0.9 })
  const mkCrate = (s: number, y: number, rot: number) => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat)
    box.position.y = y
    box.rotation.y = rot
    box.castShadow = true
    box.receiveShadow = true
    return box
  }
  g.add(mkCrate(0.4, 0.2, 0.1))
  g.add(mkCrate(0.34, 0.57, -0.2))
  return g
}

// ---- Coffee / water station (a small break nook) ----
function makeCoffeeStation(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'coffee_station'
  const woodMat = new THREE.MeshStandardMaterial({ color: COLORS.structure.wood, roughness: 0.85 })
  const w = 0.95, h = 0.82, d = 0.45
  const cab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), woodMat)
  cab.position.y = h / 2
  cab.castShadow = true
  cab.receiveShadow = true
  g.add(cab)
  const topY = h + 0.01

  // coffee machine + carafe + power LED
  const machine = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.3, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.4 })
  )
  machine.position.set(-0.28, topY + 0.15, 0)
  machine.castShadow = true
  g.add(machine)
  const carafe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.07, 0.14, 10),
    new THREE.MeshStandardMaterial({ color: 0x3a2218, roughness: 0.4 })
  )
  carafe.position.set(-0.28, topY + 0.07, 0.14)
  g.add(carafe)
  const led = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.02, 0.01),
    new THREE.MeshStandardMaterial({ color: 0xff5a4a, emissive: 0xff5a4a, emissiveIntensity: 0.8 })
  )
  led.position.set(-0.36, topY + 0.22, 0.111)
  g.add(led)

  // mugs
  const mugColors = [0xeae3d6, 0x6e93b0]
  for (let i = 0; i < 2; i++) {
    const mug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.04, 0.08, 10),
      new THREE.MeshStandardMaterial({ color: mugColors[i], roughness: 0.8 })
    )
    mug.position.set(0.06 + i * 0.12, topY + 0.04, 0.05)
    g.add(mug)
  }

  // water cooler beside the counter (base + translucent blue jug)
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.6, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.6 })
  )
  base.position.set(w / 2 + 0.25, 0.3, 0)
  base.castShadow = true
  g.add(base)
  const jug = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.1, 0.32, 12),
    new THREE.MeshStandardMaterial({ color: 0x9fd3e3, roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.8 })
  )
  jug.position.set(w / 2 + 0.25, 0.78, 0)
  g.add(jug)

  return g
}

export function createLabDetails(): THREE.Group {
  const details = new THREE.Group()
  details.name = 'lab_details'

  // Desks sit at 5 stations (every 72°, starting -90°). Place props in the gaps.
  const rack = makeServerRack()
  place(rack, -54, 6.9)
  details.add(rack)

  const shelf = makeBookshelf()
  place(shelf, -126, 6.95)
  details.add(shelf)

  // No potted plants — the central growing plant is the agent metaphor, so extra
  // greenery would be confusing/redundant.

  // One corkboard with pinned notes on the wall (radius ~7.85), at eye level
  const board1 = makeCorkboard()
  place(board1, 90, 7.84)
  board1.position.y = 2.0
  details.add(board1)

  // Framed neural-net diagram on another wall section
  const diagram = makeFramedDiagram()
  place(diagram, 162, 7.84)
  diagram.position.y = 2.0
  details.add(diagram)

  // Whiteboard easel in an open gap
  const easel = makeWhiteboardEasel()
  place(easel, 18, 6.3)
  details.add(easel)

  // "Compute corner": a second unit beside the rack + cables toward center
  const tower = makeComputeTower()
  place(tower, -66, 6.6)
  details.add(tower)
  details.add(makeCableRun())

  // Storage crates tucked by the compute corner
  const crates = makeCrateStack()
  place(crates, -40, 6.3)
  details.add(crates)

  // Framed results plot on the wall above the bookshelf
  const plot = makeFramedPlot()
  place(plot, 234, 7.84)
  plot.position.y = 2.6
  details.add(plot)

  // Coffee / water station tucked against the wall (a break nook)
  const coffee = makeCoffeeStation()
  place(coffee, 252, 6.8)
  details.add(coffee)

  // Hanging pendant lights for ambiance (decorative, don't alter lighting)
  for (const deg of [30, 150, 270]) {
    const pend = makePendantLight()
    const a = (deg * Math.PI) / 180
    pend.position.set(Math.cos(a) * 4.5, LAB_HEIGHT, Math.sin(a) * 4.5)
    details.add(pend)
  }

  return details
}
