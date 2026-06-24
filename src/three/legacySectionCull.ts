import * as THREE from 'three'
import type { RenderOrigin } from './shaders/legacyBlockShader'

/** Half-extent of a section mesh AABB in section-local space. */
export const LEGACY_SECTION_HALF_EXTENT = 8

/** Small pad on camera-relative section AABBs for frustum tests. */
const CULL_BOX_EPSILON = 0.01

/**
 * Set a legacy section mesh world translation once at build time.
 * Position proxy is not used — camera-relative math lives in the shader.
 */
export function setupLegacySectionMatrix(mesh: THREE.Mesh, sx: number, sy: number, sz: number, renderOrigin: RenderOrigin): void {
  mesh.matrix.makeTranslation(sx - renderOrigin.x, sy - renderOrigin.y, sz - renderOrigin.z)
  mesh.matrixWorldNeedsUpdate = true
  mesh.frustumCulled = false
}

export function sectionIntersectsFrustum(
  sectionWorldX: number,
  sectionWorldY: number,
  sectionWorldZ: number,
  cameraWorldX: number,
  cameraWorldY: number,
  cameraWorldZ: number,
  frustum: THREE.Frustum,
  box: THREE.Box3,
  boxMin: THREE.Vector3,
  boxMax: THREE.Vector3
): { visible: boolean; distSq: number } {
  const dx = sectionWorldX - cameraWorldX
  const dy = sectionWorldY - cameraWorldY
  const dz = sectionWorldZ - cameraWorldZ

  const half = LEGACY_SECTION_HALF_EXTENT + CULL_BOX_EPSILON
  boxMin.set(dx - half, dy - half, dz - half)
  boxMax.set(dx + half, dy + half, dz + half)
  box.set(boxMin, boxMax)

  return {
    visible: frustum.intersectsBox(box),
    distSq: dx * dx + dy * dy + dz * dz
  }
}

/**
 * Per-frame frustum cull + back-to-front renderOrder for one legacy section.
 * Used for pooled per-section meshes (reveal defer + invariant fallback).
 */
export function updateLegacySectionCullState(
  mesh: THREE.Mesh,
  sectionWorldX: number,
  sectionWorldY: number,
  sectionWorldZ: number,
  cameraWorldX: number,
  cameraWorldY: number,
  cameraWorldZ: number,
  frustum: THREE.Frustum,
  box: THREE.Box3,
  boxMin: THREE.Vector3,
  boxMax: THREE.Vector3
): void {
  const { visible, distSq } = sectionIntersectsFrustum(
    sectionWorldX,
    sectionWorldY,
    sectionWorldZ,
    cameraWorldX,
    cameraWorldY,
    cameraWorldZ,
    frustum,
    box,
    boxMin,
    boxMax
  )
  mesh.visible = visible
  mesh.renderOrder = -distSq
}
