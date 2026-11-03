import * as THREE from 'three'
import { COLORS, StationRole } from '../scene/colors'

const STATION_RADIUS = 5.5 // Distance from center

interface StationConfig {
  role: StationRole
  createProps: () => THREE.Group
}

// Reusable prop creators

// Create a glowing desk lamp
function createDeskLamp(color: number = 0xfff4e0): THREE.Group {
  const lamp = new THREE.Group()
  lamp.name = 'deskLamp'

  const brassMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.4,
    metalness: 0.7,
  })

  // Base
  const baseGeometry = new THREE.CylinderGeometry(0.06, 0.07, 0.02, 16)
  const base = new THREE.Mesh(baseGeometry, brassMaterial)
  base.position.y = 0.01
  lamp.add(base)

  // Stem
  const stemGeometry = new THREE.CylinderGeometry(0.015, 0.015, 0.25, 8)
  const stem = new THREE.Mesh(stemGeometry, brassMaterial)
  stem.position.y = 0.14
  lamp.add(stem)

  // Arm (angled)
  const armGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.18, 8)
  const arm = new THREE.Mesh(armGeometry, brassMaterial)
  arm.position.set(0.05, 0.3, 0)
  arm.rotation.z = -0.5
  lamp.add(arm)

  // Shade
  const shadeGeometry = new THREE.ConeGeometry(0.08, 0.1, 16, 1, true)
  const shadeMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a4a2a,
    roughness: 0.8,
    side: THREE.DoubleSide,
  })
  const shade = new THREE.Mesh(shadeGeometry, shadeMaterial)
  shade.position.set(0.12, 0.38, 0)
  shade.rotation.z = 0.2
  lamp.add(shade)

  // Glowing bulb
  const bulbGeometry = new THREE.SphereGeometry(0.03, 12, 8)
  const bulbMaterial = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.8,
    roughness: 0.3,
  })
  const bulb = new THREE.Mesh(bulbGeometry, bulbMaterial)
  bulb.position.set(0.12, 0.34, 0)
  lamp.add(bulb)

  // Add a point light for actual illumination
  const light = new THREE.PointLight(color, 0.5, 2)
  light.position.set(0.12, 0.34, 0)
  lamp.add(light)

  return lamp
}

// Create a laptop computer
function createLaptop(accentColor: number): THREE.Group {
  const laptop = new THREE.Group()
  laptop.name = 'laptop'

  // Base/keyboard
  const baseGeometry = new THREE.BoxGeometry(0.28, 0.015, 0.2)
  const baseMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.5,
    metalness: 0.3,
  })
  const base = new THREE.Mesh(baseGeometry, baseMaterial)
  base.position.y = 0.0075
  laptop.add(base)

  // Keyboard surface
  const keyboardGeometry = new THREE.BoxGeometry(0.24, 0.002, 0.14)
  const keyboardMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.8,
  })
  const keyboard = new THREE.Mesh(keyboardGeometry, keyboardMaterial)
  keyboard.position.set(0, 0.016, 0.02)
  laptop.add(keyboard)

  // Screen (angled back)
  const screenGeometry = new THREE.BoxGeometry(0.28, 0.19, 0.008)
  const screen = new THREE.Mesh(screenGeometry, baseMaterial)
  screen.position.set(0, 0.1, -0.09)
  screen.rotation.x = -0.25
  laptop.add(screen)

  // Screen display (with subtle glow)
  const displayGeometry = new THREE.BoxGeometry(0.25, 0.16, 0.001)
  const displayMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a2a3a,
    emissive: accentColor,
    emissiveIntensity: 0.15,
    roughness: 0.2,
  })
  const display = new THREE.Mesh(displayGeometry, displayMaterial)
  display.position.set(0, 0.1, -0.085)
  display.rotation.x = -0.25
  laptop.add(display)

  // Subtle screen light cast
  const screenLight = new THREE.PointLight(accentColor, 0.15, 1)
  screenLight.position.set(0, 0.15, 0)
  laptop.add(screenLight)

  return laptop
}

