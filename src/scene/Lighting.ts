import * as THREE from 'three'
import { COLORS } from './colors'
import { LAB_HEIGHT } from './Lab'

export function createLighting(): THREE.Group {
  const lighting = new THREE.Group()
  lighting.name = 'lighting'

  // Ambient light - warm, soft fill
  const ambient = new THREE.AmbientLight(COLORS.lighting.ambient, 0.4)
  lighting.add(ambient)

  // Main directional light - warm afternoon sun through windows
  const sunLight = new THREE.DirectionalLight(COLORS.lighting.sunWarm, 0.8)
  sunLight.position.set(5, 8, 3)
  sunLight.castShadow = true
  sunLight.shadow.mapSize.width = 2048
  sunLight.shadow.mapSize.height = 2048
  sunLight.shadow.camera.near = 1
  sunLight.shadow.camera.far = 20
  sunLight.shadow.camera.left = -10
  sunLight.shadow.camera.right = 10
  sunLight.shadow.camera.top = 10
  sunLight.shadow.camera.bottom = -10
  sunLight.shadow.bias = -0.0001
  sunLight.name = 'sunLight'
  lighting.add(sunLight)

  // Secondary fill light - cooler, from opposite side
  const fillLight = new THREE.DirectionalLight(COLORS.lighting.sunCool, 0.3)
  fillLight.position.set(-4, 6, -2)
  lighting.add(fillLight)

  // Central overhead lamp - warm glow on the terrarium
  const centerSpot = new THREE.SpotLight(COLORS.lighting.lampGlow, 1.5)
  centerSpot.position.set(0, LAB_HEIGHT - 0.5, 0)
  centerSpot.angle = Math.PI / 6
  centerSpot.penumbra = 0.5
  centerSpot.decay = 1.5
  centerSpot.distance = 8
  centerSpot.castShadow = true
  centerSpot.shadow.mapSize.width = 1024
  centerSpot.shadow.mapSize.height = 1024
  centerSpot.target.position.set(0, 0, 0)
  centerSpot.name = 'centerSpot'
  lighting.add(centerSpot)
  lighting.add(centerSpot.target)

  // Create ceiling lamp fixture
  const lampFixture = createLampFixture()
  lampFixture.position.set(0, LAB_HEIGHT - 0.1, 0)
  lighting.add(lampFixture)

  // Station desk lamps - one for each of the 5 stations
  const stationLampPositions = getStationPositions()
  stationLampPositions.forEach((pos, i) => {
    const deskLamp = new THREE.PointLight(COLORS.lighting.lampGlow, 0.3)
    deskLamp.position.set(pos.x * 0.8, 1.2, pos.z * 0.8)
    deskLamp.decay = 2
    deskLamp.distance = 3
    deskLamp.name = `stationLamp${i}`
    lighting.add(deskLamp)
  })

  return lighting
}

function createLampFixture(): THREE.Group {
  const fixture = new THREE.Group()

  // Brass cone shade
  const shadeGeometry = new THREE.ConeGeometry(0.4, 0.25, 16, 1, true)
  const shadeMaterial = new THREE.MeshStandardMaterial({
    color: COLORS.structure.brass,
    roughness: 0.4,
    metalness: 0.7,
    side: THREE.DoubleSide,
  })
  const shade = new THREE.Mesh(shadeGeometry, shadeMaterial)
  shade.rotation.x = Math.PI
  fixture.add(shade)

  // Chain/rod to ceiling
  const rodGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8)
  const rod = new THREE.Mesh(rodGeometry, shadeMaterial)
  rod.position.y = 0.15
  fixture.add(rod)

  // Ceiling mount
  const mountGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.05, 16)
  const mount = new THREE.Mesh(mountGeometry, shadeMaterial)
  mount.position.y = 0.3
  fixture.add(mount)

  return fixture
}

function getStationPositions(): { x: number; z: number }[] {
  const positions: { x: number; z: number }[] = []
  const radius = 5.5 // Station distance from center

  for (let i = 0; i < 5; i++) {
    const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2 // Start from top
    positions.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    })
  }

  return positions
}

// Export for use by stations
export { getStationPositions }
