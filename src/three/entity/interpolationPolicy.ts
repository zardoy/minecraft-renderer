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

const BOAT_PASSENGER_RIDING_OFFSET_Y = -0.1
const PLAYER_RIDING_OFFSET_Y = -0.35
/** Vanilla 1.17.1 AbstractMinecart#getPassengersRidingOffset() */
const MINECART_PASSENGER_RIDING_OFFSET_Y = 0

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

/** Vanilla 1.17.1 Boat#positionRider position, without applying the passenger pose. */
export function getBoatPassengerWorldPosition(boatWorldPos: Vec3Like, boatYaw: number, passengerIndex: number, passengerCount: number): Vec3Like {
  const seatOffset = getBoatPassengerSeatOffset(passengerIndex, passengerCount)
  return {
    x: boatWorldPos.x - Math.sin(boatYaw) * seatOffset,
    y: boatWorldPos.y + BOAT_PASSENGER_RIDING_OFFSET_Y + PLAYER_RIDING_OFFSET_Y,
    z: boatWorldPos.z + Math.cos(boatYaw) * seatOffset
  }
}

/** Vanilla 1.17.1 minecart positionRider for a centered player passenger. */
export function getMinecartPassengerWorldPosition(minecartWorldPos: Vec3Like): Vec3Like {
  return {
    x: minecartWorldPos.x,
    y: minecartWorldPos.y + MINECART_PASSENGER_RIDING_OFFSET_Y + PLAYER_RIDING_OFFSET_Y,
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
