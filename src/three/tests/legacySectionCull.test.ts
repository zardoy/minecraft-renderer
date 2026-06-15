import { test, expect } from 'vitest'
import * as THREE from 'three'
import { sectionIntersectsFrustum, setupLegacySectionMatrix, updateLegacySectionCullState } from '../legacySectionCull'

test('setupLegacySectionMatrix: translation set once and stable across frames', () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.matrixAutoUpdate = false

  setupLegacySectionMatrix(mesh, 100, 64, -200, { x: 0, y: 0, z: 0 })

  expect(mesh.matrix.elements[12]).toBe(100)
  expect(mesh.matrix.elements[13]).toBe(64)
  expect(mesh.matrix.elements[14]).toBe(-200)
  expect(mesh.frustumCulled).toBe(false)

  const before = mesh.matrix.elements.slice()
  // No per-frame matrix write in 2a — matrix must stay unchanged across frames.
  expect(mesh.matrix.elements.slice()).toEqual(before)
})

test('updateLegacySectionCullState: frustum hit sets visible and nearer section sorts later', () => {
  const meshNear = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const meshFar = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())

  const frustum = { intersectsBox: () => true } as unknown as THREE.Frustum

  const box = new THREE.Box3()
  const boxMin = new THREE.Vector3()
  const boxMax = new THREE.Vector3()

  updateLegacySectionCullState(meshNear, 0, 0, 0, 0, 0, 0, frustum, box, boxMin, boxMax)
  updateLegacySectionCullState(meshFar, 32, 0, 0, 0, 0, 0, frustum, box, boxMin, boxMax)

  expect(meshNear.visible).toBe(true)
  expect(meshFar.visible).toBe(true)
  expect(meshFar.renderOrder).toBeLessThan(meshNear.renderOrder)
})

test('sectionIntersectsFrustum: returns distSq and visibility', () => {
  const frustum = { intersectsBox: () => true } as unknown as THREE.Frustum
  const box = new THREE.Box3()
  const boxMin = new THREE.Vector3()
  const boxMax = new THREE.Vector3()

  const result = sectionIntersectsFrustum(10, 0, 0, 0, 0, 0, frustum, box, boxMin, boxMax)
  expect(result.visible).toBe(true)
  expect(result.distSq).toBe(100)
})

test('updateLegacySectionCullState: outside frustum hides mesh', () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const frustum = new THREE.Frustum()
  const proj = new THREE.Matrix4()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 0)
  camera.lookAt(0, 0, -1)
  camera.updateMatrixWorld()
  proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(proj)

  const box = new THREE.Box3()
  const boxMin = new THREE.Vector3()
  const boxMax = new THREE.Vector3()

  updateLegacySectionCullState(mesh, 500, 0, 0, 0, 0, 0, frustum, box, boxMin, boxMax)

  expect(mesh.visible).toBe(false)
})

test('setupLegacySectionMatrix: non-zero render origin stores world minus R', () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.matrixAutoUpdate = false

  setupLegacySectionMatrix(mesh, 100, 64, -200, { x: 16, y: 0, z: 16 })

  expect(mesh.matrix.elements[12]).toBe(84)
  expect(mesh.matrix.elements[13]).toBe(64)
  expect(mesh.matrix.elements[14]).toBe(-216)
})
