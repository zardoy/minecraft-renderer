import * as THREE from 'three'
import { expect, test } from 'vitest'
import { SceneOrigin } from '../sceneOrigin'
import { getBoatPassengerWorldPosition, getMinecartPassengerWorldPosition } from './interpolationPolicy'
import { anchorVehiclePassengerPosition, shouldSkipLocalPassengerAnchoring } from './vehiclePassengerRendering'
import { updateVehiclePassengerPositions, type VehiclePassengerSceneEntity, type VehiclePassengerVehicle } from './vehiclePassengerUpdate'

const LOCAL_PLAYER_ID = 7
const REMOTE_PLAYER_ID = 8

type PassengerLike = THREE.Group & VehiclePassengerSceneEntity

function makePassenger(id: number): PassengerLike {
  const passenger = new THREE.Group() as PassengerLike
  passenger.playerObject = {}
  passenger.originalEntity = { id }
  passenger.userData = {}
  passenger.rotation.y = 0
  return passenger
}

function makeVehicle(id: number, name: string, renderHints: Record<string, unknown>): VehiclePassengerVehicle & THREE.Group {
  const vehicle = new THREE.Group() as VehiclePassengerVehicle & THREE.Group
  vehicle.originalEntity = { id, name, height: name === 'donkey' ? 1.5 : 1.6 }
  vehicle.userData = { renderHints }
  vehicle.realName = name
  vehicle.rotation.y = 0
  return vehicle
}

function createHarness() {
  const sceneOrigin = new SceneOrigin(new THREE.Scene())
  sceneOrigin.update(96, 60, 192)

  const localPlayer = makePassenger(LOCAL_PLAYER_ID)
  sceneOrigin.track(localPlayer)

  const entities: Record<string, VehiclePassengerSceneEntity | VehiclePassengerVehicle> = {}
  const cameraWorldPos = { x: 100, y: 65.62, z: 200 }

  const runUpdate = () =>
    updateVehiclePassengerPositions({
      entities,
      localPlayer,
      getWorldPosition: target => sceneOrigin.getWorldPosition(target as THREE.Object3D)
    })

  return { sceneOrigin, localPlayer, entities, cameraWorldPos, runUpdate }
}

test('shouldSkipLocalPassengerAnchoring keeps horse on camera path', () => {
  expect(shouldSkipLocalPassengerAnchoring('boat')).toBe(false)
  expect(shouldSkipLocalPassengerAnchoring('minecart')).toBe(false)
  expect(shouldSkipLocalPassengerAnchoring('horse')).toBe(true)
})

test('updateVehiclePassengerPositions anchors local boat and minecart passengers', () => {
  const { sceneOrigin, localPlayer, entities, runUpdate } = createHarness()

  const boat = makeVehicle(10, 'oak_boat', { passengerLayout: 'boat', passengerIds: [LOCAL_PLAYER_ID] })
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)
  entities['10'] = boat

  runUpdate()

  const expectedBoatSeat = getBoatPassengerWorldPosition(sceneOrigin.getWorldPosition(boat)!, boat.rotation.y, 0, 1)
  expect(localPlayer.userData._passengerVehicleId).toBe('10')
  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(expectedBoatSeat)

  const minecart = makeVehicle(42, 'minecart', { passengerLayout: 'minecart', passengerIds: [LOCAL_PLAYER_ID] })
  sceneOrigin.track(minecart)
  minecart.position.set(103, 64.5, 205)
  entities['42'] = minecart
  boat.userData.renderHints = { passengerLayout: 'boat', passengerIds: [] }

  runUpdate()

  const expectedMinecartSeat = getMinecartPassengerWorldPosition(sceneOrigin.getWorldPosition(minecart)!)
  expect(localPlayer.userData._passengerVehicleId).toBe('42')
  expect(sceneOrigin.getWorldPosition(localPlayer)).toEqual(expectedMinecartSeat)
})

test('updateVehiclePassengerPositions keeps local horse on existing skip path', () => {
  const { sceneOrigin, localPlayer, entities, cameraWorldPos, runUpdate } = createHarness()
  const eyeHeight = 1.62
  localPlayer.position.set(cameraWorldPos.x, cameraWorldPos.y - eyeHeight, cameraWorldPos.z)

  const horse = makeVehicle(42, 'horse', {
    passengerLayout: 'horse',
    passengerIds: [LOCAL_PLAYER_ID],
    localVehicle: true,
    localVehicleVerticalCameraLock: 'horse'
  })
  sceneOrigin.track(horse)
  horse.position.set(100, 64, 200)
  entities['42'] = horse

  runUpdate()

  expect(localPlayer.userData._passengerVehicleId).toBeUndefined()
  expect(sceneOrigin.getWorldPosition(localPlayer)?.y).toBeCloseTo(cameraWorldPos.y - eyeHeight, 5)
})

