import * as THREE from 'three'
import { PlayerObject } from 'skinview3d'
import { expect, test } from 'vitest'
import type { PlayerObjectType } from '../../lib/createPlayerObject'
import { WalkingGeneralSwing } from './animations'
import { anchorVehiclePassengerPosition } from './vehiclePassengerRendering'
import { applyNetworkHeadPitch, storeNetworkHeadPitch, storeNetworkHeadYaw, type NetworkHeadRotationState } from './networkHeadPitchRendering'
import { getMinecartPassengerWorldPosition } from './interpolationPolicy'

function makePlayerObject(): PlayerObjectType {
  const playerObject = new PlayerObject() as PlayerObjectType
  playerObject.skin.head.rotation.set(0, 0, 0)
  return playerObject
}

function simulateAnimationFrames(playerObject: PlayerObjectType, userData: NetworkHeadRotationState, frames: number, dt = 0.05) {
  const animation = new WalkingGeneralSwing()
  animation._captureDefaults(playerObject)
  for (let i = 0; i < frames; i++) {
    animation.update(playerObject, dt)
    applyNetworkHeadPitch(playerObject, userData)
  }
}

test('remote head pitch persists across animation frames', () => {
  const playerObject = makePlayerObject()
  const userData: NetworkHeadRotationState = {}
  storeNetworkHeadPitch(userData, 0.6)

  simulateAnimationFrames(playerObject, userData, 5)

  expect(playerObject.skin.head.rotation.x).toBeCloseTo(-0.6)
  expect(playerObject.skin.head.rotation.y).toBe(0)
})

test('remote head pitch updates when network pitch changes', () => {
  const playerObject = makePlayerObject()
  const userData: NetworkHeadRotationState = {}
  storeNetworkHeadPitch(userData, 0.4)
  simulateAnimationFrames(playerObject, userData, 2)
  expect(playerObject.skin.head.rotation.x).toBeCloseTo(-0.4)

  storeNetworkHeadPitch(userData, -0.2)
  simulateAnimationFrames(playerObject, userData, 2)
  expect(playerObject.skin.head.rotation.x).toBeCloseTo(0.2)
})

test('remote head pitch supports looking straight ahead', () => {
  const playerObject = makePlayerObject()
  const userData: NetworkHeadRotationState = {}
  storeNetworkHeadPitch(userData, 0)
  simulateAnimationFrames(playerObject, userData, 3)
  expect(playerObject.skin.head.rotation.x).toBeCloseTo(0)
})

test('local player keeps camera pitch authoritative', () => {
  const playerObject = makePlayerObject()
  const userData: NetworkHeadRotationState = {}
  storeNetworkHeadPitch(userData, 0.8)

  const cameraPitch = -0.35
  playerObject.skin.head.rotation.x = -cameraPitch

  expect(playerObject.skin.head.rotation.x).toBeCloseTo(0.35)
})

test('minecart passenger anchor preserves head rotation', () => {
  const playerObject = makePlayerObject()
  const userData: NetworkHeadRotationState = {}
  const passenger = new THREE.Group()
  passenger.userData = userData

  storeNetworkHeadPitch(userData, 0.45)
  applyNetworkHeadPitch(playerObject, userData)

  const seat = getMinecartPassengerWorldPosition({ x: 10, y: 64, z: 20 })
  anchorVehiclePassengerPosition(passenger, seat, '42')
  simulateAnimationFrames(playerObject, userData, 4)

  expect(passenger.position.x).toBe(10)
  expect(passenger.position.y).toBeCloseTo(63.65)
  expect(playerObject.skin.head.rotation.x).toBeCloseTo(-0.45)
})

test('storeNetworkHeadYaw keeps last finite head yaw and ignores invalid updates', () => {
  const userData: NetworkHeadRotationState = {}
  storeNetworkHeadYaw(userData, 1.2)
  expect(userData._networkHeadYaw).toBeCloseTo(1.2)

  storeNetworkHeadYaw(userData, Number.NaN, undefined)
  expect(userData._networkHeadYaw).toBeCloseTo(1.2)

  storeNetworkHeadYaw(userData, undefined, 0.8)
  expect(userData._networkHeadYaw).toBeCloseTo(0.8)
})

test('storeNetworkHeadYaw prefers explicit head yaw over fallback', () => {
  const userData: NetworkHeadRotationState = {}
  storeNetworkHeadYaw(userData, 0.5, 1.5)
  expect(userData._networkHeadYaw).toBeCloseTo(0.5)
})
