import * as THREE from 'three'

export const BOAT_PADDLE_STEP = Math.PI / 8
export const BOAT_TICKS_PER_SECOND = 20
export const BOAT_PADDLE_RADIANS_PER_SECOND = BOAT_PADDLE_STEP * BOAT_TICKS_PER_SECOND

export type BoatPaddleAnimationState = {
  leftActive: boolean
  rightActive: boolean
  leftPhase: number
  rightPhase: number
}

export type BoatPaddlePivotScratch = {
  current: THREE.Quaternion
  rest: THREE.Quaternion
  delta: THREE.Quaternion
  euler: THREE.Euler
}

export function createBoatPaddlePivotScratch(): BoatPaddlePivotScratch {
  return {
    current: new THREE.Quaternion(),
    rest: new THREE.Quaternion(),
    delta: new THREE.Quaternion(),
    euler: new THREE.Euler(0, 0, 0, 'ZYX')
  }
}

export function createBoatPaddleAnimationState(): BoatPaddleAnimationState {
  return {
    leftActive: false,
    rightActive: false,
    leftPhase: 0,
    rightPhase: 0
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function advanceBoatPaddlePhase(phase: number, active: boolean, dt: number): number {
  if (!active) return 0
  const safeDt = Number.isFinite(dt) && dt >= 0 ? dt : 0
  const twoPi = Math.PI * 2
  return (phase + safeDt * BOAT_PADDLE_RADIANS_PER_SECOND) % twoPi
}

export function getVanillaBoatPaddleAngles(phase: number, side: 0 | 1): { xRot: number; yRot: number; zRot: number } {
  const xRot = lerp(-Math.PI / 3, -Math.PI / 12, (Math.sin(-phase) + 1) / 2)
  let yRot = lerp(-Math.PI / 4, Math.PI / 4, (Math.sin(-phase + 1) + 1) / 2)
  if (side === 1) yRot = Math.PI - yRot
  const zRot = Math.PI / 16
  return { xRot, yRot, zRot }
}

function vanillaAnglesToQuaternion(angles: { xRot: number; yRot: number; zRot: number }, target: THREE.Quaternion, euler: THREE.Euler): THREE.Quaternion {
  euler.set(-angles.xRot, angles.yRot, -angles.zRot, 'ZYX')
  return target.setFromEuler(euler)
}

export function getBoatPaddleRelativeQuaternion(phase: number, side: 0 | 1, scratch: BoatPaddlePivotScratch): THREE.Quaternion {
  if (phase === 0) {
    return scratch.delta.identity()
  }
  vanillaAnglesToQuaternion(getVanillaBoatPaddleAngles(phase, side), scratch.current, scratch.euler)
  vanillaAnglesToQuaternion(getVanillaBoatPaddleAngles(0, side), scratch.rest, scratch.euler)
  return scratch.delta.copy(scratch.current).multiply(scratch.rest.invert())
}

export function applyBoatPaddlePivotRotation(pivot: THREE.Object3D, phase: number, side: 0 | 1, scratch: BoatPaddlePivotScratch): void {
  pivot.quaternion.copy(getBoatPaddleRelativeQuaternion(phase, side, scratch))
}

export function syncBoatPaddleAnimationTargets(state: BoatPaddleAnimationState, leftActive: boolean, rightActive: boolean): void {
  if (state.leftActive !== leftActive) {
    state.leftActive = leftActive
    state.leftPhase = 0
  }
  if (state.rightActive !== rightActive) {
    state.rightActive = rightActive
    state.rightPhase = 0
  }
}

export function updateBoatPaddleAnimationState(
  state: BoatPaddleAnimationState,
  dt: number,
  leftPivot: THREE.Object3D | undefined,
  rightPivot: THREE.Object3D | undefined,
  scratch: BoatPaddlePivotScratch
): void {
  state.leftPhase = advanceBoatPaddlePhase(state.leftPhase, state.leftActive, dt)
  state.rightPhase = advanceBoatPaddlePhase(state.rightPhase, state.rightActive, dt)

  if (leftPivot) {
    applyBoatPaddlePivotRotation(leftPivot, state.leftPhase, 0, scratch)
  }
  if (rightPivot) {
    applyBoatPaddlePivotRotation(rightPivot, state.rightPhase, 1, scratch)
  }
}
