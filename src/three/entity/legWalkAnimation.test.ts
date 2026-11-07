import * as THREE from 'three'
import { expect, test } from 'vitest'
import { applyLegRig, assignLegPhases, calculateLegSwing, createLegRig } from './legWalkAnimation'

const close = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b) < 1e-4

/** Mirrors `getMesh`: bones carry absolute pivots even when parented, vertices are authored in mesh space. */
// bound before scaling like `getMesh`, so skinned vertices come back in 1/16 block units
function makeBedrockQuadruped() {
  const legs = [
    { name: 'leg0', pivot: [-4, 12, 7] },
    { name: 'leg1', pivot: [4, 12, 7] },
    { name: 'leg2', pivot: [-4, 12, -6] },
    { name: 'leg3', pivot: [4, 12, -6] }
  ]
  const body = new THREE.Bone()
  body.name = 'bone_body'
  body.position.set(0, 5, 2)
  const bones = [body]
  const positions: number[] = []
  const skinIndices: number[] = []
  const skinWeights: number[] = []
  for (const [i, leg] of legs.entries()) {
    const bone = new THREE.Bone()
    bone.name = `bone_${leg.name}`
    bone.position.set(leg.pivot[0], leg.pivot[1], leg.pivot[2])
    body.add(bone)
    bones.push(bone)
    // single foot vertex 12px under the pivot
    positions.push(leg.pivot[0], leg.pivot[1] - 12, leg.pivot[2])
    skinIndices.push(i + 1, 0, 0, 0)
    skinWeights.push(1, 0, 0, 0)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  mesh.add(body)
  mesh.bind(new THREE.Skeleton(bones))
  mesh.scale.set(1 / 16, 1 / 16, 1 / 16)
  const root = new THREE.Object3D()
  root.add(mesh)
  return { root, mesh, legs }
}

test('calculateLegSwing follows vanilla gait and is zero at rest', () => {
  expect(calculateLegSwing(5, 0, 0)).toBe(0)
  expect(calculateLegSwing(0, 1, 0)).toBeCloseTo(1.4)
  expect(calculateLegSwing(0, 0.5, Math.PI)).toBeCloseTo(-0.7)
  expect(calculateLegSwing(Number.NaN, 1, 0)).toBe(0)
})

test('assignLegPhases alternates bipeds and pairs quadruped diagonals', () => {
  expect(assignLegPhases([{ x: -1.9, z: 0 }, { x: 1.9, z: 0 }])).toEqual([Math.PI, 0])
  // leg0..leg3 as hind-right, hind-left, front-right, front-left
  const quad = assignLegPhases([
    { x: -4, z: 7 },
    { x: 4, z: 7 },
    { x: -4, z: -6 },
    { x: 4, z: -6 }
  ])!
  expect(quad[0]).toBe(quad[3])
  expect(quad[1]).toBe(quad[2])
  expect(quad[0]).not.toBe(quad[1])
  expect(assignLegPhases([{ x: 0, z: 0 }])).toBeUndefined()
  expect(assignLegPhases(Array.from({ length: 8 }, (_, i) => ({ x: i, z: i % 2 })))).toBeUndefined()
})

test('bedrock legs rotate about their own pivot even when parented to an offset body bone', () => {
  const { root, mesh, legs } = makeBedrockQuadruped()
  const rig = createLegRig(root, 'cow')!
  expect(rig.legs).toHaveLength(4)

  applyLegRig(rig, 0.4 * Math.PI, 1)
  mesh.updateWorldMatrix(true, true)
  mesh.skeleton.update()

  const vertex = new THREE.Vector3()
  for (const [i, leg] of legs.entries()) {
    const pivot = new THREE.Vector3(...(leg.pivot as [number, number, number]))
    const expectedAngle = calculateLegSwing(0.4 * Math.PI, 1, rig.legs[i].phase)
    const foot = new THREE.Vector3(pivot.x, pivot.y - 12, pivot.z)
    const expected = foot.clone().sub(pivot).applyAxisAngle(new THREE.Vector3(1, 0, 0), expectedAngle).add(pivot)
    mesh.getVertexPosition(i, vertex).multiplyScalar(16)
    expect(close(vertex, expected), `leg ${i}`).toBe(true)
    // the pivot itself never moves
    expect(Math.abs(vertex.distanceTo(pivot) - 12)).toBeLessThan(1e-4)
  }
})

test('legs settle back to the exact rest pose once the mob stops', () => {
  const { root, mesh, legs } = makeBedrockQuadruped()
  const rig = createLegRig(root, 'pig')!
  applyLegRig(rig, 3, 0.8)
  applyLegRig(rig, 3, 0)
  mesh.updateWorldMatrix(true, true)
  mesh.skeleton.update()
  const vertex = new THREE.Vector3()
  for (const [i, leg] of legs.entries()) {
    mesh.getVertexPosition(i, vertex).multiplyScalar(16)
    expect(close(vertex, new THREE.Vector3(leg.pivot[0], leg.pivot[1] - 12, leg.pivot[2]))).toBe(true)
  }
})

function makeObjBiped() {
  const root = new THREE.Object3D()
  const makeLeg = (name: string, x: number) => {
    const geometry = new THREE.BoxGeometry(0.25, 0.75, 0.25)
    geometry.translate(x, 0.375, 0)
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.name = name
    return mesh
  }
  const left = makeLeg('LeftLeg', 0.125)
  const right = makeLeg('RightLeg', -0.125)
  root.add(left, right)
  return { root, left, right }
}

test('OBJ legs pivot at the top of their box without moving at rest', () => {
  const { root, left, right } = makeObjBiped()
  const rig = createLegRig(root, 'enderman')!
  expect(rig.legs).toHaveLength(2)

  left.updateMatrix()
  left.geometry.computeBoundingBox()
  const restBox = left.geometry.boundingBox!.clone().applyMatrix4(left.matrix)
  expect(restBox.min.y).toBeCloseTo(0)
  expect(restBox.max.y).toBeCloseTo(0.75)

  applyLegRig(rig, 0, 1)
  expect(left.rotation.x).toBeCloseTo(calculateLegSwing(0, 1, rig.legs.find(l => l.kind === 'mesh' && l.meshes[0] === left)!.phase))
  expect(left.rotation.x).toBeCloseTo(-right.rotation.x)
  // the hinge (original top centre of the leg) stays put while the leg rotates
  left.updateMatrix()
  const hinge = new THREE.Vector3(0, 0, 0).applyMatrix4(left.matrix)
  expect(close(hinge, new THREE.Vector3(0.125, 0.75, 0))).toBe(true)
})

test('excluded and unrecognised models get no rig', () => {
  expect(createLegRig(makeObjBiped().root, 'parrot')).toBeUndefined()
  expect(createLegRig(new THREE.Object3D(), 'cow')).toBeUndefined()
})
