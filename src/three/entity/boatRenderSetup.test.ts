import * as THREE from 'three'
import { expect, test } from 'vitest'
import {
  BOAT_HULL_RENDER_ORDER,
  BOAT_OBJ_OFFSET_Y,
  BOAT_PADDLE_GEOMETRY_DELTA,
  BOAT_PADDLE_LEFT_PIVOT,
  BOAT_PADDLE_PIVOT_LEFT_NAME,
  BOAT_PADDLE_PIVOT_RIGHT_NAME,
  BOAT_PADDLE_RIGHT_PIVOT,
  BOAT_PADDLE_SOURCE_LEFT,
  BOAT_WATER_PATCH_CENTER_Y,
  BOAT_WATER_PATCH_CENTER_Z,
  BOAT_WATER_PATCH_DEPTH,
  BOAT_WATER_PATCH_HEIGHT,
  BOAT_WATER_PATCH_NAME,
  BOAT_WATER_PATCH_RENDER_ORDER,
  BOAT_WATER_PATCH_WIDTH,
  BOAT_WATER_PATCH_WORLD_BOUNDS,
  applyBoatHullRenderSettings,
  boatObjLocalToEntitySpace,
  createBoatWaterPatchMesh,
  getBoatWaterPatchEntitySpaceBounds,
  setupBoatMesh,
  setupBoatPaddlePivots
} from './boatRenderSetup'

test('water patch uses vanilla dimensions in blocks', () => {
  const patch = createBoatWaterPatchMesh()
  const size = new THREE.Vector3()
  patch.geometry.computeBoundingBox()
  patch.geometry.boundingBox!.getSize(size)
  expect(size.x).toBeCloseTo(BOAT_WATER_PATCH_WIDTH, 5)
  expect(size.y).toBeCloseTo(BOAT_WATER_PATCH_HEIGHT, 5)
  expect(size.z).toBeCloseTo(BOAT_WATER_PATCH_DEPTH, 5)
})

test('water patch local center matches vanilla OBJ placement', () => {
  const patch = createBoatWaterPatchMesh()
  expect(patch.position.x).toBe(0)
  expect(patch.position.y).toBeCloseTo(BOAT_WATER_PATCH_CENTER_Y, 5)
  expect(patch.position.z).toBeCloseTo(BOAT_WATER_PATCH_CENTER_Z, 5)
})

test('water patch entity-space bounds match vanilla world-relative bounds', () => {
  const bounds = getBoatWaterPatchEntitySpaceBounds(BOAT_OBJ_OFFSET_Y)
  expect(bounds.minX).toBeCloseTo(BOAT_WATER_PATCH_WORLD_BOUNDS.minX, 5)
  expect(bounds.maxX).toBeCloseTo(BOAT_WATER_PATCH_WORLD_BOUNDS.maxX, 5)
  expect(bounds.minY).toBeCloseTo(BOAT_WATER_PATCH_WORLD_BOUNDS.minY, 5)
  expect(bounds.maxY).toBeCloseTo(BOAT_WATER_PATCH_WORLD_BOUNDS.maxY, 5)
  expect(bounds.minZ).toBeCloseTo(BOAT_WATER_PATCH_WORLD_BOUNDS.minZ, 5)
  expect(bounds.maxZ).toBeCloseTo(BOAT_WATER_PATCH_WORLD_BOUNDS.maxZ, 5)
})

test('water patch material is depth-only', () => {
  const patch = createBoatWaterPatchMesh()
  const material = patch.material as THREE.MeshBasicMaterial
  expect(material.colorWrite).toBe(false)
  expect(material.depthWrite).toBe(true)
  expect(material.depthTest).toBe(true)
})

test('boat hull renders in opaque list before depth-only patch', () => {
  const root = new THREE.Object3D()
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.1 }))
  hull.name = 'bottom'
  root.add(hull)
  const { waterPatch } = setupBoatMesh(root)

  expect(hull.renderOrder).toBe(BOAT_HULL_RENDER_ORDER)
  expect(waterPatch.renderOrder).toBe(BOAT_WATER_PATCH_RENDER_ORDER)
  expect(waterPatch.renderOrder).toBeGreaterThan(hull.renderOrder)
  expect(waterPatch.name).toBe(BOAT_WATER_PATCH_NAME)
})

