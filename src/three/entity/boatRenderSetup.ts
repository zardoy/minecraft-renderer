import * as THREE from 'three'
import { BOAT_MESH_YAW_OFFSET } from './boatModelRotation'

/** Vanilla BoatModel.createWaterPatch() size in blocks (after X rotation). */
export const BOAT_WATER_PATCH_WIDTH = 28 / 16
export const BOAT_WATER_PATCH_HEIGHT = 3 / 16
export const BOAT_WATER_PATCH_DEPTH = 16 / 16

/** OBJ boat root offset applied in EntityMesh (single source — import from here, do not duplicate). */
export const BOAT_OBJ_OFFSET_Y = -1.125

/**
 * Vanilla 1.17.1 water patch center in OBJ-local space.
 * Tuned with BOAT_OBJ_OFFSET_Y so entity-space bounds stay Y [0.375, 0.5625].
 */
export const BOAT_WATER_PATCH_CENTER_Y = 1.59375
export const BOAT_WATER_PATCH_CENTER_Z = 0

export const BOAT_WATER_PATCH_WORLD_BOUNDS = {
  minX: -0.875,
  maxX: 0.875,
  minY: 0.375,
  maxY: 0.5625,
  minZ: -0.5,
  maxZ: 0.5
} as const

export const BOAT_HULL_RENDER_ORDER = 0
export const BOAT_WATER_PATCH_RENDER_ORDER = 1

export const BOAT_WATER_PATCH_NAME = 'boat_water_patch'

export const BOAT_PADDLE_PIVOT_LEFT_NAME = 'boat_paddle_pivot_left'
export const BOAT_PADDLE_PIVOT_RIGHT_NAME = 'boat_paddle_pivot_right'

/** Original handoff pivot (rotation center only — geometry stays aft if used alone). */
export const BOAT_PADDLE_SOURCE_LEFT = new THREE.Vector3(3 / 16, 28 / 16, 9 / 16)
export const BOAT_PADDLE_SOURCE_RIGHT = new THREE.Vector3(3 / 16, 28 / 16, -9 / 16)

/** Root-local shift applied to paddle mesh together with the pivot move. */
export const BOAT_PADDLE_GEOMETRY_DELTA = new THREE.Vector3(-6 / 16, 1 / 16, 0)

/** Vanilla 1.17.1 oarlock positions in OBJ-local blocks (after geometry delta). */
export const BOAT_PADDLE_LEFT_PIVOT = new THREE.Vector3(-3 / 16, 29 / 16, 9 / 16)
export const BOAT_PADDLE_RIGHT_PIVOT = new THREE.Vector3(-3 / 16, 29 / 16, -9 / 16)

/** Entity-space mapping for OBJ-local points (mesh `rotation.y = −π/2`, `BOAT_OBJ_OFFSET_Y`). */
export function boatObjLocalToEntitySpace(objX: number, objY: number, objZ: number): THREE.Vector3 {
  return new THREE.Vector3(-objZ, objY + BOAT_OBJ_OFFSET_Y, objX)
}

const _rootLocalPos = new THREE.Vector3()

function getRootLocalPosition(object: THREE.Object3D, root: THREE.Object3D): THREE.Vector3 {
  _rootLocalPos.set(0, 0, 0)
  let current: THREE.Object3D | null = object
  while (current && current !== root) {
    _rootLocalPos.add(current.position)
    current = current.parent
  }
  return _rootLocalPos
}

function createBoatPaddlePivot(
  root: THREE.Object3D,
  pivotName: string,
  sourcePivot: THREE.Vector3,
  targetPivot: THREE.Vector3,
  paddleMeshes: THREE.Object3D[]
): THREE.Object3D | undefined {
  if (paddleMeshes.length === 0) return undefined

  const pivot = new THREE.Object3D()
  pivot.name = pivotName
  pivot.position.copy(targetPivot)
  root.add(pivot)

  for (const mesh of paddleMeshes) {
    const parent = mesh.parent
    if (!parent) continue
    const rootLocal = getRootLocalPosition(mesh, root)
    parent.remove(mesh)
    // Offset from source oarlock; pivot sits at target so root-local geometry shifts by delta.
    mesh.position.copy(rootLocal).sub(sourcePivot)
    pivot.add(mesh)
  }

  return pivot
}

function collectBoatPaddleMeshes(root: THREE.Object3D, sideName: 'paddle_left' | 'paddle_right'): THREE.Object3D[] {
  const meshes: THREE.Object3D[] = []
  root.traverse(child => {
    if (child === root) return
    if (child.name === BOAT_WATER_PATCH_NAME) return
    if (child.name === BOAT_PADDLE_PIVOT_LEFT_NAME || child.name === BOAT_PADDLE_PIVOT_RIGHT_NAME) return
    if (child.name === sideName) meshes.push(child)
  })
  return meshes
}

