import { versionToNumber } from '../../lib/utils'

export const LOCAL_MOVEMENT_TWEEN_DURATION_MS = 50
export const ENTITY_TWEEN_DURATION_MS = 120
export const SPECTATING_CAMERA_TWEEN_DURATION_MS = 150
export const CAMERA_POSITION_EPSILON = 1e-4

export type CameraMovementMode = 'local-player' | 'server-vehicle' | 'spectating'

export type UpdateCameraOptions = {
  movementMode?: CameraMovementMode
  instant?: boolean
}

export type Vec3Like = { x: number; y: number; z: number }

export type EntityRenderHints = {
  localVehicle?: boolean
  localVehicleVerticalCameraLock?: 'horse'
  /** Render-only: lock locally controlled horse yaw to camera each frame. */
  localVehicleYawLock?: 'horse'
  boatWaterPatchVisible?: boolean
  boatPaddleLeft?: boolean
  boatPaddleRight?: boolean
  passengerIds?: number[]
  passengerLayout?: 'boat' | 'minecart' | 'horse'
  /** @deprecated Use passengerIds */
  boatPassengerIds?: number[]
}

export type EntityWithRenderHints = {
  renderHints?: EntityRenderHints
}

export function usesCameraSyncedVehiclePosition(entity: EntityWithRenderHints | undefined): boolean {
  return !!entity?.renderHints?.localVehicle
}

export function shouldApplyLocalHorseCameraYawLock(renderHints: EntityRenderHints | undefined): boolean {
  return renderHints?.localVehicleYawLock === 'horse'
}

/** Visual-only: align local horse model yaw with camera before head pose and passengers. */
export function applyLocalHorseCameraYawLock(sceneEntity: { rotation: { y: number }; userData: Record<string, unknown> }, cameraYaw: number): boolean {
  if (!Number.isFinite(cameraYaw)) return false
  sceneEntity.rotation.y = cameraYaw
  sceneEntity.userData._horseBodyYaw = cameraYaw
  sceneEntity.userData._horseHeadYaw = cameraYaw
  return true
}

export function getEntityTweenDurationMs(entity: EntityWithRenderHints | undefined, justAdded: boolean): number {
  if (justAdded) return 0
  if (usesCameraSyncedVehiclePosition(entity)) return 0
  return ENTITY_TWEEN_DURATION_MS
}

/** Rotation follows the same instant-vs-remote policy as entity position. */
export function getEntityRotationTweenDurationMs(entity: EntityWithRenderHints | undefined, justAdded: boolean): number {
  return getEntityTweenDurationMs(entity, justAdded)
}

export function samePosition(a: Vec3Like, b: Vec3Like, epsilon = CAMERA_POSITION_EPSILON): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon && Math.abs(a.z - b.z) < epsilon
}

export function getCameraMovementTweenDurationMs(mode: CameraMovementMode, instant = false): number {
  if (instant) return 0
  switch (mode) {
    case 'spectating':
      return SPECTATING_CAMERA_TWEEN_DURATION_MS
    case 'server-vehicle':
      return ENTITY_TWEEN_DURATION_MS
    case 'local-player':
    default:
      return LOCAL_MOVEMENT_TWEEN_DURATION_MS
  }
}

export function shouldRestartCameraPositionTween(args: {
  target: Vec3Like
  currentTarget: Vec3Like | null
  movementMode: CameraMovementMode
  previousMovementMode: CameraMovementMode | null
  instant: boolean
}): boolean {
  if (args.instant) return true
  if (args.currentTarget == null) return true
  if (args.movementMode !== args.previousMovementMode) return true
  return !samePosition(args.target, args.currentTarget)
}

/** Locally ridden vehicle X/Z follow camera tween; Y uses latest server vehicle height. */
export function getLocalVehicleWorldPosition(cameraWorldPos: Vec3Like, vehicleY: number): Vec3Like {
  return {
    x: cameraWorldPos.x,
    y: vehicleY,
    z: cameraWorldPos.z
  }
}

export function resolveLocalVehicleWorldPosition(args: {
  cameraWorldPos: Vec3Like
  rawVehicleY: number
  eyeHeight: number
  vehicleName: string | undefined
  vehicleHeight: number
  verticalCameraLock?: 'horse'
}): Vec3Like {
  const { cameraWorldPos, rawVehicleY, eyeHeight, vehicleName, vehicleHeight, verticalCameraLock } = args
  if (verticalCameraLock === 'horse') {
    const y = cameraWorldPos.y - eyeHeight - getHorsePassengerFeetOffsetY(vehicleName, vehicleHeight)
    if (Number.isFinite(y)) {
      return { x: cameraWorldPos.x, y, z: cameraWorldPos.z }
    }
  }
  return getLocalVehicleWorldPosition(cameraWorldPos, rawVehicleY)
}

const RIDEABLE_MINECART_ENTITY_NAMES = new Set([
  'minecart',
  'chest_minecart',
  'furnace_minecart',
  'hopper_minecart',
  'tnt_minecart',
  'spawner_minecart',
  'command_block_minecart'
])

const RIDEABLE_HORSE_ENTITY_NAMES = new Set(['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse'])

export function isRideableHorseEntityName(name?: string): boolean {
  if (!name) return false
  return RIDEABLE_HORSE_ENTITY_NAMES.has(name)
}

export function isRideableMinecartEntityName(name?: string): boolean {
  if (!name) return false
  return RIDEABLE_MINECART_ENTITY_NAMES.has(name)
}

export function getBoatPassengerSeatOffset(passengerIndex: number, passengerCount: number): number {
  if (passengerCount <= 1) return 0
  return passengerIndex === 0 ? 0.2 : -0.6
}

