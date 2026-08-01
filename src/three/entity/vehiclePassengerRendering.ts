import type { Vec3Like } from './interpolationPolicy'

export type PassengerLayout = 'boat' | 'minecart' | 'horse'

export function shouldSkipLocalPassengerAnchoring(layout: PassengerLayout): boolean {
  return layout === 'horse'
}

export function isFiniteVec3(value: Vec3Like | undefined | null): value is Vec3Like {
  return value != null && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

export type VehiclePassengerRenderState = {
  position: {
    set: (x: number, y: number, z: number) => unknown
  }
  userData: {
    _posTween?: { stop: () => unknown }
    _tweenTarget?: Vec3Like
    _passengerVehicleId?: string
    /** @deprecated Use _passengerVehicleId */
    _boatPassengerVehicleId?: string
  }
}

export function anchorVehiclePassengerPosition(passenger: VehiclePassengerRenderState, passengerWorldPos: Vec3Like, vehicleId: string): void {
  if (!isFiniteVec3(passengerWorldPos)) return
  passenger.userData._posTween?.stop()
  passenger.userData._posTween = undefined
  passenger.userData._tweenTarget ??= { ...passengerWorldPos }
  Object.assign(passenger.userData._tweenTarget, passengerWorldPos)
  passenger.position.set(passengerWorldPos.x, passengerWorldPos.y, passengerWorldPos.z)
  passenger.userData._passengerVehicleId = vehicleId
  delete passenger.userData._boatPassengerVehicleId
}

export function releaseVehiclePassengerPosition(passenger: VehiclePassengerRenderState, vehicleId: string, currentWorldPos: Vec3Like | undefined): boolean {
  const anchoredVehicleId = passenger.userData._passengerVehicleId ?? passenger.userData._boatPassengerVehicleId
  if (anchoredVehicleId !== vehicleId) return false
  passenger.userData._posTween?.stop()
  passenger.userData._posTween = undefined
  if (currentWorldPos) {
    passenger.userData._tweenTarget ??= { ...currentWorldPos }
    Object.assign(passenger.userData._tweenTarget, currentWorldPos)
  }
  delete passenger.userData._passengerVehicleId
  delete passenger.userData._boatPassengerVehicleId
  return true
}

/** @deprecated Use anchorVehiclePassengerPosition */
export const anchorBoatPassengerPosition = anchorVehiclePassengerPosition

/** @deprecated Use releaseVehiclePassengerPosition */
export const releaseBoatPassengerPosition = releaseVehiclePassengerPosition
