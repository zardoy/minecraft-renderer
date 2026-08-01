import * as THREE from 'three'
import { expect, test, vi } from 'vitest'
import { SceneOrigin } from '../sceneOrigin'
import { anchorVehiclePassengerPosition, releaseVehiclePassengerPosition } from './vehiclePassengerRendering'
import {
  ENTITY_TWEEN_DURATION_MS,
  getBoatPassengerWorldPosition,
  getEntityTweenDurationMs,
  getLocalVehicleWorldPosition,
  getMinecartPassengerWorldPosition,
  usesCameraSyncedVehiclePosition
} from './interpolationPolicy'

type Vec3 = { x: number; y: number; z: number }

function staleOffsetVehiclePosition(cameraWorldPos: Vec3, vehiclePosition: Vec3, stalePassengerPosition: Vec3): Vec3 {
  return {
    x: cameraWorldPos.x + (vehiclePosition.x - stalePassengerPosition.x),
    y: cameraWorldPos.y + (vehiclePosition.y - stalePassengerPosition.y),
    z: cameraWorldPos.z + (vehiclePosition.z - stalePassengerPosition.z)
  }
}

test('stale passenger snapshot does not shift rendered locally ridden vehicle X/Z relative to camera', () => {
  const stalePassenger = { x: 0, y: 63, z: 0 }
  const newVehicle = { x: 1, y: 63.2, z: 2 }
  const cameraWorldPos = { x: 0.4, y: 63.5, z: 0.8 }

  // 1. Vehicle position updates before passenger sync.
  // 2. Renderer receives vehicle snapshot while passenger is still stale.
  const broken = staleOffsetVehiclePosition(cameraWorldPos, newVehicle, stalePassenger)
  const rendered = getLocalVehicleWorldPosition(cameraWorldPos, newVehicle.y)

  expect(rendered.x).toBe(cameraWorldPos.x)
  expect(rendered.z).toBe(cameraWorldPos.z)
  expect(rendered.y).toBe(newVehicle.y)
  expect(broken.x).not.toBe(cameraWorldPos.x)
  expect(broken.z).not.toBe(cameraWorldPos.z)

  // 3. Passenger synchronizes to vehicle.
  const syncedPassenger = { ...newVehicle, y: 63 }
  const syncedCamera = { x: 0.8, y: 63.5, z: 1.6 }

  // 4. Boat X/Z remain fixed relative to the player/camera on intermediate frames.
  const afterSync = getLocalVehicleWorldPosition(syncedCamera, newVehicle.y)
  expect(afterSync.x - syncedCamera.x).toBe(0)
  expect(afterSync.z - syncedCamera.z).toBe(0)
  expect(afterSync.y).toBe(newVehicle.y)
  expect(syncedPassenger.x).toBe(newVehicle.x)
  expect(syncedPassenger.z).toBe(newVehicle.z)
})

test('render frames between press and release keep zero horizontal delta to camera for local boat', () => {
  const vehicleY = 62.75
  const frames = [
    { x: 0, y: 63.4, z: 0 },
    { x: 0.2, y: 63.4, z: 0 },
    { x: 0.45, y: 63.4, z: 0 },
    { x: 0.7, y: 63.4, z: 0 },
    { x: 0.7, y: 63.4, z: 0 },
    { x: 0.55, y: 63.4, z: 0 }
  ]

  for (const camera of frames) {
    const boat = getLocalVehicleWorldPosition(camera, vehicleY)
    expect(boat.x - camera.x).toBe(0)
    expect(boat.z - camera.z).toBe(0)
    expect(boat.y).toBe(vehicleY)
    expect(boat.y).not.toBe(camera.y)
  }
})

test('boat passenger positions use vanilla 1.17.1 riding and seat offsets', () => {
  const boat = { x: 10, y: 64, z: 20 }

  expect(getBoatPassengerWorldPosition(boat, 0, 0, 1)).toEqual({
    x: 10,
    y: 63.55,
    z: 20
  })
  expect(getBoatPassengerWorldPosition(boat, 0, 0, 2)).toEqual({
    x: 10,
    y: 63.55,
    z: 20.2
  })
  expect(getBoatPassengerWorldPosition(boat, 0, 1, 2)).toEqual({
    x: 10,
    y: 63.55,
    z: 19.4
  })

  const rotated = getBoatPassengerWorldPosition(boat, Math.PI / 2, 0, 2)
  expect(rotated.x).toBeCloseTo(9.8)
  expect(rotated.y).toBe(63.55)
  expect(rotated.z).toBeCloseTo(20)
})

