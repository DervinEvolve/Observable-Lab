import * as THREE from 'three'
import { COLORS } from './colors'
import { WallClock } from './WallClock'

// Lab dimensions
const LAB_RADIUS = 8
const LAB_HEIGHT = 4
const WALL_THICKNESS = 0.3
const FLOOR_SEGMENTS = 32

// Store clock reference for updates
let wallClock: WallClock | null = null

export function getWallClock(): WallClock | null {
  return wallClock
}

export function createLab(): THREE.Group {
  const lab = new THREE.Group()
  lab.name = 'lab'

  // Floor - warm wood planks
  const floorGeometry = new THREE.CircleGeometry(LAB_RADIUS, FLOOR_SEGMENTS)
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.floor,
    roughness: 0.8,
    metalness: 0.1,
  })
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  floor.name = 'floor'
  lab.add(floor)

  // Add floor detail - wood grain pattern via subtle ring
  const floorRingGeometry = new THREE.RingGeometry(
    LAB_RADIUS - 0.5,
    LAB_RADIUS,
    FLOOR_SEGMENTS
  )
  const floorRingMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.woodDark,
    roughness: 0.9,
    metalness: 0.05,
  })
  const floorRing = new THREE.Mesh(floorRingGeometry, floorRingMaterial)
  floorRing.rotation.x = -Math.PI / 2
  floorRing.position.y = 0.001
  floorRing.receiveShadow = true
  lab.add(floorRing)

  // Walls - cream colored, slightly curved segments
  const wallGeometry = new THREE.CylinderGeometry(
    LAB_RADIUS + WALL_THICKNESS,
    LAB_RADIUS + WALL_THICKNESS,
    LAB_HEIGHT,
    FLOOR_SEGMENTS,
    1,
    true
  )
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.walls,
    roughness: 0.9,
    metalness: 0.02,
    side: THREE.BackSide,
  })
  const walls = new THREE.Mesh(wallGeometry, wallMaterial)
  walls.position.y = LAB_HEIGHT / 2
  walls.receiveShadow = true
  walls.name = 'walls'
  lab.add(walls)

  // Ceiling - slightly warmer than walls
  const ceilingGeometry = new THREE.CircleGeometry(
    LAB_RADIUS + WALL_THICKNESS,
    FLOOR_SEGMENTS
  )
  const ceilingMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.ceiling,
    roughness: 0.95,
    metalness: 0.0,
  })
  const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial)
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.y = LAB_HEIGHT
  ceiling.receiveShadow = true
  ceiling.name = 'ceiling'
  lab.add(ceiling)

  // Baseboard - brass trim around floor edge
  const baseboardGeometry = new THREE.TorusGeometry(LAB_RADIUS, 0.05, 8, FLOOR_SEGMENTS)
  const baseboardMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.4,
    metalness: 0.7,
  })
  const baseboard = new THREE.Mesh(baseboardGeometry, baseboardMaterial)
  baseboard.rotation.x = Math.PI / 2
  baseboard.position.y = 0.05
  lab.add(baseboard)

  // Crown molding - brass trim at ceiling
  const crownGeometry = new THREE.TorusGeometry(LAB_RADIUS, 0.08, 8, FLOOR_SEGMENTS)
  const crown = new THREE.Mesh(crownGeometry, baseboardMaterial)
  crown.rotation.x = Math.PI / 2
  crown.position.y = LAB_HEIGHT - 0.08
  lab.add(crown)

  // Central plant area - wooden terrarium base only
  // (Glass dome is managed by GlassTerrarium entity for breaking mechanic)
  const terrariumBaseGeometry = new THREE.CylinderGeometry(1.2, 1.4, 0.3, 6)
  const terrariumBaseMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.wood,
    roughness: 0.7,
    metalness: 0.1,
  })
  const terrariumBase = new THREE.Mesh(terrariumBaseGeometry, terrariumBaseMaterial)
  terrariumBase.position.y = 0.15
  terrariumBase.castShadow = true
  terrariumBase.receiveShadow = true
  terrariumBase.name = 'terrariumBase'
  lab.add(terrariumBase)

  // Wall clock - mounted on the back wall
  wallClock = new WallClock()
  // Position on back wall (negative Z direction from center)
  wallClock.group.position.set(0, LAB_HEIGHT * 0.7, -(LAB_RADIUS - 0.1))
  // Rotate to face inward (toward center)
  wallClock.group.rotation.y = Math.PI
  lab.add(wallClock.group)

  return lab
}

export { LAB_RADIUS, LAB_HEIGHT }