// Create a desktop monitor
function createMonitor(accentColor: number): THREE.Group {
  const monitor = new THREE.Group()
  monitor.name = 'monitor'

  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.5,
    metalness: 0.3,
  })

  // Stand base
  const standBaseGeometry = new THREE.BoxGeometry(0.15, 0.01, 0.1)
  const standBase = new THREE.Mesh(standBaseGeometry, darkMaterial)
  standBase.position.y = 0.005
  monitor.add(standBase)

  // Stand neck
  const standNeckGeometry = new THREE.BoxGeometry(0.03, 0.12, 0.03)
  const standNeck = new THREE.Mesh(standNeckGeometry, darkMaterial)
  standNeck.position.y = 0.07
  monitor.add(standNeck)

  // Screen frame
  const frameGeometry = new THREE.BoxGeometry(0.38, 0.24, 0.02)
  const frame = new THREE.Mesh(frameGeometry, darkMaterial)
  frame.position.y = 0.25
  monitor.add(frame)

  // Screen display
  const displayGeometry = new THREE.BoxGeometry(0.35, 0.21, 0.001)
  const displayMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a1520,
    emissive: accentColor,
    emissiveIntensity: 0.2,
    roughness: 0.1,
  })
  const display = new THREE.Mesh(displayGeometry, displayMaterial)
  display.position.set(0, 0.25, 0.011)
  monitor.add(display)

  // Screen light
  const screenLight = new THREE.PointLight(accentColor, 0.2, 1.5)
  screenLight.position.set(0, 0.3, 0.2)
  monitor.add(screenLight)

  return monitor
}

// Create colored sticky notes
function createStickyNote(color: number, width: number = 0.08, height: number = 0.08): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(width, height, 0.003)
  const material = new THREE.MeshStandardMaterial({
    color: color,
    roughness: 0.9,
  })
  const note = new THREE.Mesh(geometry, material)
  note.castShadow = true
  return note
}

// Create a basic desk that all stations share
function createDesk(): THREE.Group {
  const desk = new THREE.Group()

  // Desk top - warm wood
  const topGeometry = new THREE.BoxGeometry(1.8, 0.08, 0.9)
  const woodMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.wood,
    roughness: 0.7,
    metalness: 0.1,
  })
  const top = new THREE.Mesh(topGeometry, woodMaterial)
  top.position.y = 0.8
  top.castShadow = true
  top.receiveShadow = true
  desk.add(top)

  // Desk legs - brass
  const legGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.76, 8)
  const brassMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.4,
    metalness: 0.7,
  })

  const legPositions = [
    [-0.8, 0.38, -0.35],
    [0.8, 0.38, -0.35],
    [-0.8, 0.38, 0.35],
    [0.8, 0.38, 0.35],
  ]

  legPositions.forEach(([x, y, z]) => {
    const leg = new THREE.Mesh(legGeometry, brassMaterial)
    leg.position.set(x, y, z)
    leg.castShadow = true
    desk.add(leg)
  })

  return desk
}

