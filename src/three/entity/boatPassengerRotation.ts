import { isBoatEntityName } from './boatModelRotation'

/** Vanilla 1.17.1 `Boat.clampRotation` limit (degrees → radians). */
export const BOAT_PASSENGER_MAX_HEAD_YAW_RAD = (105 * Math.PI) / 180

export function normalizeYawDelta(from: number, to: number): number {
  let delta = to - from
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

export function normalizeYaw(yaw: number): number {
  return normalizeYawDelta(0, yaw)
}

export function clampBoatPassengerRelativeHeadYaw(relativeYaw: number): number {
  return Math.max(-BOAT_PASSENGER_MAX_HEAD_YAW_RAD, Math.min(BOAT_PASSENGER_MAX_HEAD_YAW_RAD, relativeYaw))
}

/** Clamp absolute look yaw for a boat passenger (vanilla `Boat.clampRotation`). */
export function getClampedBoatPassengerYaw(requestedYaw: number, boatYaw: number): number {
  if (!Number.isFinite(requestedYaw) || !Number.isFinite(boatYaw)) return requestedYaw
  const relative = normalizeYawDelta(boatYaw, requestedYaw)
  const clampedRelative = clampBoatPassengerRelativeHeadYaw(relative)
  return normalizeYaw(boatYaw + clampedRelative)
}

export type BoatPassengerThirdPersonRotation = {
  bodyYaw: number
  headYaw: number
  headPitch: number
  effectiveCameraYaw: number
}

export function resolveBoatPassengerThirdPersonRotation(params: {
  cameraYaw: number
  cameraPitch: number
  vehicleYaw: number
}): BoatPassengerThirdPersonRotation {
  const { cameraYaw, cameraPitch, vehicleYaw } = params
  const relativeHeadYaw = normalizeYawDelta(vehicleYaw, cameraYaw)
  const headYaw = clampBoatPassengerRelativeHeadYaw(relativeHeadYaw)
  const effectiveCameraYaw = normalizeYaw(vehicleYaw + headYaw)
  return {
    bodyYaw: vehicleYaw,
    headYaw,
    headPitch: -cameraPitch,
    effectiveCameraYaw
  }
}

export function shouldApplyBoatPassengerRotation(params: {
  isAnchoredPassenger: boolean
  vehicleName: string | undefined
  vehicleYaw: number | undefined
}): boolean {
  return params.isAnchoredPassenger && isBoatEntityName(params.vehicleName) && typeof params.vehicleYaw === 'number' && Number.isFinite(params.vehicleYaw)
}

export function shouldApplyBoatPassengerThirdPersonRotation(params: {
  isThirdPerson: boolean
  isAnchoredPassenger: boolean
  vehicleName: string | undefined
  vehicleYaw: number | undefined
}): boolean {
  return params.isThirdPerson && shouldApplyBoatPassengerRotation(params)
}

export { isBoatEntityName }
