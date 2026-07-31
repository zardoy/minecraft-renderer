import * as THREE from 'three'

export const HORSE_HEAD_PIVOT = { x: 0, y: 1.25, z: -0.75 } as const
export const HORSE_HEAD_MAX_YAW = THREE.MathUtils.degToRad(20)
export const HORSE_HEAD_TICK_SECONDS = 0.05

const HORSE_HEAD_PART_NAMES = new Set([
  'Head',
  'UMouth',
  'Ear1',
  'Ear2',
  'MuleEarL',
  'MuleEarR',
  'Neck',
  'Mane',
  'SaddleMouthL',
  'SaddleMouthR',
  'SaddleMouthLine',
  'SaddleMouthLineR',
  'HeadSaddle',
])

export type HorseHeadRig = THREE.Group & {
  userData: THREE.Group['userData'] & { horseHeadParts: THREE.Object3D[] }
}

export const HORSE_HEAD_RIG_USER_DATA_KEY = '_horseHeadRig'
export const HORSE_HEAD_ANIMATION_USER_DATA_KEY = '_horseHeadAnimation'

/**
 * Reparents every horse head-related OBJ object under the vanilla head_parts
 * pivot while retaining each object's world transform.
 */
export function createHorseHeadRig (root: THREE.Object3D): HorseHeadRig {
  const existing = root.userData[HORSE_HEAD_RIG_USER_DATA_KEY] as HorseHeadRig | undefined
  if (existing) return existing

  const parts: THREE.Object3D[] = []
  root.traverse(child => {
    if (child !== root && HORSE_HEAD_PART_NAMES.has(child.name)) parts.push(child)
  })

  const rig = new THREE.Group() as HorseHeadRig
  rig.name = 'horse_head_rig'
  rig.position.set(HORSE_HEAD_PIVOT.x, HORSE_HEAD_PIVOT.y, HORSE_HEAD_PIVOT.z)
  rig.userData.horseHeadParts = parts
  root.add(rig)

  for (const part of parts) rig.attach(part)

  root.userData[HORSE_HEAD_RIG_USER_DATA_KEY] = rig
  return rig
}

export type HorseHeadPoseInput = {
  entityPitch: number
  headYaw: number
  bodyYaw: number
  limbSwing: number
  limbSwingAmount: number
}

export type HorseHeadPose = {
  pitch: number
  yaw: number
}

export function normalizeYawDelta (fromYaw: number, toYaw: number): number {
  const tau = Math.PI * 2
  const delta = ((toYaw - fromYaw + Math.PI) % tau + tau) % tau - Math.PI
  return delta === -Math.PI ? Math.PI : delta
}

export function calculateHorseHeadPose (input: HorseHeadPoseInput): HorseHeadPose {
  const { entityPitch, headYaw, bodyYaw, limbSwing, limbSwingAmount } = input
  const safeAmount = Number.isFinite(limbSwingAmount) ? Math.max(0, limbSwingAmount) : 0
  const gait = safeAmount > 0.2 ? Math.cos(limbSwing * 0.4) * 0.15 * safeAmount : 0
  const relativeYaw = THREE.MathUtils.clamp(normalizeYawDelta(bodyYaw, headYaw), -HORSE_HEAD_MAX_YAW, HORSE_HEAD_MAX_YAW)
  return {
    pitch: (Number.isFinite(entityPitch) ? entityPitch : 0) + gait,
    yaw: relativeYaw,
  }
}

export type HorseHeadAnimationState = {
  lastPosition?: { x: number, z: number }
  prevLimbSwing: number
  limbSwing: number
  prevLimbSwingAmount: number
  limbSwingAmount: number
  elapsedSeconds: number
}

export function createHorseHeadAnimationState (): HorseHeadAnimationState {
  return {
    prevLimbSwing: 0,
    limbSwing: 0,
    prevLimbSwingAmount: 0,
    limbSwingAmount: 0,
    elapsedSeconds: HORSE_HEAD_TICK_SECONDS,
  }
}

/** Advance using authoritative entity coordinates, before camera transforms. */
export function advanceHorseHeadAnimation (state: HorseHeadAnimationState, position: { x: number, z: number }): void {
  state.prevLimbSwing = state.limbSwing
  state.prevLimbSwingAmount = state.limbSwingAmount

  const distance = state.lastPosition == null
    ? 0
    : Math.hypot(position.x - state.lastPosition.x, position.z - state.lastPosition.z)
  const targetAmount = Math.min(1, distance * 4)
  state.limbSwingAmount += (targetAmount - state.limbSwingAmount) * 0.4
  state.limbSwing += state.limbSwingAmount
  state.lastPosition = { x: position.x, z: position.z }
  state.elapsedSeconds = 0
}

export function getInterpolatedHorseHeadAnimation (state: HorseHeadAnimationState, partialTick: number): { limbSwing: number, limbSwingAmount: number } {
  const alpha = THREE.MathUtils.clamp(partialTick, 0, 1)
  return {
    limbSwing: state.prevLimbSwing + (state.limbSwing - state.prevLimbSwing) * alpha,
    limbSwingAmount: state.prevLimbSwingAmount + (state.limbSwingAmount - state.prevLimbSwingAmount) * alpha,
  }
}

export function updateHorseHeadAnimationFrame (state: HorseHeadAnimationState, deltaSeconds: number): { limbSwing: number, limbSwingAmount: number } {
  state.elapsedSeconds = Math.min(HORSE_HEAD_TICK_SECONDS, state.elapsedSeconds + Math.max(0, deltaSeconds))
  return getInterpolatedHorseHeadAnimation(state, state.elapsedSeconds / HORSE_HEAD_TICK_SECONDS)
}

export function applyHorseHeadPose (rig: THREE.Object3D, pose: HorseHeadPose): void {
  rig.rotation.set(pose.pitch, pose.yaw, 0)
}
