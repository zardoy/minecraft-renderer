import * as THREE from 'three'
import { PlayerObject } from 'skinview3d'
import { expect, test } from 'vitest'
import type { PlayerObjectType } from '../../lib/createPlayerObject'
import { BOAT_PASSENGER_MAX_HEAD_YAW_RAD, clampBoatPassengerRelativeHeadYaw, normalizeYawDelta } from './boatPassengerRotation'
import { storeNetworkHeadPitch, storeNetworkHeadYaw } from './networkHeadPitchRendering'
import {
  applyRemoteBoatPassengerRotation,
  processRemoteBoatPassengerRotation,
  processRemoteBoatPassengerRotations,
  restoreGenericRemotePassengerRotation,
  type RemoteBoatPassengerEntity,
  type RemoteBoatPassengerVehicle
} from './remoteBoatPassengerRotation'
import { anchorVehiclePassengerPosition } from './vehiclePassengerRendering'
import { updateVehiclePassengerPositions } from './vehiclePassengerUpdate'
import { SceneOrigin } from '../sceneOrigin'

const BOAT_YAW = -0.5645049299419149
const REMOTE_PLAYER_A = 8
const REMOTE_PLAYER_B = 9
const BOAT_ID = 10

function makePlayerObject(): PlayerObjectType {
  return new PlayerObject() as PlayerObjectType
}

function makeRemotePassenger(id: number, lookYaw = BOAT_YAW) {
  const passenger = new THREE.Group() as RemoteBoatPassengerEntity & THREE.Group & { originalEntity: { id: number } }
  passenger.playerObject = makePlayerObject()
  passenger.originalEntity = { id }
  passenger.userData = {}
  passenger.visible = true
  passenger.rotation.y = lookYaw
  storeNetworkHeadYaw(passenger.userData, lookYaw)
  return passenger
}

function makeBoat(passengerIds: number[], yaw = BOAT_YAW) {
  const boat = new THREE.Group() as RemoteBoatPassengerVehicle & THREE.Group & { originalEntity: { id: number; name: string; height: number } }
  boat.originalEntity = { id: BOAT_ID, name: 'oak_boat', height: 1.6 }
  boat.userData = {
    renderHints: {
      passengerLayout: 'boat',
      passengerIds
    }
  }
  boat.realName = 'oak_boat'
  boat.rotation.y = yaw
  return boat
}

function createHarness(passengerIds: number[]) {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const entities: Record<string, RemoteBoatPassengerEntity & THREE.Group & { originalEntity: { id: number } }> = {}
  for (const id of passengerIds) {
    const passenger = makeRemotePassenger(id)
    sceneOrigin.track(passenger)
    entities[String(id)] = passenger
  }

  const boat = makeBoat(passengerIds)
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)
  entities[String(BOAT_ID)] = boat

  const runPassengerUpdate = () =>
    updateVehiclePassengerPositions({
      entities: entities as Parameters<typeof updateVehiclePassengerPositions>[0]['entities'],
      localPlayer: null,
      getWorldPosition: target => sceneOrigin.getWorldPosition(target as THREE.Object3D)
    })

  const runRemoteRotation = () =>
    processRemoteBoatPassengerRotations({
      entities,
      syncArmor: () => undefined
    })

  return { sceneOrigin, entities, boat, runPassengerUpdate, runRemoteRotation }
}

test('remote anchored boat passenger uses boat yaw for body and relative head yaw', () => {
  const lookYaw = BOAT_YAW + 0.6
  const { entities, boat, runPassengerUpdate, runRemoteRotation } = createHarness([REMOTE_PLAYER_A])
  const passenger = entities[String(REMOTE_PLAYER_A)]!
  storeNetworkHeadYaw(passenger.userData, lookYaw)
  passenger.rotation.y = lookYaw

  runPassengerUpdate()
  runRemoteRotation()

  expect(passenger.userData._remoteBoatRotationApplied).toBe(true)
  expect(passenger.rotation.y).toBeCloseTo(BOAT_YAW)
  expect(passenger.playerObject!.skin.head.rotation.y).toBeCloseTo(clampBoatPassengerRelativeHeadYaw(normalizeYawDelta(BOAT_YAW, lookYaw)))
  expect(boat.rotation.y).toBeCloseTo(BOAT_YAW)
})

test('remote boat passenger head yaw updates when boat turns without new look packet', () => {
  const lookYaw = BOAT_YAW + 0.4
  const { entities, boat, runPassengerUpdate, runRemoteRotation } = createHarness([REMOTE_PLAYER_A])
  const passenger = entities[String(REMOTE_PLAYER_A)]!
  storeNetworkHeadYaw(passenger.userData, lookYaw)

  runPassengerUpdate()
  runRemoteRotation()
  expect(passenger.rotation.y).toBeCloseTo(BOAT_YAW)

  boat.rotation.y = BOAT_YAW + 0.7
  runPassengerUpdate()
  runRemoteRotation()

  expect(passenger.rotation.y).toBeCloseTo(BOAT_YAW + 0.7)
  expect(passenger.playerObject!.skin.head.rotation.y).toBeCloseTo(clampBoatPassengerRelativeHeadYaw(normalizeYawDelta(BOAT_YAW + 0.7, lookYaw)))
})