const DEFAULT_BOAT_HEIGHT = 0.5625
const DEFAULT_MINECART_HEIGHT = 0.7

// <= 1.20.1: Entity#positionRider = y + vehicle.getPassengersRidingOffset() + passenger.getMyRidingOffset()
// Vanilla 1.17.1 sources: vehicle/Boat#getPassengersRidingOffset() = -0.1,
// vehicle/AbstractMinecart#getPassengersRidingOffset() = 0, player/Player#getMyRidingOffset() = -0.35.
const LEGACY_PLAYER_RIDING_OFFSET_Y = -0.35 // Player#getMyRidingOffset(), <= 1.20.1
const LEGACY_BOAT_RIDING_OFFSET_Y = -0.1 // Boat#getPassengersRidingOffset(), <= 1.20.1
const LEGACY_MINECART_RIDING_OFFSET_Y = 0 // AbstractMinecart#getPassengersRidingOffset(), <= 1.20.1

// >= 1.20.2: y is based on the vehicle's PASSENGER attachment point.
// The player's contribution is numerically the same, but the mechanism changed:
//   1.20.2-1.20.4: PASSENGER.y + Player#ridingOffset() (-0.6)
//   >= 1.20.5:     PASSENGER.y - Player.DEFAULT_VEHICLE_ATTACHMENT.y (0.6)
// Vanilla sources: Entity#positionRider, Boat#getPassengerAttachmentPoint,
// EntityType.*_MINECART#passengerAttachments and Player#ridingOffset / DEFAULT_VEHICLE_ATTACHMENT.
const MODERN_PLAYER_RIDING_OFFSET_Y = -0.6
const MODERN_MINECART_PASSENGER_ATTACHMENT_Y = 0.1875 // EntityType.*_MINECART.passengerAttachments()
const MODERN_BOAT_RIDE_HEIGHT_FACTOR = 1 / 3 // (Abstract)Boat#rideHeight(), >= 1.20.2
const MODERN_RAFT_RIDE_HEIGHT_FACTOR = 0.8888889 // Raft#rideHeight(), >= 1.21.2

/**
 * Vanilla seat offset for a player passenger in a boat or minecart.
 * Rafts before 1.21.2 are intentionally treated as boats because their entity
 * name is 'boat' and their metadata variant is not read by this project.
 */
export function getVehiclePassengerFeetOffsetY(
  layout: 'boat' | 'minecart',
  version: string,
  vehicleName: string | undefined,
  vehicleHeight: number | undefined
): number {
  const height = Number.isFinite(vehicleHeight) ? vehicleHeight! : layout === 'boat' ? DEFAULT_BOAT_HEIGHT : DEFAULT_MINECART_HEIGHT

  if (versionToNumber(version) >= versionToNumber('1.20.2')) {
    const isRaft = typeof vehicleName === 'string' && vehicleName.toLowerCase().endsWith('_raft')
    const passengerAttachmentY =
      layout === 'boat' ? height * (isRaft ? MODERN_RAFT_RIDE_HEIGHT_FACTOR : MODERN_BOAT_RIDE_HEIGHT_FACTOR) : MODERN_MINECART_PASSENGER_ATTACHMENT_Y
    return passengerAttachmentY + MODERN_PLAYER_RIDING_OFFSET_Y
  }

  const vehicleRidingOffset = layout === 'boat' ? LEGACY_BOAT_RIDING_OFFSET_Y : LEGACY_MINECART_RIDING_OFFSET_Y
  return vehicleRidingOffset + LEGACY_PLAYER_RIDING_OFFSET_Y
}

/** Vanilla Boat#positionRider position, without applying the passenger pose. */
export function getBoatPassengerWorldPosition(
  boatWorldPos: Vec3Like,
  boatYaw: number,
  passengerIndex: number,
  passengerCount: number,
  version: string,
  vehicleName: string | undefined,
  vehicleHeight: number | undefined
): Vec3Like {
  const seatOffset = getBoatPassengerSeatOffset(passengerIndex, passengerCount)
  return {
    x: boatWorldPos.x - Math.sin(boatYaw) * seatOffset,
    y: boatWorldPos.y + getVehiclePassengerFeetOffsetY('boat', version, vehicleName, vehicleHeight),
    z: boatWorldPos.z + Math.cos(boatYaw) * seatOffset
  }
}

/** Vanilla minecart positionRider for a centered player passenger. */
export function getMinecartPassengerWorldPosition(
  minecartWorldPos: Vec3Like,
  version: string,
  vehicleName: string | undefined,
  vehicleHeight: number | undefined
): Vec3Like {
  return {
    x: minecartWorldPos.x,
    y: minecartWorldPos.y + getVehiclePassengerFeetOffsetY('minecart', version, vehicleName, vehicleHeight),
    z: minecartWorldPos.z
  }
}

function getHorsePassengerFeetOffsetY(name: string | undefined, height: number): number {
  let variantOffset = 0
  if (name === 'donkey' || name === 'mule') {
    variantOffset = 0.25
  } else if (name === 'skeleton_horse') {
    variantOffset = 0.1875
  }
  return height * 0.75 - variantOffset - 0.35
}

/** Vanilla 1.17.1 AbstractHorse positionRider feet Y for a centered player passenger. */
export function getHorsePassengerWorldPosition(vehicleWorldPos: Vec3Like, name: string | undefined, height = 1.6): Vec3Like {
  return {
    x: vehicleWorldPos.x,
    y: vehicleWorldPos.y + getHorsePassengerFeetOffsetY(name, height),
    z: vehicleWorldPos.z
  }
}
