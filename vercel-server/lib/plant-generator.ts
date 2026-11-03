import type { AgentSpecification, PlantGeometry, PlantNode, ConflictMarker } from '../../src/shared/types'

interface PlantConfig {
  trunkBaseRadius: number
  trunkHeight: number
  branchLength: number
  leafSize: number
}

// Normalize a vector to unit length
function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  if (len === 0) return [0, 1, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

// Seeded random for deterministic generation based on spec
function seededRandom(seed: string): () => number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return () => {
    hash = (hash * 1103515245 + 12345) & 0x7fffffff
    return hash / 0x7fffffff
  }
}

// Generate plant geometry from agent specification
export function generatePlantFromSpec(spec: AgentSpecification): PlantGeometry {
  // Create seeded random based on spec content for deterministic output
  const random = seededRandom(JSON.stringify(spec.identity) + spec.meta.total_epochs)

  const config: PlantConfig = {
    trunkBaseRadius: 0.08 + spec.meta.stability_score * 0.07, // 0.08-0.15 based on stability
    trunkHeight: 0.3 + spec.meta.total_epochs * 0.015, // Grows taller over time
    branchLength: 0.25,
    leafSize: 0.04,
  }

  // Cap trunk height to reasonable maximum
  config.trunkHeight = Math.min(config.trunkHeight, 1.2)

  const nodes: PlantNode[] = []

  // === TRUNK ===
  // Thickness based on purpose clarity (do they have a defined domain?)
  const purposeClarity = spec.identity.domain ? 1.0 : 0.6
  const trunk: PlantNode = {
    type: 'trunk',
    position: [0, 0, 0],
    direction: [0, 1, 0],
    thickness: config.trunkBaseRadius * purposeClarity,
    length: config.trunkHeight,
    health: spec.meta.stability_score,
    children: [],
  }
  nodes.push(trunk)

  // === BRANCHES (from capabilities) ===
  const activeCapabilities = spec.capabilities.filter(c => c.status === 'active')
  activeCapabilities.forEach((capability, index) => {
    const totalCaps = activeCapabilities.length
    const angle = (index / Math.max(totalCaps, 1)) * Math.PI * 2 // Evenly distributed
    const height = 0.35 + index * 0.12 // Stagger heights
    const heightCapped = Math.min(height, config.trunkHeight * 0.9)

    // Branch direction: outward and slightly up
    const direction: [number, number, number] = normalize([
      Math.cos(angle) * 0.7,
      0.4 + random() * 0.2,
      Math.sin(angle) * 0.7,
    ])

    // Check if this capability has conflicts
    const hasConflict = spec.conflicts.some(
      c =>
        !c.resolved &&
        (c.element_a.includes(capability.id) || c.element_b.includes(capability.id))
    )

    const branch: PlantNode = {
      type: 'branch',
      position: [0, heightCapped, 0],
      direction,
      thickness: config.trunkBaseRadius * 0.5,
      length: config.branchLength * (0.8 + random() * 0.4),
      health: hasConflict ? 0.4 : 1.0,
      specReference: `capabilities.${capability.id}`,
      children: [],
    }

    // === LEAVES (from behaviors linked to this capability) ===
    const linkedBehaviors = spec.behaviors.filter(
      b => b.status === 'active' && b.capability_id === capability.id
    )
    linkedBehaviors.forEach((behavior, leafIndex) => {
      const leafPosition: [number, number, number] = [
        branch.length * (0.3 + leafIndex * 0.2),
        0,
        (random() - 0.5) * 0.1,
      ]
      const leafDirection: [number, number, number] = normalize([
        random() - 0.5,
        0.5,
        random() - 0.5,
      ])

      branch.children.push({
        type: 'leaf',
        position: leafPosition,
        direction: leafDirection,
        thickness: 0,
        length: config.leafSize,
        health: hasConflict ? 0.5 : 1.0,
        specReference: `behaviors.${behavior.id}`,
        children: [],
      })
    })

    // Also add some leaves for behaviors without explicit capability links
    const unlinkedBehaviors = spec.behaviors.filter(
      b => b.status === 'active' && !b.capability_id
    )
    // Distribute unlinked behaviors across branches
    const behaviorsForThisBranch = unlinkedBehaviors.filter(
      (_, i) => i % totalCaps === index
    )
    behaviorsForThisBranch.forEach((behavior, leafIndex) => {
      const offset = linkedBehaviors.length
      branch.children.push({
        type: 'leaf',
        position: [
          branch.length * (0.4 + (offset + leafIndex) * 0.15),
          (random() - 0.5) * 0.05,
          (random() - 0.5) * 0.1,
        ],
        direction: normalize([random() - 0.5, 0.6, random() - 0.5]),
        thickness: 0,
        length: config.leafSize * 0.8,
        health: 0.8,
        specReference: `behaviors.${behavior.id}`,
        children: [],
      })
    })

    trunk.children.push(branch)
  })

  // === PRUNED BRANCHES (stumps for pruned capabilities) ===
  const prunedCapabilities = spec.capabilities.filter(c => c.status === 'pruned')
  prunedCapabilities.forEach((capability, index) => {
    const totalPruned = prunedCapabilities.length
    const angle = ((index + 0.5) / Math.max(totalPruned, 1)) * Math.PI * 2
    const height = 0.25 + index * 0.1

    trunk.children.push({
      type: 'branch',
      position: [0, Math.min(height, config.trunkHeight * 0.7), 0],
      direction: normalize([Math.cos(angle) * 0.8, 0.2, Math.sin(angle) * 0.8]),
      thickness: config.trunkBaseRadius * 0.3,
      length: 0.05, // Stump
      health: 0.2, // Brown/dead
      specReference: `capabilities.${capability.id}`,
      children: [],
    })
  })

  // === ROOTS (from constraints) ===
  const activeConstraints = spec.constraints.filter(c => c.status === 'active')
  activeConstraints.forEach((constraint, index) => {
    const totalConstraints = activeConstraints.length
    const angle = (index / Math.max(totalConstraints, 1)) * Math.PI * 2

    // Must_not constraints are more prominent
    const lengthMultiplier = constraint.type === 'must_not' ? 1.2 : 1.0

    nodes.push({
      type: 'root',
      position: [0, 0, 0],
      direction: normalize([
        Math.cos(angle) * 0.8,
        -0.5,
        Math.sin(angle) * 0.8,
      ]),
      thickness: config.trunkBaseRadius * 0.3,
      length: 0.15 * lengthMultiplier,
      health: 1.0,
      specReference: `constraints.${constraint.id}`,
      children: [],
    })
  })

  // === CONFLICT MARKERS ===
  const unresolvedConflicts = spec.conflicts.filter(c => !c.resolved)
  const conflictMarkers: ConflictMarker[] = unresolvedConflicts.map(conflict => {
    // Try to find position based on conflicting elements
    const position = findConflictPosition(trunk, conflict, random)
    return {
      position,
      severity: conflict.severity,
      description: conflict.description,
    }
  })

  // === APPLY STABILITY POSTURE ===
  // Low stability = leaning/drooping
  if (spec.meta.stability_score < 0.5) {
    const lean = (0.5 - spec.meta.stability_score) * 0.3
    trunk.direction = normalize([lean, 1 - lean * 0.5, lean * 0.5])
  }

  return {
    nodes,
    conflictMarkers,
    overallHealth: spec.meta.stability_score,
    growthStage: spec.meta.growth_stage,
  }
}

