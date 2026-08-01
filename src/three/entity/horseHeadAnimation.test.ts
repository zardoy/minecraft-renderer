import * as THREE from 'three'
import { expect, test } from 'vitest'
import {
  HORSE_HEAD_MAX_YAW,
  applyHorseHeadPose,
  calculateHorseHeadPose,
  createHorseHeadAnimationState,
  createHorseHeadRig,
  getInterpolatedHorseHeadAnimation,
  HORSE_HEAD_TICK_SECONDS,
  setHorseHeadAnimationPosition,
  updateHorseHeadAnimationFrame
} from './horseHeadAnimation'

test('head rig keeps world bounds and includes duplicate head parts', () => {
  const root = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  body.name = 'Body'
  const head = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  head.name = 'Head'
  head.position.set(0, 2, -1)
  const headSaddleA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  headSaddleA.name = 'HeadSaddle'
  headSaddleA.position.set(0, 1.5, -1)
  const headSaddleB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  headSaddleB.name = 'HeadSaddle'
  headSaddleB.position.set(0, 1.8, -1)
  root.add(body, head, headSaddleA, headSaddleB)
  root.updateMatrixWorld(true)
  const before = new THREE.Box3().setFromObject(root)

  const rig = createHorseHeadRig(root)
  root.updateMatrixWorld(true)
  const after = new THREE.Box3().setFromObject(root)

  expect(rig.userData.horseHeadParts).toHaveLength(3)
  expect(rig.userData.horseHeadParts).toContain(head)
  expect(rig.userData.horseHeadParts.filter(part => part.name === 'HeadSaddle')).toHaveLength(2)
  expect(after.min.toArray()).toEqual(before.min.toArray())
  expect(after.max.toArray()).toEqual(before.max.toArray())
  expect(root.children.filter(child => child.name === 'horse_head_rig')).toHaveLength(1)
  expect(createHorseHeadRig(root)).toBe(rig)
})

test('horse head pitch follows entity pitch in radians', () => {
  const pose = calculateHorseHeadPose({
    entityPitch: -Math.PI / 6,
    headYaw: 0,
    bodyYaw: 0,
    limbSwing: 0,
    limbSwingAmount: 0
  })
  expect(pose.pitch).toBeCloseTo(-Math.PI / 6)
  expect(pose.yaw).toBe(0)
})

test('horse gait subtracts from pitch at full limb amount', () => {
  const pose = calculateHorseHeadPose({
    entityPitch: 0,
    headYaw: 0,
    bodyYaw: 0,
    limbSwing: 0,
    limbSwingAmount: 1
  })
  expect(pose.pitch).toBeCloseTo(-0.15)
})

test('horse gait is disabled for a small limb amount', () => {
  expect(
    calculateHorseHeadPose({
      entityPitch: 0.3,
      headYaw: 0,
      bodyYaw: 0,
      limbSwing: Math.PI,
      limbSwingAmount: 0.2
    }).pitch
  ).toBeCloseTo(0.3)
})

test('relative head yaw is shortest-path and limited to twenty degrees', () => {
  expect(
    calculateHorseHeadPose({
      entityPitch: 0,
      headYaw: -Math.PI + 0.1,
      bodyYaw: Math.PI - 0.1,
      limbSwing: 0,
      limbSwingAmount: 0
    }).yaw
  ).toBeCloseTo(0.2)
  expect(
    calculateHorseHeadPose({
      entityPitch: 0,
      headYaw: Math.PI / 2,
      bodyYaw: 0,
      limbSwing: 0,
      limbSwingAmount: 0
    }).yaw
  ).toBeCloseTo(HORSE_HEAD_MAX_YAW)
})

test('animation phase uses authoritative horizontal distance and interpolates between ticks', () => {
  const state = createHorseHeadAnimationState()
  setHorseHeadAnimationPosition(state, { x: 10, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  setHorseHeadAnimationPosition(state, { x: 10.1, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  expect(state.limbSwingAmount).toBeCloseTo(0.16)
  expect(getInterpolatedHorseHeadAnimation(state, 0).limbSwingAmount).toBe(0)
  expect(getInterpolatedHorseHeadAnimation(state, 1).limbSwingAmount).toBeCloseTo(0.16)
})

test('movement position is consumed once per render tick', () => {
  const state = createHorseHeadAnimationState()
  setHorseHeadAnimationPosition(state, { x: 10, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  setHorseHeadAnimationPosition(state, { x: 10.1, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  expect(state.limbSwingAmount).toBeCloseTo(0.16)

  setHorseHeadAnimationPosition(state, { x: 10.2, z: 10 })
  expect(state.limbSwingAmount).toBeCloseTo(0.16)
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  expect(state.limbSwingAmount).toBeCloseTo(0.256)
  expect(state.limbSwing).toBeCloseTo(0.416)
})

test('render frames decay gait when a remote horse stops sending movement updates', () => {
  const state = createHorseHeadAnimationState()
  setHorseHeadAnimationPosition(state, { x: 10, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  setHorseHeadAnimationPosition(state, { x: 10.1, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  expect(state.limbSwingAmount).toBeCloseTo(0.096)
  expect(state.limbSwing).toBeCloseTo(0.256)
})

test('interpolates the leftover time after a tick at 30 FPS', () => {
  const state = createHorseHeadAnimationState()
  setHorseHeadAnimationPosition(state, { x: 10, z: 10 })
  updateHorseHeadAnimationFrame(state, HORSE_HEAD_TICK_SECONDS)
  setHorseHeadAnimationPosition(state, { x: 10.1, z: 10 })

  updateHorseHeadAnimationFrame(state, 0.033)
  const interpolated = updateHorseHeadAnimationFrame(state, 0.033)

  expect(state.tickAccumulatorSeconds).toBeCloseTo(0.016)
  expect(state.elapsedSeconds / HORSE_HEAD_TICK_SECONDS).toBeCloseTo(0.32)
  expect(interpolated.limbSwingAmount).toBeCloseTo(0.16 * 0.32)
})

test('applying a pose changes only the runtime rig', () => {
  const rig = new THREE.Group()
  applyHorseHeadPose(rig, { pitch: 0.4, yaw: -0.2 })
  expect(rig.rotation.x).toBeCloseTo(0.4)
  expect(rig.rotation.y).toBeCloseTo(-0.2)
  expect(rig.rotation.z).toBe(0)
})
