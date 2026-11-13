import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Static batching for the furniture of the room. The lab shell, set dressing
// and desks are hundreds of small meshes that never move; merging the ones
// that share a look (same material settings and shadow flags) into a single
// mesh cuts hundreds of draw calls without changing what is drawn.
//
// Materials are kept, one per group, so the patina system still finds the
// brass and wood by colour and can age them.

const SKIP_NAMES = new Set(['wallClock', 'corkboard'])

// Brass and wood keep their own material colour (the patina system ages them
// by colour); everything else is baked into vertex colours so that parts that
// differ only in colour share one draw call.
function patinaColour(hex: number): boolean {
  return (hex >= 0x8a7000 && hex <= 0xd0c000) || (hex >= 0x5a4030 && hex <= 0xa08060)
}

function materialKey(m: THREE.Material): { key: string; bake: boolean } | null {
  if (!(m instanceof THREE.MeshStandardMaterial) && !(m instanceof THREE.MeshBasicMaterial)) return null
  if (m.transparent || m.alphaTest > 0 || !m.visible || m.vertexColors) return null
  const hex = m.color.getHex()
  const map = m.map?.uuid ?? ''
  const bake = !map && !patinaColour(hex)
  const parts: unknown[] = [m.type, bake ? 'baked' : hex, m.side, map]
  if (m instanceof THREE.MeshStandardMaterial) {
    parts.push(m.emissive.getHex(), m.emissiveIntensity, m.roughness, m.metalness, m.flatShading, m.emissiveMap?.uuid ?? '')
    if (m instanceof THREE.MeshPhysicalMaterial) parts.push(m.clearcoat, m.clearcoatRoughness)
  }
  return { key: parts.join('|'), bake }
}

function prepare(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, needUv: boolean, colour: THREE.Color | null): THREE.BufferGeometry | null {
  if (!geo.getAttribute('position') || Object.keys(geo.morphAttributes).length) return null
  const g = geo.clone()
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && !(needUv && name === 'uv')) g.deleteAttribute(name)
  }
  if (needUv && !g.getAttribute('uv')) return null
  if (!g.index) {
    const n = g.getAttribute('position').count
    g.setIndex(Array.from({ length: n }, (_, i) => i))
  }
  if (colour) {
    const n = g.getAttribute('position').count
    const c = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.set([colour.r, colour.g, colour.b], i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  }
  g.clearGroups()
  g.applyMatrix4(matrix)
  return g
}

function skipped(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root.parent; p = p.parent) {
    if (!p.visible || SKIP_NAMES.has(p.name) || p.userData.inspect || p.userData.noBatch) return true
  }
  return false
}

/** Merges the static meshes under `root`. Returns draw calls before and after. */
export function batchStatic(root: THREE.Object3D): { before: number; after: number } {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map<string, { bake: boolean; meshes: THREE.Mesh[] }>()
  let before = 0

  root.traverse(o => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || o instanceof THREE.SkinnedMesh) return
    before++
    if (Array.isArray(o.material) || skipped(o, root)) return
    const mk = materialKey(o.material)
    if (!mk) return
    const full = `${mk.key}|${o.castShadow}|${o.receiveShadow}`
    const entry = groups.get(full)
    if (entry) entry.meshes.push(o)
    else groups.set(full, { bake: mk.bake, meshes: [o] })
  })

  let removed = 0
  let added = 0
  for (const { bake, meshes } of groups.values()) {
    if (meshes.length < 2) continue
    let mat = meshes[0].material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
    const needUv = !!mat.map
    if (bake) {
      mat = mat.clone()
      mat.color.set(0xffffff)
      mat.vertexColors = true
    }
    const geos: THREE.BufferGeometry[] = []
    const used: THREE.Mesh[] = []
    for (const m of meshes) {
      const colour = bake ? (m.material as THREE.MeshStandardMaterial).color : null
      const g = prepare(m.geometry, new THREE.Matrix4().multiplyMatrices(toRoot, m.matrixWorld), needUv, colour)
      if (g) {
        geos.push(g)
        used.push(m)
      }
    }
    if (geos.length < 2) continue
    const merged = mergeGeometries(geos, false)
    geos.forEach(g => g.dispose())
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = 'batched'
    mesh.castShadow = used[0].castShadow
    mesh.receiveShadow = used[0].receiveShadow
    root.add(mesh)
    added++
    for (const m of used) {
      m.parent?.remove(m)
      removed++
    }
  }
  return { before, after: before - removed + added }
}
