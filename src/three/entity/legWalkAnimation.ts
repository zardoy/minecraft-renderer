import * as THREE from 'three'

export const LEG_RIG_USER_DATA_KEY = '_legRig'
export const LEG_ANIMATION_USER_DATA_KEY = '_legAnimation'

/** Vanilla ModelBiped / ModelQuadruped constants. */
export const LEG_SWING_FREQUENCY = 0.6662
export const LEG_SWING_AMPLITUDE = 1.4

/** Entities whose legs are not driven by ground walking (fly, hop, swim or use bespoke animations). */
const LEG_ANIMATION_EXCLUDED = new Set([
  'armor_stand',
  'axolotl',
  'ender_dragon',
  'frog',
  'parrot',
  'rabbit',
  'turtle'
])

const LEG_NAME_PATTERN = /leg/i

type BoneLeg = {
  kind: 'bone'
  bone: THREE.Bone
  /** Pivot in mesh space, the point the vertices were authored around. */
  pivot: THREE.Vector3
  /** Parent bone matrix relative to the skinned mesh at bind time. */
  parentMatrix: THREE.Matrix4
  parentMatrixInverse: THREE.Matrix4
  /** Local bone matrix at bind time. */
  restMatrix: THREE.Matrix4
}

type MeshLeg = {
  kind: 'mesh'
  meshes: THREE.Mesh[]
  restRotationX: number[]
}

export type LegRigLeg = (BoneLeg | MeshLeg) & { phase: number }

export type LegRig = {
  legs: LegRigLeg[]
  /** True while legs are rotated away from rest, so settling back is written exactly once. */
  posed: boolean
}

type LegCandidate = { name: string; pivot: THREE.Vector3; build: (phase: number) => LegRigLeg }

/** Vanilla leg swing angle (radians around the model X axis). */
export function calculateLegSwing(limbSwing: number, limbSwingAmount: number, phase: number): number {
  const amount = Number.isFinite(limbSwingAmount) ? Math.max(0, limbSwingAmount) : 0
  if (amount === 0 || !Number.isFinite(limbSwing)) return 0
  return Math.cos(limbSwing * LEG_SWING_FREQUENCY + phase) * LEG_SWING_AMPLITUDE * amount
}

/**
 * Diagonal pairs move together on four legged mobs and opposite legs alternate on bipeds.
 * Derived from pivot positions so it works for any bone naming (leg0, rightLeg, left_hind_leg...).
 * Returns the phase offset per candidate, or undefined if the leg layout isn't recognised.
 */
export function assignLegPhases(pivots: Array<{ x: number; z: number }>): number[] | undefined {
  if (pivots.length !== 2 && pivots.length !== 4) return undefined

  const meanX = pivots.reduce((sum, p) => sum + p.x, 0) / pivots.length
  const meanZ = pivots.reduce((sum, p) => sum + p.z, 0) / pivots.length
  const xs = pivots.map(p => p.x - meanX)
  const zs = pivots.map(p => p.z - meanZ)
  const xSpread = Math.max(...xs) - Math.min(...xs)
  const zSpread = Math.max(...zs) - Math.min(...zs)

  // Legs side by side: alternate left/right.
  if (pivots.length === 2 || zSpread < xSpread * 0.5) {
    if (xSpread === 0) return undefined
    return xs.map(x => (x > 0 ? 0 : Math.PI))
  }

  if (xSpread === 0) return undefined
  return xs.map((x, i) => (x > 0 === zs[i] > 0 ? 0 : Math.PI))
}

function collectBoneCandidates(skinned: THREE.SkinnedMesh): LegCandidate[] {
  skinned.updateWorldMatrix(true, true)
  const meshInverse = skinned.matrixWorld.clone().invert()
  const candidates: LegCandidate[] = []
  for (const bone of skinned.skeleton.bones) {
    const name = bone.name.replace(/^bone_/, '')
    if (!LEG_NAME_PATTERN.test(name)) continue
    // Sub-bones such as `Leg1B` hang off the same pivot and would be double counted.
    if (/^leg\d[b-z]$/i.test(name)) continue
    const pivot = bone.position.clone()
    const parentMatrix = bone.parent instanceof THREE.Bone ? meshInverse.clone().multiply(bone.parent.matrixWorld) : new THREE.Matrix4()
    candidates.push({
      name,
      pivot,
      build: phase => ({
        kind: 'bone',
        phase,
        bone,
        pivot,
        parentMatrix,
        parentMatrixInverse: parentMatrix.clone().invert(),
        restMatrix: bone.matrix.clone()
      })
    })
  }
  return candidates
}

