import type * as THREE from 'three'
import type { PlayerObjectType } from '../../lib/createPlayerObject'
import { resolveBoatPassengerThirdPersonRotation, shouldApplyBoatPassengerRotation } from './boatPassengerRotation'
import { getNetworkHeadPitch, restoreGenericRemotePlayerHeadRotation, type NetworkHeadRotationState } from './networkHeadPitchRendering'

export type RemoteBoatPassengerEntity = {
  rotation: { y: number; set: (x: number, y: number, z: number) => unknown }
  visible: boolean
  playerObject?: PlayerObjectType
  userData: NetworkHeadRotationState & {
    _passengerVehicleId?: string
    _boatPassengerVehicleId?: string
    _rotTween?: { stop: () => unknown }
  }
}

export type RemoteBoatPassengerVehicle = {
  rotation: { y: number }
  realName?: string
  originalEntity: { name: string }
}

export function getAnchoredVehicleId(userData: RemoteBoatPassengerEntity['userData']): string | undefined {
  return userData._passengerVehicleId ?? userData._boatPassengerVehicleId
}

export function stopRemotePassengerRotationTween(userData: RemoteBoatPassengerEntity['userData']): void {
  userData._rotTween?.stop()
  userData._rotTween = undefined
}

export function applyRemoteBoatPassengerRotation(params: {
  passenger: RemoteBoatPassengerEntity
  vehicle: RemoteBoatPassengerVehicle
  vehicleYaw: number
  networkHeadYaw: number
}): void {
  const { passenger, networkHeadYaw, vehicleYaw } = params
  const playerObject = passenger.playerObject
  if (!playerObject) return

  stopRemotePassengerRotationTween(passenger.userData)

  const resolved = resolveBoatPassengerThirdPersonRotation({
    cameraYaw: networkHeadYaw,
    cameraPitch: getNetworkHeadPitch(passenger.userData),
    vehicleYaw
  })

  passenger.rotation.set(0, resolved.bodyYaw, 0)
  playerObject.skin.head.rotation.set(resolved.headPitch, resolved.headYaw, 0)
  passenger.userData._remoteBoatRotationApplied = true
}

export function restoreGenericRemotePassengerRotation(passenger: RemoteBoatPassengerEntity): void {
  const playerObject = passenger.playerObject
  if (!playerObject) return

  stopRemotePassengerRotationTween(passenger.userData)

  const networkHeadYaw = passenger.userData._networkHeadYaw
  if (typeof networkHeadYaw === 'number' && Number.isFinite(networkHeadYaw)) {
    passenger.rotation.set(0, networkHeadYaw, 0)
  }

  restoreGenericRemotePlayerHeadRotation(playerObject, passenger.userData)
  passenger.userData._remoteBoatRotationApplied = false
}

export function processRemoteBoatPassengerRotation(params: {
  passenger: RemoteBoatPassengerEntity
  vehicle: RemoteBoatPassengerVehicle | undefined
  syncArmor?: () => void
}): void {
  const { passenger, vehicle, syncArmor } = params
  if (!passenger.playerObject) return

  const userData = passenger.userData
  const wasApplied = userData._remoteBoatRotationApplied === true
  const anchoredVehicleId = getAnchoredVehicleId(userData)
  const vehicleName = vehicle?.realName ?? vehicle?.originalEntity.name
  const vehicleYaw = vehicle?.rotation.y
  const gatePasses = shouldApplyBoatPassengerRotation({
    isAnchoredPassenger: anchoredVehicleId != null && vehicle != null,
    vehicleName,
    vehicleYaw
  })

  if (!gatePasses) {
    if (wasApplied) {
      restoreGenericRemotePassengerRotation(passenger)
      syncArmor?.()
    }
    return
  }

  const networkHeadYaw = userData._networkHeadYaw
  if (typeof networkHeadYaw !== 'number' || !Number.isFinite(networkHeadYaw)) {
    return
  }

  applyRemoteBoatPassengerRotation({
    passenger,
    vehicle: vehicle!,
    vehicleYaw: vehicleYaw!,
    networkHeadYaw
  })
  syncArmor?.()
}

export function processRemoteBoatPassengerRotations(params: {
  entities: Record<string, RemoteBoatPassengerEntity | undefined>
  syncArmor: (passenger: RemoteBoatPassengerEntity) => void
}): void {
  for (const entity of Object.values(params.entities)) {
    if (!entity?.playerObject) continue

    const anchoredVehicleId = getAnchoredVehicleId(entity.userData)
    const vehicle = anchoredVehicleId != null ? (params.entities[anchoredVehicleId] as RemoteBoatPassengerVehicle | undefined) : undefined

    processRemoteBoatPassengerRotation({
      passenger: entity,
      vehicle,
      syncArmor: entity.visible ? () => params.syncArmor(entity) : undefined
    })
  }
}