test('boat hull material is alpha-tested opaque with depth write', () => {
  const root = new THREE.Object3D()
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.05 }))
  root.add(hull)
  applyBoatHullRenderSettings(root)
  const material = hull.material as THREE.MeshBasicMaterial
  expect(material.transparent).toBe(false)
  expect(material.alphaTest).toBeGreaterThanOrEqual(0.1)
  expect(material.depthWrite).toBe(true)
  expect(material.depthTest).toBe(true)
})

test('boat OBJ hull entity-space Y bounds after BOAT_OBJ_OFFSET_Y', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const objPath = path.join(__dirname, 'models/boat.obj')
  const txt = fs.readFileSync(objPath, 'utf8') as string
  const groups: Record<string, { min: number; max: number }> = {}
  let current = ''
  for (const line of txt.split('\n')) {
    if (line.startsWith('o ')) current = line.slice(2).trim()
    if (!line.startsWith('v ')) continue
    const y = Number(line.split(/\s+/)[2])
    groups[current] ??= { min: Infinity, max: -Infinity }
    groups[current].min = Math.min(groups[current].min, y + BOAT_OBJ_OFFSET_Y)
    groups[current].max = Math.max(groups[current].max, y + BOAT_OBJ_OFFSET_Y)
  }

  expect(groups.bottom.min).toBeCloseTo(0, 5)
  expect(groups.bottom.max).toBeCloseTo(0.1875, 5)
  for (const name of ['front', 'back', 'left', 'right'] as const) {
    expect(groups[name].min).toBeCloseTo(0.1875, 5)
    expect(groups[name].max).toBeCloseTo(0.5625, 5)
  }

  const patch = getBoatWaterPatchEntitySpaceBounds(BOAT_OBJ_OFFSET_Y)
  expect(patch.minY).toBeCloseTo(0.375, 5)
  expect(patch.maxY).toBeCloseTo(0.5625, 5)
})

function makeBoatRootWithPaddles(): THREE.Object3D {
  const root = new THREE.Object3D()
  const leftShaft = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5))
  leftShaft.name = 'paddle_left'
  leftShaft.position.set(0.2, 1.5, 1.0)
  const leftBlade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.2))
  leftBlade.name = 'paddle_left'
  leftBlade.position.set(0.15, 1.4, 1.2)
  const rightShaft = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5))
  rightShaft.name = 'paddle_right'
  rightShaft.position.set(0.2, 1.5, -1.0)
  const rightBlade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.2))
  rightBlade.name = 'paddle_right'
  rightBlade.position.set(0.15, 1.4, -1.2)
  root.add(leftShaft, leftBlade, rightShaft, rightBlade)
  return root
}

test('setupBoatPaddlePivots groups both paddle pieces by side', () => {
  const root = makeBoatRootWithPaddles()
  const { leftPivot, rightPivot } = setupBoatPaddlePivots(root)

  expect(leftPivot?.children.length).toBe(2)
  expect(rightPivot?.children.length).toBe(2)
  expect(leftPivot?.name).toBe(BOAT_PADDLE_PIVOT_LEFT_NAME)
  expect(rightPivot?.name).toBe(BOAT_PADDLE_PIVOT_RIGHT_NAME)
})

function getMeshRootLocalPosition(root: THREE.Object3D, mesh: THREE.Object3D): THREE.Vector3 {
  const rootLocal = new THREE.Vector3()
  let current: THREE.Object3D | null = mesh
  while (current && current !== root) {
    rootLocal.add(current.position)
    current = current.parent
  }
  return rootLocal
}

test('setupBoatPaddlePivots uses corrected vanilla attachment positions', () => {
  const root = makeBoatRootWithPaddles()
  const { leftPivot, rightPivot } = setupBoatPaddlePivots(root)

  expect(leftPivot?.position.toArray()).toEqual(BOAT_PADDLE_LEFT_PIVOT.toArray())
  expect(rightPivot?.position.toArray()).toEqual(BOAT_PADDLE_RIGHT_PIVOT.toArray())
})