// Planner Station: Whiteboard with sticky notes
function createPlannerProps(): THREE.Group {
  const props = new THREE.Group()
  props.name = 'plannerProps'

  // Desk
  const desk = createDesk()
  props.add(desk)

  // Laptop on desk
  const laptop = createLaptop(COLORS.models.gemini)
  laptop.position.set(0, 0.84, 0.1)
  props.add(laptop)

  // Desk lamp
  const lamp = createDeskLamp()
  lamp.position.set(0.7, 0.84, -0.1)
  props.add(lamp)

  // Standing whiteboard behind desk (larger)
  const boardGeometry = new THREE.BoxGeometry(1.6, 1.2, 0.04)
  const whiteBoardMaterial = new THREE.MeshStandardMaterial({
    color: 0xf8f8f8,
    roughness: 0.3,
    metalness: 0.0,
  })
  const board = new THREE.Mesh(boardGeometry, whiteBoardMaterial)
  board.position.set(0, 1.6, -0.55)
  board.castShadow = true
  props.add(board)

  // Board frame - aluminum
  const frameGeometry = new THREE.BoxGeometry(1.7, 1.3, 0.02)
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0xc0c0c0,
    roughness: 0.4,
    metalness: 0.6,
  })
  const frame = new THREE.Mesh(frameGeometry, frameMaterial)
  frame.position.set(0, 1.6, -0.53)
  props.add(frame)

  // Sticky notes on LEFT side of whiteboard (right side reserved for epoch notes)
  const stickyColors = [0xffeb3b, 0xff9800, 0x4caf50, 0x2196f3, 0xe91e63, 0x9c27b0]
  const stickyPositions = [
    { x: -0.55, y: 1.85, rot: 0.05 },
    { x: -0.42, y: 1.82, rot: -0.08 },
    { x: -0.55, y: 1.65, rot: -0.03 },
    { x: -0.40, y: 1.68, rot: 0.1 },
    { x: -0.58, y: 1.45, rot: 0.02 },
    { x: -0.43, y: 1.48, rot: -0.06 },
    { x: -0.56, y: 1.28, rot: 0.08 },
    { x: -0.38, y: 1.32, rot: -0.04 },
  ]

  stickyPositions.forEach((pos, i) => {
    const note = createStickyNote(stickyColors[i % stickyColors.length], 0.1, 0.1)
    note.position.set(pos.x, pos.y, -0.52)
    note.rotation.z = pos.rot
    props.add(note)
  })

  // Divider line on whiteboard (faint)
  const dividerGeometry = new THREE.BoxGeometry(0.005, 1.0, 0.001)
  const dividerMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc })
  const divider = new THREE.Mesh(dividerGeometry, dividerMaterial)
  divider.position.set(-0.2, 1.6, -0.525)
  props.add(divider)

  // "EPOCHS" label on right side
  // (This area reserved for dynamic epoch notes that appear over time)

  // Markers in tray
  const markerColors = [0x1a1a1a, 0xe53935, 0x1e88e5, 0x43a047]
  markerColors.forEach((color, i) => {
    const markerGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8)
    const markerMaterial = new THREE.MeshStandardMaterial({ color })
    const marker = new THREE.Mesh(markerGeometry, markerMaterial)
    marker.rotation.z = Math.PI / 2
    marker.position.set(-0.3 + i * 0.08, 0.86, 0.3)
    props.add(marker)
  })

  return props
}

// Executor Station: Workbench with tools and specimen jars
function createExecutorProps(): THREE.Group {
  const props = new THREE.Group()
  props.name = 'executorProps'

  // Workbench (heavier desk)
  const desk = createDesk()
  props.add(desk)

  // Desktop monitor (larger screen for coding)
  const monitor = createMonitor(COLORS.models.deepseek)
  monitor.position.set(0, 0.84, -0.15)
  props.add(monitor)

  // Desk lamp
  const lamp = createDeskLamp()
  lamp.position.set(-0.7, 0.84, 0.1)
  props.add(lamp)

  // Specimen jars (moved to side)
  const jarGeometry = new THREE.CylinderGeometry(0.05, 0.05, 0.1, 16)
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: COLORS.structure.glass,
    transparent: true,
    opacity: 0.4,
    roughness: 0.1,
    transmission: 0.6,
  })

  for (let i = 0; i < 3; i++) {
    const jar = new THREE.Mesh(jarGeometry, glassMaterial)
    jar.position.set(0.55 + i * 0.12, 0.89, 0.2)
    props.add(jar)

    // Jar lids - brass
    const lidGeometry = new THREE.CylinderGeometry(0.055, 0.055, 0.015, 16)
    const lid = new THREE.Mesh(
      lidGeometry,
      new THREE.MeshStandardMaterial({
        color: COLORS.structure.brass,
        roughness: 0.4,
        metalness: 0.7,
      })
    )
    lid.position.set(0.55 + i * 0.12, 0.95, 0.2)
    props.add(lid)
  }

  // Keyboard
  const keyboardGeometry = new THREE.BoxGeometry(0.3, 0.015, 0.1)
  const keyboardMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2a2a })
  const keyboard = new THREE.Mesh(keyboardGeometry, keyboardMaterial)
  keyboard.position.set(0, 0.85, 0.2)
  props.add(keyboard)

  return props
}