test('remote player follows the tracked boat each frame and releases from an empty passenger list', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const boat = new THREE.Group()
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)

  const passenger = new THREE.Group()
  const stopPositionTween = vi.fn()
  passenger.userData._posTween = { stop: stopPositionTween }
  sceneOrigin.track(passenger)
  passenger.position.set(90, 64, 190)

  const firstPassengerPosition = getBoatPassengerWorldPosition(sceneOrigin.getWorldPosition(boat)!, boat.rotation.y, 0, 1)
  anchorVehiclePassengerPosition(passenger, firstPassengerPosition, '10')

  expect(stopPositionTween).toHaveBeenCalledOnce()
  expect(sceneOrigin.getWorldPosition(passenger)).toEqual({ x: 100, y: 63.55, z: 200 })
  expect(passenger.userData._tweenTarget).toEqual({ x: 100, y: 63.55, z: 200 })

  boat.position.set(102, 64.2, 203)
  boat.rotation.y = Math.PI / 2
  const movedPassengerPosition = getBoatPassengerWorldPosition(sceneOrigin.getWorldPosition(boat)!, boat.rotation.y, 0, 1)
  anchorVehiclePassengerPosition(passenger, movedPassengerPosition, '10')
  expect(sceneOrigin.getWorldPosition(passenger)?.x).toBe(102)
  expect(sceneOrigin.getWorldPosition(passenger)?.y).toBeCloseTo(63.75)
  expect(sceneOrigin.getWorldPosition(passenger)?.z).toBe(203)

  sceneOrigin.update(112, 70, 208)
  expect(sceneOrigin.getWorldPosition(passenger)?.x).toBe(102)
  expect(sceneOrigin.getWorldPosition(passenger)?.y).toBeCloseTo(63.75)
  expect(sceneOrigin.getWorldPosition(passenger)?.z).toBe(203)

  const detachedWorldPosition = sceneOrigin.getWorldPosition(passenger)
  expect(releaseVehiclePassengerPosition(passenger, '10', detachedWorldPosition)).toBe(true)
  expect(passenger.userData._passengerVehicleId).toBeUndefined()
  expect(passenger.userData._boatPassengerVehicleId).toBeUndefined()
  expect(passenger.userData._tweenTarget).toEqual(detachedWorldPosition)

  boat.position.set(110, 65, 210)
  expect(sceneOrigin.getWorldPosition(passenger)).toEqual(detachedWorldPosition)
})

test('minecart passenger uses vanilla 1.17.1 riding Y offset', () => {
  const minecart = { x: 10, y: 64, z: 20 }
  expect(getMinecartPassengerWorldPosition(minecart)).toEqual({
    x: 10,
    y: 63.65,
    z: 20
  })
})

test('minecart passenger anchor follows vehicle world position without inheriting vehicle yaw', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)
  minecart.position.set(100, 64, 200)
  minecart.rotation.y = Math.PI / 2

  const passenger = new THREE.Group()
  passenger.rotation.y = 1.25
  sceneOrigin.track(passenger)
  passenger.position.set(90, 64, 190)

  const firstPosition = getMinecartPassengerWorldPosition(sceneOrigin.getWorldPosition(minecart)!)
  anchorVehiclePassengerPosition(passenger, firstPosition, '42')
  const anchoredYaw = passenger.rotation.y

  minecart.position.set(103, 64.5, 205)
  minecart.rotation.y = Math.PI
  const movedPosition = getMinecartPassengerWorldPosition(sceneOrigin.getWorldPosition(minecart)!)
  anchorVehiclePassengerPosition(passenger, movedPosition, '42')

  expect(sceneOrigin.getWorldPosition(passenger)).toEqual({
    x: 103,
    y: 64.15,
    z: 205
  })
  expect(passenger.rotation.y).toBe(anchoredYaw)

  const detachedWorldPosition = sceneOrigin.getWorldPosition(passenger)
  expect(releaseVehiclePassengerPosition(passenger, '42', detachedWorldPosition)).toBe(true)
  expect(sceneOrigin.getWorldPosition(passenger)).toEqual(detachedWorldPosition)

  minecart.position.set(120, 66, 220)
  expect(sceneOrigin.getWorldPosition(passenger)).toEqual(detachedWorldPosition)
})

test('local minecart with localVehicle uses camera-synced positioning', () => {
  expect(usesCameraSyncedVehiclePosition({ renderHints: { localVehicle: true, passengerLayout: 'minecart' } })).toBe(true)
  expect(getEntityTweenDurationMs({ renderHints: { localVehicle: true, passengerLayout: 'minecart' } }, false)).toBe(0)
})

test('remote minecart keeps ordinary entity interpolation', () => {
  expect(usesCameraSyncedVehiclePosition({ renderHints: { passengerLayout: 'minecart' } })).toBe(false)
  expect(getEntityTweenDurationMs({ renderHints: { passengerLayout: 'minecart' } }, false)).toBe(ENTITY_TWEEN_DURATION_MS)
})

test('local minecart X/Z stay aligned with camera on intermediate frames between server targets', () => {
  const vehicleY = 63.7
  const cameraFrames = [
    { x: 0, y: 64.3, z: 0 },
    { x: 1.2, y: 64.3, z: 0.6 },
    { x: 5, y: 64.3, z: 3 },
    { x: 4.1, y: 64.3, z: 2.5 }
  ]

  for (const camera of cameraFrames) {
    const minecart = getLocalVehicleWorldPosition(camera, vehicleY)
    expect(minecart.x - camera.x).toBeCloseTo(0, 5)
    expect(minecart.z - camera.z).toBeCloseTo(0, 5)
    expect(minecart.y).toBe(vehicleY)
  }
})

test('local minecart passenger anchors to camera-synced vehicle position', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)

  const passenger = new THREE.Group()
  sceneOrigin.track(passenger)

  const vehicleY = 64
  const cameraFrames = [
    { x: 100, y: 64.7, z: 200 },
    { x: 101.4, y: 64.7, z: 200.8 },
    { x: 103, y: 64.7, z: 202 }
  ]

  for (const camera of cameraFrames) {
    const syncedMinecart = getLocalVehicleWorldPosition(camera, vehicleY)
    minecart.position.set(syncedMinecart.x, syncedMinecart.y, syncedMinecart.z)
    const seatPosition = getMinecartPassengerWorldPosition(syncedMinecart)
    anchorVehiclePassengerPosition(passenger, seatPosition, '42')
    const passengerWorld = sceneOrigin.getWorldPosition(passenger)!

    expect(syncedMinecart.x - camera.x).toBeCloseTo(0, 5)
    expect(syncedMinecart.z - camera.z).toBeCloseTo(0, 5)
    expect(passengerWorld.x).toBe(syncedMinecart.x)
    expect(passengerWorld.z).toBe(syncedMinecart.z)
    expect(passengerWorld.y).toBeCloseTo(63.65)
  }
})