test('setupBoatPaddlePivots shifts root-local paddle geometry by geometry delta', () => {
  const root = makeBoatRootWithPaddles()
  const before = root.children.map(child => child.position.clone())
  setupBoatPaddlePivots(root)

  const afterPositions: THREE.Vector3[] = []
  root.traverse(child => {
    if (child instanceof THREE.Mesh && (child.name === 'paddle_left' || child.name === 'paddle_right')) {
      afterPositions.push(getMeshRootLocalPosition(root, child))
    }
  })

  expect(afterPositions.length).toBe(4)
  for (let i = 0; i < before.length; i++) {
    expect(afterPositions[i].x).toBeCloseTo(before[i].x + BOAT_PADDLE_GEOMETRY_DELTA.x, 5)
    expect(afterPositions[i].y).toBeCloseTo(before[i].y + BOAT_PADDLE_GEOMETRY_DELTA.y, 5)
    expect(afterPositions[i].z).toBeCloseTo(before[i].z + BOAT_PADDLE_GEOMETRY_DELTA.z, 5)
  }
})

test('corrected paddle pivots map to vanilla entity Z with mesh yaw −π/2', () => {
  const left = boatObjLocalToEntitySpace(BOAT_PADDLE_LEFT_PIVOT.x, BOAT_PADDLE_LEFT_PIVOT.y, BOAT_PADDLE_LEFT_PIVOT.z)
  const right = boatObjLocalToEntitySpace(BOAT_PADDLE_RIGHT_PIVOT.x, BOAT_PADDLE_RIGHT_PIVOT.y, BOAT_PADDLE_RIGHT_PIVOT.z)

  expect(left.z).toBeCloseTo(-3 / 16, 5)
  expect(right.z).toBeCloseTo(-3 / 16, 5)
  expect(left.y).toBeCloseTo(0.6875, 5)
  expect(right.y).toBeCloseTo(0.6875, 5)
  expect(left.x).toBeCloseTo(-9 / 16, 5)
  expect(right.x).toBeCloseTo(9 / 16, 5)
})

test('setupBoatPaddlePivots offsets child geometry from source pivot for rotation', () => {
  const root = makeBoatRootWithPaddles()
  const { leftPivot } = setupBoatPaddlePivots(root)
  expect(leftPivot).toBeDefined()

  const shaft = leftPivot!.children[0]
  const rootLocalBefore = new THREE.Vector3(0.2, 1.5, 1.0)
  expect(shaft.position.x).toBeCloseTo(rootLocalBefore.x - BOAT_PADDLE_SOURCE_LEFT.x, 5)
  expect(shaft.position.y).toBeCloseTo(rootLocalBefore.y - BOAT_PADDLE_SOURCE_LEFT.y, 5)
  expect(shaft.position.z).toBeCloseTo(rootLocalBefore.z - BOAT_PADDLE_SOURCE_LEFT.z, 5)
})

test('rotating a pivot moves both paddle pieces rigidly', () => {
  const root = makeBoatRootWithPaddles()
  const { leftPivot } = setupBoatPaddlePivots(root)
  expect(leftPivot).toBeDefined()

  const childOffsetsBefore = leftPivot!.children.map(child => child.position.clone())
  leftPivot!.rotation.y = Math.PI / 4
  leftPivot!.updateMatrixWorld(true)

  leftPivot!.children.forEach((child, index) => {
    expect(child.position.x).toBeCloseTo(childOffsetsBefore[index].x, 5)
    expect(child.position.y).toBeCloseTo(childOffsetsBefore[index].y, 5)
    expect(child.position.z).toBeCloseTo(childOffsetsBefore[index].z, 5)
  })
  expect(leftPivot!.position.toArray()).toEqual(BOAT_PADDLE_LEFT_PIVOT.toArray())
})

test('setupBoatMesh is idempotent for paddle pivots and water patch', () => {
  const root = makeBoatRootWithPaddles()
  setupBoatMesh(root)
  const leftPivot = root.userData.boatPaddleLeftPivot as THREE.Object3D
  const waterPatchCountBefore = root.children.filter(child => child.name === BOAT_WATER_PATCH_NAME).length

  setupBoatMesh(root)

  expect(root.userData.boatPaddleLeftPivot).toBe(leftPivot)
  expect(root.children.filter(child => child.name === BOAT_WATER_PATCH_NAME).length).toBe(waterPatchCountBefore)
  expect(root.children.filter(child => child.name === BOAT_PADDLE_PIVOT_LEFT_NAME).length).toBe(1)
  expect(root.children.filter(child => child.name === BOAT_PADDLE_PIVOT_RIGHT_NAME).length).toBe(1)
})
