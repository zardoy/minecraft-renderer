import * as THREE from 'three'
import { expect, test } from 'vitest'
import {
  applyLocalHorseCameraYawLock,
  shouldApplyLocalHorseCameraYawLock,
  type EntityRenderHints
} from './interpolationPolicy'

function makeHorseSceneEntity(initialYaw = 0) {
  const entity = new THREE.Group()
  entity.rotation.y = initialYaw
  entity.userData = {
    _horseBodyYaw: initialYaw,
    _horseHeadYaw: initialYaw
  }
  return entity
}

test('local controlled horse yaw equals camera yaw without entityMoved', () => {
  const entity = makeHorseSceneEntity(1.2)
  const cameraYaw = 2.5

  expect(applyLocalHorseCameraYawLock(entity, cameraYaw)).toBe(true)
  expect(entity.rotation.y).toBe(cameraYaw)
  expect(entity.userData._horseBodyYaw).toBe(cameraYaw)
  expect(entity.userData._horseHeadYaw).toBe(cameraYaw)
})

test('two sequential camera yaw changes immediately update the model', () => {
  const entity = makeHorseSceneEntity(0)

  applyLocalHorseCameraYawLock(entity, 1.0)
  expect(entity.rotation.y).toBe(1.0)

  applyLocalHorseCameraYawLock(entity, 1.5)
  expect(entity.rotation.y).toBe(1.5)
  expect(entity.userData._horseBodyYaw).toBe(1.5)
  expect(entity.userData._horseHeadYaw).toBe(1.5)
})

test('wrap ±π assigns camera yaw directly without shortest-path adjustment', () => {
  const entity = makeHorseSceneEntity(Math.PI - 0.01)
  const cameraYaw = -Math.PI + 0.01

  applyLocalHorseCameraYawLock(entity, cameraYaw)

  expect(entity.rotation.y).toBeCloseTo(cameraYaw, 5)
  expect(entity.userData._horseBodyYaw).toBeCloseTo(cameraYaw, 5)
  expect(entity.userData._horseHeadYaw).toBeCloseTo(cameraYaw, 5)
})

test('non-finite camera yaw is ignored', () => {
  const entity = makeHorseSceneEntity(1.25)

  expect(applyLocalHorseCameraYawLock(entity, Number.NaN)).toBe(false)
  expect(applyLocalHorseCameraYawLock(entity, Number.POSITIVE_INFINITY)).toBe(false)
  expect(entity.rotation.y).toBe(1.25)
  expect(entity.userData._horseBodyYaw).toBe(1.25)
  expect(entity.userData._horseHeadYaw).toBe(1.25)
})

test('shouldApplyLocalHorseCameraYawLock is true only for local horse yaw lock hint', () => {
  expect(shouldApplyLocalHorseCameraYawLock({ localVehicleYawLock: 'horse' })).toBe(true)
  expect(shouldApplyLocalHorseCameraYawLock({ localVehicle: true, passengerLayout: 'horse' })).toBe(false)
  expect(shouldApplyLocalHorseCameraYawLock({ localVehicle: true, localVehicleVerticalCameraLock: 'horse' })).toBe(false)
  expect(shouldApplyLocalHorseCameraYawLock(undefined)).toBe(false)
})

test.each([
  ['remote horse', { passengerLayout: 'horse' } satisfies EntityRenderHints],
  ['local boat', { localVehicle: true, passengerLayout: 'boat' } satisfies EntityRenderHints],
  ['local minecart', { localVehicle: true, passengerLayout: 'minecart' } satisfies EntityRenderHints],
])('%s does not receive yaw lock', (_label, renderHints) => {
  expect(shouldApplyLocalHorseCameraYawLock(renderHints)).toBe(false)
})