test('two remote passengers keep independent head yaw on the same boat', () => {
  const lookA = BOAT_YAW + 0.3
  const lookB = BOAT_YAW - 0.5
  const { entities, runPassengerUpdate, runRemoteRotation } = createHarness([REMOTE_PLAYER_A, REMOTE_PLAYER_B])
  const passengerA = entities[String(REMOTE_PLAYER_A)]!
  const passengerB = entities[String(REMOTE_PLAYER_B)]!

  storeNetworkHeadYaw(passengerA.userData, lookA)
  storeNetworkHeadYaw(passengerB.userData, lookB)

  runPassengerUpdate()
  runRemoteRotation()

  expect(passengerA.playerObject!.skin.head.rotation.y).toBeCloseTo(clampBoatPassengerRelativeHeadYaw(normalizeYawDelta(BOAT_YAW, lookA)))
  expect(passengerB.playerObject!.skin.head.rotation.y).toBeCloseTo(clampBoatPassengerRelativeHeadYaw(normalizeYawDelta(BOAT_YAW, lookB)))
})

test('dismount restores generic remote body yaw and zero head yaw', () => {
  const lookYaw = BOAT_YAW + 0.55
  const { entities, boat, runPassengerUpdate, runRemoteRotation } = createHarness([REMOTE_PLAYER_A])
  const passenger = entities[String(REMOTE_PLAYER_A)]!
  storeNetworkHeadYaw(passenger.userData, lookYaw)
  storeNetworkHeadPitch(passenger.userData, 0.25)

  runPassengerUpdate()
  runRemoteRotation()
  expect(passenger.rotation.y).toBeCloseTo(BOAT_YAW)
  expect(passenger.userData._remoteBoatRotationApplied).toBe(true)

  boat.userData.renderHints = { passengerLayout: 'boat', passengerIds: [] }
  runPassengerUpdate()
  runRemoteRotation()

  expect(passenger.userData._remoteBoatRotationApplied).toBe(false)
  expect(passenger.rotation.y).toBeCloseTo(lookYaw)
  expect(passenger.playerObject!.skin.head.rotation.y).toBe(0)
  expect(passenger.playerObject!.skin.head.rotation.x).toBeCloseTo(-0.25)
})

test('missing network yaw on first frame keeps generic pose until look arrives', () => {
  const passenger = makeRemotePassenger(REMOTE_PLAYER_A, BOAT_YAW + 0.9)
  delete passenger.userData._networkHeadYaw
  const boat = makeBoat([REMOTE_PLAYER_A])
  anchorVehiclePassengerPosition(passenger, { x: 0, y: 0, z: 0 }, String(BOAT_ID))

  processRemoteBoatPassengerRotation({
    passenger,
    vehicle: boat,
    syncArmor: () => undefined
  })

  expect(passenger.userData._remoteBoatRotationApplied).toBeUndefined()
  expect(passenger.rotation.y).toBeCloseTo(BOAT_YAW + 0.9)
  expect(passenger.playerObject!.skin.head.rotation.y).toBe(0)
})

test('restoreGenericRemotePassengerRotation uses stored network yaw', () => {
  const lookYaw = BOAT_YAW + 1.1
  const passenger = makeRemotePassenger(REMOTE_PLAYER_A, BOAT_YAW)
  storeNetworkHeadYaw(passenger.userData, lookYaw)
  storeNetworkHeadPitch(passenger.userData, -0.15)
  passenger.userData._remoteBoatRotationApplied = true

  restoreGenericRemotePassengerRotation(passenger)

  expect(passenger.rotation.y).toBeCloseTo(lookYaw)
  expect(passenger.playerObject!.skin.head.rotation.y).toBe(0)
  expect(passenger.playerObject!.skin.head.rotation.x).toBeCloseTo(0.15)
  expect(passenger.userData._remoteBoatRotationApplied).toBe(false)
})

test('applyRemoteBoatPassengerRotation stops active rotation tween', () => {
  const lookYaw = BOAT_YAW + 0.2
  const passenger = makeRemotePassenger(REMOTE_PLAYER_A, lookYaw)
  const boat = makeBoat([REMOTE_PLAYER_A])
  let tweenStopped = false
  passenger.userData._rotTween = {
    stop: () => {
      tweenStopped = true
    }
  }

  applyRemoteBoatPassengerRotation({
    passenger,
    vehicle: boat,
    vehicleYaw: BOAT_YAW,
    networkHeadYaw: lookYaw
  })

  expect(tweenStopped).toBe(true)
  expect(passenger.userData._rotTween).toBeUndefined()
})

test('remote boat rotation clamps beyond ±105°', () => {
  const lookYaw = BOAT_YAW + 2.0
  const passenger = makeRemotePassenger(REMOTE_PLAYER_A, lookYaw)
  const boat = makeBoat([REMOTE_PLAYER_A])
  storeNetworkHeadYaw(passenger.userData, lookYaw)

  applyRemoteBoatPassengerRotation({
    passenger,
    vehicle: boat,
    vehicleYaw: BOAT_YAW,
    networkHeadYaw: lookYaw
  })

  expect(passenger.playerObject!.skin.head.rotation.y).toBeCloseTo(BOAT_PASSENGER_MAX_HEAD_YAW_RAD)
})