function collectMeshCandidates(root: THREE.Object3D): LegCandidate[] {
  const groups = new Map<string, THREE.Mesh[]>()
  for (const child of root.children) {
    if (!(child instanceof THREE.Mesh) || child instanceof THREE.SkinnedMesh) continue
    if (!LEG_NAME_PATTERN.test(child.name)) continue
    const group = groups.get(child.name)
    if (group) group.push(child)
    else groups.set(child.name, [child])
  }

  const candidates: LegCandidate[] = []
  for (const [name, meshes] of groups) {
    // Overlay layers share a name, so the pivot is the union of them.
    const box = new THREE.Box3()
    for (const mesh of meshes) {
      mesh.updateMatrix()
      mesh.geometry.computeBoundingBox()
      box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrix))
    }
    // Legs hang from the top of their box and swing around it.
    const pivot = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2)
    candidates.push({
      name,
      pivot,
      build: phase => {
        for (const mesh of meshes) {
          mesh.geometry.translate(-pivot.x, -pivot.y, -pivot.z)
          mesh.position.add(pivot)
        }
        return { kind: 'mesh', phase, meshes, restRotationX: meshes.map(mesh => mesh.rotation.x) }
      }
    })
  }
  return candidates
}

function buildLegs(candidates: LegCandidate[]): LegRigLeg[] {
  const phases = assignLegPhases(candidates.map(c => c.pivot))
  if (!phases) return []
  return candidates.map((candidate, i) => candidate.build(phases[i]))
}

/**
 * Finds the legs of a mob model (bedrock bones or OBJ parts) and prepares them to be swung
 * around their pivots. Returns undefined when the model has no recognisable 2 or 4 leg layout.
 */
export function createLegRig(root: THREE.Object3D, entityName?: string): LegRig | undefined {
  if (entityName && LEG_ANIMATION_EXCLUDED.has(entityName)) return undefined

  const legs: LegRigLeg[] = []
  root.traverse(child => {
    if (child instanceof THREE.SkinnedMesh) legs.push(...buildLegs(collectBoneCandidates(child)))
  })
  legs.push(...buildLegs(collectMeshCandidates(root)))

  if (legs.length === 0) return undefined
  return { legs, posed: false }
}

const tmpPivotMatrix = new THREE.Matrix4()
const tmpRotation = new THREE.Matrix4()
const tmpDeform = new THREE.Matrix4()
const tmpLocal = new THREE.Matrix4()

function applyBoneLeg(leg: BoneLeg, angle: number): void {
  // Skinning deforms vertices by D = T(pivot) * Rx * T(-pivot) in mesh space. Bones are parented with absolute
  // pivots, so the local rotation is conjugated by the parent bind matrix to produce exactly that deformation.
  tmpDeform.makeTranslation(leg.pivot.x, leg.pivot.y, leg.pivot.z)
  tmpDeform.multiply(tmpRotation.makeRotationX(angle))
  tmpDeform.multiply(tmpPivotMatrix.makeTranslation(-leg.pivot.x, -leg.pivot.y, -leg.pivot.z))

  tmpLocal.copy(leg.parentMatrixInverse).multiply(tmpDeform).multiply(leg.parentMatrix).multiply(leg.restMatrix)
  tmpLocal.decompose(leg.bone.position, leg.bone.quaternion, leg.bone.scale)
}

/** Poses all legs of the rig. Cheap no-op while the mob stays still. */
export function applyLegRig(rig: LegRig, limbSwing: number, limbSwingAmount: number): void {
  const moving = Number.isFinite(limbSwingAmount) && limbSwingAmount >= 1e-4
  if (!moving && !rig.posed) return
  rig.posed = moving

  for (const leg of rig.legs) {
    const angle = moving ? calculateLegSwing(limbSwing, limbSwingAmount, leg.phase) : 0
    if (leg.kind === 'bone') {
      applyBoneLeg(leg, angle)
    } else {
      for (const [i, mesh] of leg.meshes.entries()) mesh.rotation.x = leg.restRotationX[i] + angle
    }
  }
}