test('local and remote boat passengers use the same seat algorithm per index', () => {
  const { sceneOrigin, localPlayer, entities, runUpdate } = createHarness()
  const remotePlayer = makePassenger(REMOTE_PLAYER_ID)
  sceneOrigin.track(remotePlayer)
  entities[String(REMOTE_PLAYER_ID)] = remotePlayer

  const boat = makeVehicle(10, 'oak_boat', { passengerLayout: 'boat', passengerIds: [LOCAL_PLAYER_ID, REMOTE_PLAYER_ID] })
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)
  entities['10'] = boat

  runUpdate()

  const vehicleWorldPos = sceneOrigin.getWorldPosition(boat)!
  const localWorld = sceneOrigin.getWorldPosition(localPlayer)!
  const remoteWorld = sceneOrigin.getWorldPosition(remotePlayer)!
  expect(localWorld).toEqual(getBoatPassengerWorldPosition(vehicleWorldPos, boat.rotation.y, 0, 2))
  expect(remoteWorld).toEqual(getBoatPassengerWorldPosition(vehicleWorldPos, boat.rotation.y, 1, 2))
  expect(localWorld.y).toBeCloseTo(63.55, 5)
  expect(remoteWorld.y).toBeCloseTo(63.55, 5)
})

test('vehicle movement updates body anchor without horizontal jitter across frames', () => {
  const { sceneOrigin, localPlayer, entities, runUpdate } = createHarness()

  const boat = makeVehicle(10, 'oak_boat', { passengerLayout: 'boat', passengerIds: [LOCAL_PLAYER_ID], localVehicle: true })
  sceneOrigin.track(boat)
  entities['10'] = boat

  const xs = [100, 100.4, 100.9, 101.1, 100.8]
  const deltas: number[] = []
  let previousX: number | undefined

  for (const x of xs) {
    boat.position.set(x, 64, 200)
    runUpdate()
    const world = sceneOrigin.getWorldPosition(localPlayer)!
    if (previousX !== undefined) {
      deltas.push(world.x - previousX)
    }
    previousX = world.x
  }

  for (const delta of deltas) {
    expect(delta).toBeCloseTo(Math.round(delta * 10) / 10, 5)
  }
  expect(deltas.map(delta => Math.round(delta * 10) / 10)).toEqual([0.4, 0.5, 0.2, -0.3])
})

test('dismount and vehicle removal release local passenger anchor', () => {
  const { sceneOrigin, localPlayer, entities, cameraWorldPos, runUpdate } = createHarness()
  const eyeHeight = 1.62
  localPlayer.position.set(cameraWorldPos.x, cameraWorldPos.y - eyeHeight, cameraWorldPos.z)

  const boat = makeVehicle(10, 'oak_boat', { passengerLayout: 'boat', passengerIds: [LOCAL_PLAYER_ID] })
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)
  entities['10'] = boat

  runUpdate()
  expect(localPlayer.userData._passengerVehicleId).toBe('10')

  boat.userData.renderHints = { passengerLayout: 'boat', passengerIds: [] }
  runUpdate()
  expect(localPlayer.userData._passengerVehicleId).toBeUndefined()

  localPlayer.position.set(cameraWorldPos.x, cameraWorldPos.y - eyeHeight, cameraWorldPos.z)
  const releasedWorld = sceneOrigin.getWorldPosition(localPlayer)!
  expect(releasedWorld.y).toBeCloseTo(cameraWorldPos.y - eyeHeight, 5)

  delete entities['10']
  runUpdate()
  expect(localPlayer.userData._passengerVehicleId).toBeUndefined()
})

test('scene origin rebase preserves passenger world position', () => {
  const { sceneOrigin, localPlayer, entities, runUpdate } = createHarness()

  const boat = makeVehicle(10, 'oak_boat', { passengerLayout: 'boat', passengerIds: [LOCAL_PLAYER_ID] })
  sceneOrigin.track(boat)
  boat.position.set(100, 64, 200)
  entities['10'] = boat

  runUpdate()
  const beforeRebase = { ...sceneOrigin.getWorldPosition(localPlayer)! }

  sceneOrigin.update(112, 70, 208)
  runUpdate()
  const afterRebase = sceneOrigin.getWorldPosition(localPlayer)!

  expect(afterRebase).toEqual(beforeRebase)
})

test('non-finite vehicle position does not create passenger anchor', () => {
  const { localPlayer, entities, runUpdate } = createHarness()

  const boat = makeVehicle(10, 'oak_boat', { passengerLayout: 'boat', passengerIds: [LOCAL_PLAYER_ID] })
  boat.position.set(Number.NaN, 64, 200)
  entities['10'] = boat

  runUpdate()
  expect(localPlayer.userData._passengerVehicleId).toBeUndefined()
})

test('anchorVehiclePassengerPosition ignores non-finite coordinates', () => {
  const passenger = makePassenger(LOCAL_PLAYER_ID)
  anchorVehiclePassengerPosition(passenger, { x: 1, y: Number.NaN, z: 2 }, '10')
  expect(passenger.userData._passengerVehicleId).toBeUndefined()
})
