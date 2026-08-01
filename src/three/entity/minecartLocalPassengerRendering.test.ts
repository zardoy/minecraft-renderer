import * as THREE from 'three'
import { expect, test } from 'vitest'
import { SceneOrigin } from '../sceneOrigin'
import { anchorVehiclePassengerPosition, releaseVehiclePassengerPosition } from './vehiclePassengerRendering'
import { getBoatPassengerWorldPosition, getMinecartPassengerWorldPosition } from './interpolationPolicy'

const LOCAL_PLAYER_ID = 7
const REMOTE_PLAYER_ID = 8
const MINECART_ID = '42'
const EYE_HEIGHT = 1.62
const PLAYER_HEIGHT = 1.8

type PassengerLike = THREE.Group & {
  playerObject: Record<string, unknown>
  originalEntity: { id: number }
  userData: Record<string, unknown>
}

function makePassenger(id: number): PassengerLike {
  const passenger = new THREE.Group() as PassengerLike
  passenger.playerObject = {}
  passenger.originalEntity = { id }
  passenger.userData = {}
  return passenger
}

function resolveMinecartPassenger(
  passengerId: number,
  localPlayer: PassengerLike | null,
  remotePlayers: Record<number, PassengerLike>
): PassengerLike | undefined {
  const isLocalPassenger = passengerId === localPlayer?.originalEntity.id
  return isLocalPassenger ? (localPlayer ?? undefined) : remotePlayers[passengerId]
}

function anchorMinecartPassengers(
  minecart: THREE.Group,
  sceneOrigin: SceneOrigin,
  passengerIds: number[],
  localPlayer: PassengerLike | null,
  remotePlayers: Record<number, PassengerLike>
) {
  const vehicleWorldPos = sceneOrigin.getWorldPosition(minecart)!
  const seatPosition = getMinecartPassengerWorldPosition(vehicleWorldPos)
  for (const passengerId of passengerIds) {
    const passenger = resolveMinecartPassenger(passengerId, localPlayer, remotePlayers)
    if (!passenger?.playerObject) continue
    anchorVehiclePassengerPosition(passenger, seatPosition, MINECART_ID)
  }
  return seatPosition
}

test('local and remote minecart passengers share the same seat Y', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)
  minecart.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  const remotePlayer = makePassenger(REMOTE_PLAYER_ID)
  sceneOrigin.track(localPlayer)
  sceneOrigin.track(remotePlayer)

  const seatPosition = anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID, REMOTE_PLAYER_ID], localPlayer, { [REMOTE_PLAYER_ID]: remotePlayer })

  const localWorld = sceneOrigin.getWorldPosition(localPlayer)
  const remoteWorld = sceneOrigin.getWorldPosition(remotePlayer)
  expect(localWorld?.y).toBe(seatPosition.y)
  expect(remoteWorld?.y).toBe(seatPosition.y)
  expect(localWorld).toEqual(remoteWorld)
})

test('local third-person player follows interpolated minecart world position', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)
  minecart.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  sceneOrigin.track(localPlayer)

  anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})

  minecart.position.set(103, 64.5, 205)
  sceneOrigin.update(112, 70, 208)
  const movedSeat = anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})

  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(movedSeat)
  expect(movedSeat.x).toBe(103)
  expect(movedSeat.y).toBeCloseTo(64.15)
})

test('minecart seat places player waist-up inside the cart instead of on camera feet', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)
  minecart.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  sceneOrigin.track(localPlayer)

  const cameraWorldPos = { x: 100, y: 64 + 0.7 + EYE_HEIGHT, z: 200 }
  localPlayer.position.set(cameraWorldPos.x, cameraWorldPos.y - EYE_HEIGHT, cameraWorldPos.z)

  const seatPosition = anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})
  const anchoredWorld = sceneOrigin.getWorldPosition(localPlayer)!

  const minecartWorld = sceneOrigin.getWorldPosition(minecart)!
  const cameraFeetY = cameraWorldPos.y - EYE_HEIGHT

  expect(anchoredWorld.y).toBeLessThan(cameraFeetY)
  expect(anchoredWorld.y).toBe(seatPosition.y)
  const waistY = anchoredWorld.y + PLAYER_HEIGHT * 0.5
  expect(waistY).toBeGreaterThan(minecartWorld.y)
  expect(waistY).toBeGreaterThan(minecartWorld.y + 0.3)
  expect(waistY).toBeLessThan(minecartWorld.y + 0.85)
})

test('first and third person keep the same minecart passenger anchor', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)
  minecart.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  sceneOrigin.track(localPlayer)

  anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})
  const thirdPersonAnchor = { ...sceneOrigin.getWorldPosition(localPlayer)! }

  localPlayer.visible = false
  anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})

  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(thirdPersonAnchor)
  expect(localPlayer.userData._passengerVehicleId).toBe(MINECART_ID)
})

test('minecart dismount releases local player anchor without snapping back', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const minecart = new THREE.Group()
  sceneOrigin.track(minecart)
  minecart.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  sceneOrigin.track(localPlayer)

  anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})
  minecart.position.set(105, 65, 210)
  sceneOrigin.update(112, 70, 208)
  anchorMinecartPassengers(minecart, sceneOrigin, [LOCAL_PLAYER_ID], localPlayer, {})

  const detachedWorldPosition = sceneOrigin.getWorldPosition(localPlayer)
  expect(releaseVehiclePassengerPosition(localPlayer, MINECART_ID, detachedWorldPosition)).toBe(true)
  expect(localPlayer.userData._passengerVehicleId).toBeUndefined()
  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(detachedWorldPosition)

  minecart.position.set(120, 66, 220)
  sceneOrigin.update(128, 76, 228)
  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(detachedWorldPosition)
})

function shouldAnchorPassenger(passenger: PassengerLike | null | undefined, layout: 'boat' | 'minecart' | 'horse', isLocalPassenger: boolean): boolean {
  if (!passenger?.playerObject) return false
  if (isLocalPassenger && layout === 'horse') return false
  return true
}

test('local player is anchored for boat and minecart but skipped for horse', () => {
  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  expect(shouldAnchorPassenger(localPlayer, 'boat', true)).toBe(true)
  expect(shouldAnchorPassenger(localPlayer, 'minecart', true)).toBe(true)
  expect(shouldAnchorPassenger(localPlayer, 'horse', true)).toBe(false)
})

test('local boat passenger uses the same anchor as remote passenger', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const boat = new THREE.Group()
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  const remotePlayer = makePassenger(REMOTE_PLAYER_ID)
  sceneOrigin.track(localPlayer)
  sceneOrigin.track(remotePlayer)

  const boatSeat = getBoatPassengerWorldPosition(sceneOrigin.getWorldPosition(boat)!, boat.rotation.y, 0, 1)
  if (shouldAnchorPassenger(localPlayer, 'boat', true)) {
    anchorVehiclePassengerPosition(localPlayer, boatSeat, '10')
  }
  anchorVehiclePassengerPosition(remotePlayer, boatSeat, '10')

  expect(localPlayer.userData._passengerVehicleId).toBe('10')
  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(sceneOrigin.getWorldPosition(remotePlayer))
  expect(sceneOrigin.getWorldPosition(localPlayer)?.y).toBeCloseTo(63.55)
})