export function setupBoatPaddlePivots(root: THREE.Object3D): {
  leftPivot?: THREE.Object3D
  rightPivot?: THREE.Object3D
} {
  if (root.userData.boatPaddleLeftPivot || root.userData.boatPaddleRightPivot) {
    return {
      leftPivot: root.userData.boatPaddleLeftPivot as THREE.Object3D | undefined,
      rightPivot: root.userData.boatPaddleRightPivot as THREE.Object3D | undefined
    }
  }

  const leftPivot = createBoatPaddlePivot(
    root,
    BOAT_PADDLE_PIVOT_LEFT_NAME,
    BOAT_PADDLE_SOURCE_LEFT,
    BOAT_PADDLE_LEFT_PIVOT,
    collectBoatPaddleMeshes(root, 'paddle_left')
  )
  const rightPivot = createBoatPaddlePivot(
    root,
    BOAT_PADDLE_PIVOT_RIGHT_NAME,
    BOAT_PADDLE_SOURCE_RIGHT,
    BOAT_PADDLE_RIGHT_PIVOT,
    collectBoatPaddleMeshes(root, 'paddle_right')
  )

  if (leftPivot) root.userData.boatPaddleLeftPivot = leftPivot
  if (rightPivot) root.userData.boatPaddleRightPivot = rightPivot

  return { leftPivot, rightPivot }
}

export function getBoatMeshYawOffset(): number {
  return BOAT_MESH_YAW_OFFSET
}

export function createBoatWaterPatchGeometry(): THREE.BoxGeometry {
  return new THREE.BoxGeometry(BOAT_WATER_PATCH_WIDTH, BOAT_WATER_PATCH_HEIGHT, BOAT_WATER_PATCH_DEPTH)
}

export function createBoatWaterPatchMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true
  })
}

export function createBoatWaterPatchMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(createBoatWaterPatchGeometry(), createBoatWaterPatchMaterial())
  mesh.name = BOAT_WATER_PATCH_NAME
  mesh.position.set(0, BOAT_WATER_PATCH_CENTER_Y, BOAT_WATER_PATCH_CENTER_Z)
  mesh.renderOrder = BOAT_WATER_PATCH_RENDER_ORDER
  return mesh
}

export function applyBoatHullRenderSettings(root: THREE.Object3D): void {
  root.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return
    if (child.name === BOAT_WATER_PATCH_NAME) return
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!(material instanceof THREE.Material)) continue
      material.transparent = false
      material.depthWrite = true
      material.depthTest = true
      if ('alphaTest' in material) {
        material.alphaTest = Math.max(material.alphaTest ?? 0, 0.1)
      }
      material.needsUpdate = true
    }
    child.renderOrder = BOAT_HULL_RENDER_ORDER
  })
}

export function getBoatWaterPatchEntitySpaceBounds(objOffsetY = BOAT_OBJ_OFFSET_Y) {
  const centerY = objOffsetY + BOAT_WATER_PATCH_CENTER_Y
  const halfHeight = BOAT_WATER_PATCH_HEIGHT / 2
  const halfWidth = BOAT_WATER_PATCH_WIDTH / 2
  const halfDepth = BOAT_WATER_PATCH_DEPTH / 2
  return {
    minX: -halfWidth,
    maxX: halfWidth,
    minY: centerY - halfHeight,
    maxY: centerY + halfHeight,
    minZ: BOAT_WATER_PATCH_CENTER_Z - halfDepth,
    maxZ: BOAT_WATER_PATCH_CENTER_Z + halfDepth
  }
}

export function setupBoatMesh(root: THREE.Object3D): { waterPatch: THREE.Mesh } {
  applyBoatHullRenderSettings(root)
  setupBoatPaddlePivots(root)
  let waterPatch = root.userData.boatWaterPatch as THREE.Mesh | undefined
  if (!waterPatch) {
    waterPatch = createBoatWaterPatchMesh()
    waterPatch.visible = false
    root.add(waterPatch)
    root.userData.boatWaterPatch = waterPatch
  }
  return { waterPatch }
}

export function disposeBoatWaterPatch(root: THREE.Object3D): void {
  const patch = root.userData.boatWaterPatch as THREE.Mesh | undefined
  if (!patch) return
  patch.geometry.dispose()
  if (patch.material instanceof THREE.Material) {
    patch.material.dispose()
  }
  delete root.userData.boatWaterPatch
}
