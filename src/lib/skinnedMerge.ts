import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { perVertexLook } from './staticBatch'

// A character model arrives as ten or so skinned pieces (coat, trousers,
// hair, skin...) that share one skeleton and differ only in colour. Merging
// them into one skinned mesh per look, with each piece's colour baked into
// vertex colours, draws the same figure in one or two calls instead of ten.
//
// `group` sorts the pieces (for example accent pieces that glow when the
// scientist is active, and the rest); each group keeps one material.

export function mergeSkinnedPieces(
  root: THREE.Object3D,
  group: (mat: THREE.MeshStandardMaterial) => string
): Map<string, THREE.SkinnedMesh> {
  const out = new Map<string, THREE.SkinnedMesh>()
  const pieces: THREE.SkinnedMesh[] = []
  root.traverse(o => {
    if (o instanceof THREE.SkinnedMesh && o.material instanceof THREE.MeshStandardMaterial && !o.material.transparent && !o.material.map) pieces.push(o)
  })
  if (pieces.length < 2) return out
  const skeleton = pieces[0].skeleton
  const parent = pieces[0].parent
  const bind = pieces[0].bindMatrix
  // only pieces that really share one rig and one frame
  const ok = pieces.filter(p => p.skeleton === skeleton && p.parent === parent && p.bindMatrix.equals(bind) && p.matrix.equals(pieces[0].matrix))
  const buckets = new Map<string, THREE.SkinnedMesh[]>()
  for (const p of ok) {
    const key = group(p.material as THREE.MeshStandardMaterial)
    const list = buckets.get(key)
    if (list) list.push(p)
    else buckets.set(key, [p])
  }
  for (const [key, list] of buckets) {
    if (list.length < 2) continue
    const geos: THREE.BufferGeometry[] = []
    for (const p of list) {
      const g = p.geometry.clone()
      if (Object.keys(g.morphAttributes).length || !g.getAttribute('skinIndex') || !g.getAttribute('skinWeight')) return out
      for (const name of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(name)) g.deleteAttribute(name)
      }
      if (!g.getAttribute('normal')) g.computeVertexNormals()
      if (!g.index) g.setIndex([...Array(g.getAttribute('position').count).keys()])
      // GLTF attributes may be interleaved or use different array types
      // between pieces: copy each into a plain attribute, element by element
      for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) {
        const a = g.getAttribute(name)
        const plain = name === 'skinIndex' ? new Uint16Array(a.count * a.itemSize) : new Float32Array(a.count * a.itemSize)
        for (let i = 0; i < a.count; i++) {
          for (let k = 0; k < a.itemSize; k++) plain[i * a.itemSize + k] = a.getComponent(i, k)
        }
        g.setAttribute(name, new THREE.BufferAttribute(plain, a.itemSize))
      }
      const c = (p.material as THREE.MeshStandardMaterial).color
      const n = g.getAttribute('position').count
      const col = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3)
      g.setAttribute('color', new THREE.BufferAttribute(col, 3))
      g.clearGroups()
      geos.push(g)
    }
    const merged = mergeGeometries(geos, false)
    geos.forEach(g => g.dispose())
    if (!merged) continue
    const mat = (list[0].material as THREE.MeshStandardMaterial).clone()
    mat.color.set(0xffffff)
    mat.vertexColors = true
    const mesh = new THREE.SkinnedMesh(merged, mat)
    mesh.name = `merged_${key}`
    mesh.position.copy(list[0].position)
    mesh.quaternion.copy(list[0].quaternion)
    mesh.scale.copy(list[0].scale)
    mesh.castShadow = list[0].castShadow
    mesh.receiveShadow = list[0].receiveShadow
    mesh.frustumCulled = list[0].frustumCulled
    mesh.bind(skeleton, bind)
    parent!.add(mesh)
    for (const p of list) p.parent?.remove(p)
    out.set(key, mesh)
  }
  return out
}

/**
 * A rigid model whose pieces each follow their own animated node (a robot's
 * arms, legs and feet) drawn as one skinned mesh: every piece becomes a "bone"
 * of itself, with all its vertices bound to it, so it moves exactly as
 * before. The original pieces stay in place (their nodes still animate) but
 * no longer draw. Colour, roughness, metalness and glow go into vertex
 * attributes.
 */
export function mergeRigidRig(root: THREE.Object3D): THREE.SkinnedMesh | null {
  root.updateMatrixWorld(true)
  const pieces: THREE.Mesh[] = []
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.SkinnedMesh || o instanceof THREE.InstancedMesh) return
    const m = o.material
    if (Array.isArray(m) || !(m instanceof THREE.MeshStandardMaterial) || m instanceof THREE.MeshPhysicalMaterial) return
    if (m.transparent || m.map || m.vertexColors || m.emissiveMap || m.normalMap || !m.visible || o.userData.noBatch) return
    pieces.push(o)
  })
  if (pieces.length < 2) return null
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const geos: THREE.BufferGeometry[] = []
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    const mat = p.material as THREE.MeshStandardMaterial
    const g = p.geometry.clone()
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
    if (Object.keys(g.morphAttributes).length) return null
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    if (!g.index) g.setIndex([...Array(g.getAttribute('position').count).keys()])
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, p.matrixWorld))
    const n = g.getAttribute('position').count
    const fill = (size: number, v: number[], Arr: Float32ArrayConstructor | Uint16ArrayConstructor = Float32Array) => {
      const a = new Arr(n * size)
      for (let k = 0; k < n; k++) a.set(v, k * size)
      return new THREE.BufferAttribute(a, size)
    }
    const glow = mat.emissive.clone().multiplyScalar(mat.emissiveIntensity)
    g.setAttribute('color', fill(3, [mat.color.r, mat.color.g, mat.color.b]))
    g.setAttribute('aRM', fill(2, [mat.roughness, mat.metalness]))
    g.setAttribute('aEm', fill(3, [glow.r, glow.g, glow.b]))
    g.setAttribute('skinIndex', fill(4, [i, 0, 0, 0], Uint16Array))
    g.setAttribute('skinWeight', fill(4, [1, 0, 0, 0]))
    g.clearGroups()
    geos.push(g)
  }
  const merged = mergeGeometries(geos, false)
  geos.forEach(g => g.dispose())
  if (!merged) return null
  const material = new THREE.MeshStandardMaterial({ vertexColors: true })
  perVertexLook(material, true)
  const mesh = new THREE.SkinnedMesh(merged, material)
  mesh.name = 'rig_merged'
  mesh.castShadow = pieces[0].castShadow
  mesh.receiveShadow = pieces[0].receiveShadow
  mesh.frustumCulled = false
  root.add(mesh)
  mesh.updateMatrixWorld(true)
  // the pieces are the bones; their world matrices now are the bind pose
  const skeleton = new THREE.Skeleton(pieces as unknown as THREE.Bone[])
  mesh.bind(skeleton, mesh.matrixWorld.clone())
  const hidden = new THREE.MeshBasicMaterial({ visible: false })
  for (const p of pieces) {
    p.material = hidden
    p.castShadow = false
  }
  return mesh
}
