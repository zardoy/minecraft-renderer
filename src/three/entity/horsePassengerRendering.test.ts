import * as THREE from 'three'
import { expect, test } from 'vitest'
import { SceneOrigin } from '../sceneOrigin'
import { anchorVehiclePassengerPosition, releaseVehiclePassengerPosition } from './vehiclePassengerRendering'
import { getHorsePassengerWorldPosition } from './interpolationPolicy'

const LOCAL_PLAYER_ID = 7
const REMOTE_PLAYER_ID = 8
const HORSE_ID = '42'
const HORSE_HEIGHT = 1.6

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

test.each([
  ['horse', 1.6, 0.85],
  ['zombie_horse', 1.6, 0.85],
  ['donkey', 1.5, 0.525],
  ['mule', 1.6, 0.6],
  ['skeleton_horse', 1.6, 0.6625]
])('horse variant %s seat Y uses vanilla offset', (name, height, expectedFeetOffset) => {
  const seat = getHorsePassengerWorldPosition({ x: 0, y: 64, z: 0 }, name, height)
  expect(seat.y).toBeCloseTo(64 + expectedFeetOffset, 5)
})

test('local and remote horse passengers share the same anchor', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const horse = new THREE.Group()
  sceneOrigin.track(horse)
  horse.position.set(100, 64, 200)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  const remotePlayer = makePassenger(REMOTE_PLAYER_ID)
  sceneOrigin.track(localPlayer)
  sceneOrigin.track(remotePlayer)

  const vehicleWorldPos = sceneOrigin.getWorldPosition(horse)!
  const seatPosition = getHorsePassengerWorldPosition(vehicleWorldPos, 'horse', HORSE_HEIGHT)

  anchorVehiclePassengerPosition(localPlayer, seatPosition, HORSE_ID)
  anchorVehiclePassengerPosition(remotePlayer, seatPosition, HORSE_ID)

  const localWorld = sceneOrigin.getWorldPosition(localPlayer)
  const remoteWorld = sceneOrigin.getWorldPosition(remotePlayer)
  expect(localWorld).toEqual(remoteWorld)
})

test('passenger anchor releases after detach', () => {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(0, 0, 0)

  const horse = new THREE.Group()
  sceneOrigin.track(horse)
  horse.position.set(0, 64, 0)

  const passenger = makePassenger(LOCAL_PLAYER_ID)
  sceneOrigin.track(passenger)

  const seatPosition = getHorsePassengerWorldPosition({ x: 0, y: 64, z: 0 }, 'horse', HORSE_HEIGHT)
  anchorVehiclePassengerPosition(passenger, seatPosition, HORSE_ID)
  releaseVehiclePassengerPosition(passenger, HORSE_ID, sceneOrigin.getWorldPosition(passenger))
  expect(passenger.userData._passengerVehicleId).toBeUndefined()
})
