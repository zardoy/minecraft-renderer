import * as THREE from 'three'
import { expect, test } from 'vitest'
import {
  BOAT_PADDLE_RADIANS_PER_SECOND,
  BOAT_PADDLE_STEP,
  advanceBoatPaddlePhase,
  createBoatPaddlePivotScratch,
  getBoatPaddleRelativeQuaternion,
  getVanillaBoatPaddleAngles,
  syncBoatPaddleAnimationTargets,
  updateBoatPaddleAnimationState,
  createBoatPaddleAnimationState
} from './boatPaddleAnimation'

test('50ms active advancement equals pi/8', () => {
  expect(advanceBoatPaddlePhase(0, true, 0.05)).toBeCloseTo(BOAT_PADDLE_STEP, 5)
})

test('equal elapsed time split across frame sizes gives the same phase', () => {
  const total = 0.1
  const single = advanceBoatPaddlePhase(0, true, total)
  const split = advanceBoatPaddlePhase(advanceBoatPaddlePhase(0, true, total / 2), true, total / 2)
  expect(split).toBeCloseTo(single, 5)
})

test('inactive paddle resets phase to zero', () => {
  expect(advanceBoatPaddlePhase(Math.PI, false, 0.05)).toBe(0)
})

test('active phase remains within [0, 2pi)', () => {
  let phase = 0
  for (let i = 0; i < 200; i++) {
    phase = advanceBoatPaddlePhase(phase, true, 0.016)
    expect(phase).toBeGreaterThanOrEqual(0)
    expect(phase).toBeLessThan(Math.PI * 2)
    expect(Number.isFinite(phase)).toBe(true)
  }
})

test('vanilla angles at phase 0, pi/4, and pi/2 match extracted formulas', () => {
  const phases = [0, Math.PI / 4, Math.PI / 2] as const
  for (const phase of phases) {
    const angles = getVanillaBoatPaddleAngles(phase, 0)
    const tX = (Math.sin(-phase) + 1) / 2
    const tY = (Math.sin(-phase + 1) + 1) / 2
    expect(angles.xRot).toBeCloseTo(-Math.PI / 3 + (-Math.PI / 12 - -Math.PI / 3) * tX, 5)
    expect(angles.yRot).toBeCloseTo(-Math.PI / 4 + (Math.PI / 2) * tY, 5)
    expect(angles.zRot).toBeCloseTo(Math.PI / 16, 5)
  }
})

test('right-side Y is mirrored', () => {
  const left = getVanillaBoatPaddleAngles(Math.PI / 3, 0)
  const right = getVanillaBoatPaddleAngles(Math.PI / 3, 1)
  expect(right.yRot).toBeCloseTo(Math.PI - left.yRot, 5)
  expect(right.xRot).toBeCloseTo(left.xRot, 5)
})

test('relative quaternion at phase zero is identity', () => {
  const scratch = createBoatPaddlePivotScratch()
  const quat = getBoatPaddleRelativeQuaternion(0, 0, scratch)
  expect(quat.x).toBeCloseTo(0, 5)
  expect(quat.y).toBeCloseTo(0, 5)
  expect(quat.z).toBeCloseTo(0, 5)
  expect(quat.w).toBeCloseTo(1, 5)
})

test('returned phases and quaternions are finite', () => {
  const scratch = createBoatPaddlePivotScratch()
  const phase = advanceBoatPaddlePhase(0, true, 0.05)
  const quat = getBoatPaddleRelativeQuaternion(phase, 1, scratch)
  expect(Number.isFinite(phase)).toBe(true)
  expect(Number.isFinite(quat.x)).toBe(true)
  expect(Number.isFinite(quat.y)).toBe(true)
  expect(Number.isFinite(quat.z)).toBe(true)
  expect(Number.isFinite(quat.w)).toBe(true)
})

test('syncBoatPaddleAnimationTargets resets phase when activity changes', () => {
  const state = createBoatPaddleAnimationState()
  state.leftPhase = 1.2
  state.leftActive = true

  syncBoatPaddleAnimationTargets(state, false, false)
  expect(state.leftActive).toBe(false)
  expect(state.leftPhase).toBe(0)
})

test('updateBoatPaddleAnimationState advances active paddles and rotates pivots', () => {
  const state = createBoatPaddleAnimationState()
  state.leftActive = true
  const leftPivot = new THREE.Object3D()
  const scratch = createBoatPaddlePivotScratch()

  updateBoatPaddleAnimationState(state, 0.05, leftPivot, undefined, scratch)
  expect(state.leftPhase).toBeCloseTo(BOAT_PADDLE_STEP, 5)
  expect(leftPivot.quaternion.w).not.toBeCloseTo(1, 3)
})

test('negative or non-finite dt is treated as zero advancement', () => {
  expect(advanceBoatPaddlePhase(0.5, true, Number.NaN)).toBe(0.5)
  expect(advanceBoatPaddlePhase(0.5, true, -1)).toBe(0.5)
})

test('boat paddle radians per second matches vanilla tick rate', () => {
  expect(BOAT_PADDLE_RADIANS_PER_SECOND).toBeCloseTo((Math.PI / 8) * 20, 5)
})