// Reviewer Station: Brass microscope + laptop for review
function createReviewerProps(): THREE.Group {
  const props = new THREE.Group()
  props.name = 'reviewerProps'

  const desk = createDesk()
  props.add(desk)

  // Laptop for reviewing code
  const laptop = createLaptop(COLORS.models.claude)
  laptop.position.set(-0.35, 0.84, 0.15)
  laptop.rotation.y = 0.2
  props.add(laptop)

  // Desk lamp
  const lamp = createDeskLamp()
  lamp.position.set(-0.7, 0.84, -0.2)
  props.add(lamp)

  // Microscope base (moved to right side)
  const baseMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.4,
    metalness: 0.7,
  })

  const baseGeometry = new THREE.BoxGeometry(0.15, 0.03, 0.18)
  const base = new THREE.Mesh(baseGeometry, baseMaterial)
  base.position.set(0.45, 0.855, 0)
  base.castShadow = true
  props.add(base)

  // Microscope arm
  const armGeometry = new THREE.BoxGeometry(0.03, 0.28, 0.03)
  const arm = new THREE.Mesh(armGeometry, baseMaterial)
  arm.position.set(0.45, 1.0, -0.06)
  props.add(arm)

  // Microscope head
  const headGeometry = new THREE.CylinderGeometry(0.04, 0.03, 0.12, 16)
  const head = new THREE.Mesh(headGeometry, baseMaterial)
  head.position.set(0.45, 1.08, 0.03)
  head.rotation.x = Math.PI / 6
  props.add(head)

  // Eyepiece
  const eyepieceGeometry = new THREE.CylinderGeometry(0.02, 0.025, 0.06, 12)
  const eyepiece = new THREE.Mesh(eyepieceGeometry, baseMaterial)
  eyepiece.position.set(0.45, 1.18, -0.01)
  props.add(eyepiece)

  // Stack of papers (review documents)
  const paperGeometry = new THREE.BoxGeometry(0.18, 0.025, 0.24)
  const paperMaterial = new THREE.MeshStandardMaterial({ color: 0xfaf8f5 })
  const papers = new THREE.Mesh(paperGeometry, paperMaterial)
  papers.position.set(0.1, 0.855, -0.25)
  props.add(papers)

  // Red pen for marking
  const penGeometry = new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8)
  const penMaterial = new THREE.MeshStandardMaterial({ color: 0xc62828 })
  const pen = new THREE.Mesh(penGeometry, penMaterial)
  pen.rotation.z = Math.PI / 2
  pen.position.set(0.15, 0.875, -0.15)
  props.add(pen)

  return props
}

// Challenger Station: Red warning lamp, stress gauges, and monitor
function createChallengerProps(): THREE.Group {
  const props = new THREE.Group()
  props.name = 'challengerProps'

  const desk = createDesk()
  props.add(desk)

  // Monitor for attack vectors
  const monitor = createMonitor(COLORS.models.gpt)
  monitor.position.set(-0.2, 0.84, -0.1)
  props.add(monitor)

  // Desk lamp (red-tinted for warning aesthetic)
  const lamp = createDeskLamp(0xffaa88)
  lamp.position.set(-0.7, 0.84, 0.15)
  props.add(lamp)

  // Warning lamp housing (moved to right side)
  const lampBaseGeometry = new THREE.CylinderGeometry(0.06, 0.07, 0.04, 16)
  const darkMetalMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.6,
    metalness: 0.5,
  })
  const warningLampBase = new THREE.Mesh(lampBaseGeometry, darkMetalMaterial)
  warningLampBase.position.set(0.6, 0.86, 0.1)
  props.add(warningLampBase)

  // Red lamp bulb (pulsing glow)
  const bulbGeometry = new THREE.SphereGeometry(0.045, 16, 12)
  const redGlowMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.states.blocked,
    emissive: COLORS.states.blocked,
    emissiveIntensity: 0.5,
    roughness: 0.3,
  })
  const bulb = new THREE.Mesh(bulbGeometry, redGlowMaterial)
  bulb.position.set(0.6, 0.91, 0.1)
  props.add(bulb)

  // Red warning light
  const redLight = new THREE.PointLight(COLORS.states.blocked, 0.3, 1.5)
  redLight.position.set(0.6, 0.95, 0.1)
  props.add(redLight)

  // Stress gauge panel (smaller, on desk)
  const panelGeometry = new THREE.BoxGeometry(0.25, 0.15, 0.03)
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.5,
    metalness: 0.6,
  })
  const panel = new THREE.Mesh(panelGeometry, panelMaterial)
  panel.position.set(0.5, 0.86, -0.2)
  panel.rotation.x = -0.4
  props.add(panel)

  // Gauge faces
  const gaugeGeometry = new THREE.CircleGeometry(0.04, 24)
  const gaugeMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f2eb })
  for (let i = 0; i < 2; i++) {
    const gauge = new THREE.Mesh(gaugeGeometry, gaugeMaterial)
    gauge.position.set(0.44 + i * 0.1, 0.88, -0.17)
    gauge.rotation.x = -0.4
    props.add(gauge)
  }

  // Keyboard
  const keyboardGeometry = new THREE.BoxGeometry(0.28, 0.012, 0.09)
  const keyboardMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
  const keyboard = new THREE.Mesh(keyboardGeometry, keyboardMaterial)
  keyboard.position.set(-0.2, 0.85, 0.2)
  props.add(keyboard)

  return props
}