// Find where to place a conflict marker on the plant
function findConflictPosition(
  trunk: PlantNode,
  conflict: { element_a: string; element_b: string },
  random: () => number
): [number, number, number] {
  // Try to find the branch that corresponds to one of the conflicting elements
  for (const child of trunk.children) {
    if (
      child.specReference &&
      (conflict.element_a.includes(child.specReference) ||
        conflict.element_b.includes(child.specReference))
    ) {
      // Place conflict marker partway along this branch
      const t = 0.3 + random() * 0.4
      return [
        child.position[0] + child.direction[0] * child.length * t,
        child.position[1] + child.direction[1] * child.length * t,
        child.position[2] + child.direction[2] * child.length * t,
      ]
    }
  }

  // Default: somewhere on the trunk
  return [
    (random() - 0.5) * 0.1,
    0.3 + random() * 0.4,
    (random() - 0.5) * 0.1,
  ]
}

// Generate plant geometry for seed specification (minimal plant)
export function generateSeedPlant(): PlantGeometry {
  return {
    nodes: [
      {
        type: 'trunk',
        position: [0, 0, 0],
        direction: [0, 1, 0],
        thickness: 0.05,
        length: 0.15,
        health: 0.5,
        children: [],
      },
    ],
    conflictMarkers: [],
    overallHealth: 0.5,
    growthStage: 'seed',
  }
}
