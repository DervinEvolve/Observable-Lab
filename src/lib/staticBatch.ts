import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

// Static batching for the furniture of the room. The lab shell, set dressing
// and desks are hundreds of small meshes that never move; merging the ones
// that can share a draw call into a single mesh cuts hundreds of draw calls
// without changing what is drawn.
//
// Three families:
//  - brass and wood keep one material each (the patina system ages them by
//    material: brass colour and roughness, wood roughness). Each part's own
//    tint is baked into vertex colours relative to that material colour, so
//    the patina still moves all of them together.
//  - everything else plain and opaque bakes colour, roughness and metalness
//    into vertex attributes, so parts that differ only in those share one
//    draw call (the material reads them per vertex).
//  - textured materials merge only with the same texture.

// (the wall clock's frame batches with the room's brass and wood; its display,
// the only part that changes, has a texture of its own and stays apart)
const SKIP_NAMES = new Set(['corkboard'])
const BRASS_REF = new THREE.Color(0xb5a642)
const WOOD_REF = new THREE.Color(0x8b7355)

type Family = 'brass' | 'wood' | 'plain' | 'mapped' | 'basic'

function familyOf(hex: number): 'brass' | 'wood' | null {
  if (hex >= 0x8a7000 && hex <= 0xd0c000) return 'brass'
  if (hex >= 0x5a4030 && hex <= 0xa08060) return 'wood'
  return null
}

function materialKey(m: THREE.Material): { key: string; family: Family } | null {
  if (!(m instanceof THREE.MeshStandardMaterial) && !(m instanceof THREE.MeshBasicMaterial)) return null
  if (m.alphaTest > 0 || !m.visible || m.vertexColors) return null
  // see-through and physical parts merge only with exact twins (same look in every respect)
  if (m.transparent || m instanceof THREE.MeshPhysicalMaterial) {
    if (m.map || !(m instanceof THREE.MeshStandardMaterial)) return null
    const ph = m instanceof THREE.MeshPhysicalMaterial ? [m.transmission, m.ior, m.thickness, m.clearcoat, m.clearcoatRoughness] : []
    return { key: ['twin', m.type, m.color.getHex(), m.opacity, m.transparent, m.depthWrite, m.roughness, m.metalness, m.side, m.emissive.getHex(), m.emissiveIntensity, ...ph].join('|'), family: 'mapped' }
  }
  const hex = m.color.getHex()
  if (m instanceof THREE.MeshBasicMaterial) {
    return m.map ? { key: `basic-map|${m.map.uuid}|${m.side}|${hex}`, family: 'mapped' } : { key: `basic|${m.side}`, family: 'basic' }
  }
  const glow = `${m.emissive.getHex()}|${m.emissiveIntensity}`
  const shared = [m.side, m.flatShading, m.emissiveMap?.uuid ?? '', m.normalMap?.uuid ?? '', m.roughnessMap?.uuid ?? '', m.metalnessMap?.uuid ?? ''].join('|')
  if (m.map || m.emissiveMap || m.normalMap) return { key: `map|${m.map?.uuid ?? ''}|${hex}|${m.roughness}|${m.metalness}|${glow}|${shared}`, family: 'mapped' }
  const fam = familyOf(hex)
  // brass keeps its glow in the key; wood and plain parts carry it per vertex
  if (fam === 'brass') return { key: `brass|${glow}|${shared}`, family: fam }
  if (fam === 'wood') return { key: `wood|${shared}`, family: fam }
  if (m.roughnessMap || m.metalnessMap) return { key: `plainmaps|${hex}|${m.roughness}|${m.metalness}|${glow}|${shared}`, family: 'mapped' }
  return { key: `plain|${shared}`, family: 'plain' }
}

function prepare(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, needUv: boolean, colour: THREE.Color | null, rm: [number, number] | null, glow: THREE.Color | null): THREE.BufferGeometry | null {
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
  const n = g.getAttribute('position').count
  if (colour) {
    const c = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.set([colour.r, colour.g, colour.b], i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  }
  if (rm) {
    const a = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) a.set(rm, i * 2)
    g.setAttribute('aRM', new THREE.BufferAttribute(a, 2))
  }
  if (glow) {
    const e = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) e.set([glow.r, glow.g, glow.b], i * 3)
    g.setAttribute('aEm', new THREE.BufferAttribute(e, 3))
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

// Glow (and for plain parts roughness and metalness) from vertex attributes
// instead of the material.
export function perVertexLook(mat: THREE.MeshStandardMaterial, rm: boolean): void {
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 aEm;\nvarying vec3 vEm;\n${rm ? 'attribute vec2 aRM;\nvarying vec2 vRM;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvEm = aEm;\n${rm ? 'vRM = aRM;' : ''}`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vEm;\n${rm ? 'varying vec2 vRM;' : ''}`)
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = vEm;')
    if (rm) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;')
    }
  }
  mat.customProgramCacheKey = () => (rm ? 'batched-look-rm' : 'batched-look')
}

/** Merges the static meshes under `root`. Returns draw calls before and after. */
export function batchStatic(root: THREE.Object3D): { before: number; after: number } {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map<string, { family: Family; meshes: THREE.Mesh[] }>()
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
    else groups.set(full, { family: mk.family, meshes: [o] })
  })

  let removed = 0
  let added = 0
  for (const { family, meshes } of groups.values()) {
    if (meshes.length < 2) continue
    const first = meshes[0].material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
    const needUv = !!first.map
    let mat: THREE.Material = first
    const ref = family === 'brass' ? BRASS_REF : family === 'wood' ? WOOD_REF : null
    if (family === 'plain') {
      const f = first as THREE.MeshStandardMaterial
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: f.side, flatShading: f.flatShading })
      perVertexLook(m, true)
      mat = m
    } else if (family === 'basic') {
      const m = (first as THREE.MeshBasicMaterial).clone()
      m.color.set(0xffffff)
      m.vertexColors = true
      mat = m
    } else if (ref) {
      const m = (first as THREE.MeshStandardMaterial).clone()
      m.color.copy(ref)
      m.vertexColors = true
      if (family === 'wood') perVertexLook(m, false)
      mat = m
    }
    const geos: THREE.BufferGeometry[] = []
    const used: THREE.Mesh[] = []
    for (const mesh of meshes) {
      const src = mesh.material as THREE.MeshStandardMaterial
      let colour: THREE.Color | null = null
      let rm: [number, number] | null = null
      let glow: THREE.Color | null = null
      if (family === 'plain' || family === 'wood') glow = src.emissive.clone().multiplyScalar(src.emissiveIntensity)
      if (family === 'plain') {
        colour = src.color
        rm = [src.roughness, src.metalness]
      } else if (family === 'basic') {
        colour = src.color
      } else if (ref) {
        colour = new THREE.Color(src.color.r / ref.r, src.color.g / ref.g, src.color.b / ref.b)
      }
      const g = prepare(mesh.geometry, new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld), needUv, colour, rm, glow)
      if (g) {
        geos.push(g)
        used.push(mesh)
      }
    }
    if (geos.length < 2) continue
    const merged = mergeGeometries(geos, false)
    geos.forEach(g => g.dispose())
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = family === 'wood' ? 'batched_wood' : 'batched'
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