// Commentator Station: Writing desk with laptop and speaking tube
function createCommentatorProps(): THREE.Group {
  const props = new THREE.Group()
  props.name = 'commentatorProps'

  const desk = createDesk()
  props.add(desk)

  // Laptop for writing commentary
  const laptop = createLaptop(COLORS.models.grok)
  laptop.position.set(-0.2, 0.84, 0.1)
  props.add(laptop)

  // Desk lamp
  const lamp = createDeskLamp()
  lamp.position.set(0.65, 0.84, 0.2)
  props.add(lamp)

  // Open journal/book (for notes)
  const bookGeometry = new THREE.BoxGeometry(0.22, 0.015, 0.28)
  const bookMaterial = new THREE.MeshStandardMaterial({ color: 0x8b4513 })
  const book = new THREE.Mesh(bookGeometry, bookMaterial)
  book.position.set(0.45, 0.85, -0.1)
  props.add(book)

  // Pages
  const pagesGeometry = new THREE.BoxGeometry(0.2, 0.01, 0.26)
  const pagesMaterial = new THREE.MeshStandardMaterial({ color: 0xfaf8f0 })
  const pages = new THREE.Mesh(pagesGeometry, pagesMaterial)
  pages.position.set(0.45, 0.86, -0.1)
  props.add(pages)

  // Pen
  const penGeometry = new THREE.CylinderGeometry(0.006, 0.006, 0.12, 8)
  const penMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
  const pen = new THREE.Mesh(penGeometry, penMaterial)
  pen.rotation.z = Math.PI / 2
  pen.position.set(0.5, 0.875, 0.08)
  props.add(pen)

  // Speaking tube (brass) - vintage microphone style
  const brassMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.4,
    metalness: 0.7,
  })

  // Tube base
  const tubeBaseGeometry = new THREE.CylinderGeometry(0.05, 0.06, 0.03, 12)
  const tubeBase = new THREE.Mesh(tubeBaseGeometry, brassMaterial)
  tubeBase.position.set(-0.65, 0.855, -0.1)
  props.add(tubeBase)

  // Tube stem
  const tubeStemGeometry = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 8)
  const tubeStem = new THREE.Mesh(tubeStemGeometry, brassMaterial)
  tubeStem.position.set(-0.65, 0.97, -0.1)
  props.add(tubeStem)

  // Tube flare (microphone head)
  const flareGeometry = new THREE.ConeGeometry(0.06, 0.08, 12)
  const flare = new THREE.Mesh(flareGeometry, brassMaterial)
  flare.position.set(-0.65, 1.12, -0.1)
  props.add(flare)

  // Coffee cup
  const cupGeometry = new THREE.CylinderGeometry(0.03, 0.025, 0.06, 12)
  const cupMaterial = new THREE.MeshStandardMaterial({ color: 0xf5f5f5 })
  const cup = new THREE.Mesh(cupGeometry, cupMaterial)
  cup.position.set(0.7, 0.87, -0.2)
  props.add(cup)

  return props
}

const STATION_CONFIGS: StationConfig[] = [
  { role: 'planner', createProps: createPlannerProps },
  { role: 'executor', createProps: createExecutorProps },
  { role: 'reviewer', createProps: createReviewerProps },
  { role: 'challenger', createProps: createChallengerProps },
  { role: 'commentator', createProps: createCommentatorProps },
]

export function createAllStations(): THREE.Group {
  const stations = new THREE.Group()
  stations.name = 'stations'

  STATION_CONFIGS.forEach((config, i) => {
    const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2 // Start from top
    const x = Math.cos(angle) * STATION_RADIUS
    const z = Math.sin(angle) * STATION_RADIUS

    const station = config.createProps()
    station.position.set(x, 0, z)
    station.rotation.y = -angle - Math.PI / 2 // Face center
    station.name = `station_${config.role}`

    stations.add(station)
  })

  return stations
}

export { STATION_RADIUS }
