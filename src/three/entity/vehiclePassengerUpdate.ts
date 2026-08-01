import { isBoatEntityName } from './boatModelRotation'
import {
  getBoatPassengerWorldPosition,
  getHorsePassengerWorldPosition,
  getMinecartPassengerWorldPosition,
  isRideableHorseEntityName,
  isRideableMinecartEntityName,
  type EntityRenderHints,
  type Vec3Like
} from './interpolationPolicy'
import {
  anchorVehiclePassengerPosition,
  isFiniteVec3,
  releaseVehiclePassengerPosition,
  shouldSkipLocalPassengerAnchoring,
  type VehiclePassengerRenderState
} from './vehiclePassengerRendering'

export type VehiclePassengerSceneEntity = VehiclePassengerRenderState & {
  playerObject?: unknown
  originalEntity: { id: number }
}

export type VehiclePassengerVehicle = {
  originalEntity: { id: number | string; name: string; height?: number }
  userData: { renderHints?: EntityRenderHints }
  rotation: { y: number }
  realName?: string
}

export function updateVehiclePassengerPositions(args: {
  entities: Record<string, VehiclePassengerSceneEntity | VehiclePassengerVehicle>
  localPlayer: VehiclePassengerSceneEntity | null
  getWorldPosition: (target: unknown) => Vec3Like | undefined
}): Set<VehiclePassengerSceneEntity> {
  const attachedPassengers = new Set<VehiclePassengerSceneEntity>()

  for (const entity of Object.values(args.entities)) {
    const vehicle = entity as VehiclePassengerVehicle
    const renderHints = vehicle.userData.renderHints
    const passengerIds = renderHints?.passengerIds ?? renderHints?.boatPassengerIds
    if (!Array.isArray(passengerIds) || passengerIds.length === 0) continue

    const vehicleName = vehicle.realName ?? vehicle.originalEntity.name
    const layout = renderHints?.passengerLayout ?? (isBoatEntityName(vehicleName) ? 'boat' : undefined)
    if (layout !== 'boat' && layout !== 'minecart' && layout !== 'horse') continue
    if (layout === 'boat' && !isBoatEntityName(vehicleName)) continue
    if (layout === 'minecart' && !isRideableMinecartEntityName(vehicleName)) continue
    if (layout === 'horse' && !isRideableHorseEntityName(vehicleName)) continue

    const vehicleWorldPos = args.getWorldPosition(vehicle)
    if (!isFiniteVec3(vehicleWorldPos)) continue
    const vehicleId = String(vehicle.originalEntity.id)

    for (const [passengerIndex, passengerId] of passengerIds.entries()) {
      const isLocalPassenger = passengerId === args.localPlayer?.originalEntity.id
      const passenger = isLocalPassenger ? args.localPlayer : (args.entities[passengerId] as VehiclePassengerSceneEntity | undefined)
      if (!passenger?.playerObject) continue
      if (passenger === args.localPlayer && shouldSkipLocalPassengerAnchoring(layout)) continue

      const passengerWorldPos =
        layout === 'minecart'
          ? getMinecartPassengerWorldPosition(vehicleWorldPos)
          : layout === 'horse'
            ? getHorsePassengerWorldPosition(vehicleWorldPos, vehicleName, vehicle.originalEntity.height ?? 1.6)
            : getBoatPassengerWorldPosition(vehicleWorldPos, vehicle.rotation.y, passengerIndex, passengerIds.length)

      if (!isFiniteVec3(passengerWorldPos)) continue
      anchorVehiclePassengerPosition(passenger, passengerWorldPos, vehicleId)
      attachedPassengers.add(passenger)
    }
  }

  for (const passenger of [...Object.values(args.entities), ...(args.localPlayer ? [args.localPlayer] : [])] as VehiclePassengerSceneEntity[]) {
    const vehicleId = passenger.userData._passengerVehicleId ?? (passenger.userData._boatPassengerVehicleId as string | undefined)
    if (vehicleId === undefined || attachedPassengers.has(passenger)) continue
    releaseVehiclePassengerPosition(passenger, vehicleId, args.getWorldPosition(passenger))
  }

  return attachedPassengers
}
