import type { Vec3Like } from './interpolationPolicy'

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

export {
  anchorVehiclePassengerPosition as anchorBoatPassengerPosition,
  releaseVehiclePassengerPosition as releaseBoatPassengerPosition
} from './vehiclePassengerRendering'
