import { expect, test } from 'vitest'
import {
  ENTITY_TWEEN_DURATION_MS,
  LOCAL_MOVEMENT_TWEEN_DURATION_MS,
  SPECTATING_CAMERA_TWEEN_DURATION_MS,
  getCameraMovementTweenDurationMs,
  getEntityRotationTweenDurationMs,
  getEntityTweenDurationMs,
  getHorsePassengerWorldPosition,
  getLocalVehicleWorldPosition,
  getMinecartPassengerWorldPosition,
  resolveLocalVehicleWorldPosition,
  samePosition,
  shouldRestartCameraPositionTween,
  usesCameraSyncedVehiclePosition
} from './interpolationPolicy'

test('local movement tween matches camera tween duration', () => {
  expect(LOCAL_MOVEMENT_TWEEN_DURATION_MS).toBe(50)
})

test('ordinary entity tween stays at 120 ms', () => {
  expect(ENTITY_TWEEN_DURATION_MS).toBe(120)
})

test('server-vehicle camera uses entity tween duration', () => {
  expect(getCameraMovementTweenDurationMs('server-vehicle')).toBe(120)
  expect(getCameraMovementTweenDurationMs('local-player')).toBe(50)
  expect(getCameraMovementTweenDurationMs('spectating')).toBe(SPECTATING_CAMERA_TWEEN_DURATION_MS)
})

test('forced teleport camera update is instant', () => {
  expect(getCameraMovementTweenDurationMs('server-vehicle', true)).toBe(0)
  expect(getCameraMovementTweenDurationMs('local-player', true)).toBe(0)
})

test('same target does not restart camera tween', () => {
  const target = { x: 1, y: 63.7, z: 2 }
  expect(
    shouldRestartCameraPositionTween({
      target,
      currentTarget: { ...target },
      movementMode: 'server-vehicle',
      previousMovementMode: 'server-vehicle',
      instant: false
    })
  ).toBe(false)
})

test('dismount switches camera tween mode back to local-player', () => {
  const target = { x: 1, y: 63.7, z: 2 }
  expect(
    shouldRestartCameraPositionTween({
      target,
      currentTarget: { ...target },
      movementMode: 'local-player',
      previousMovementMode: 'server-vehicle',
      instant: false
    })
  ).toBe(true)
  expect(getCameraMovementTweenDurationMs('local-player')).toBe(50)
})

test('sequential minecart targets restart tween only when position changes', () => {
  const first = { x: 0, y: 63.7, z: 0 }
  const second = { x: 1, y: 63.7, z: 0 }
  expect(
    shouldRestartCameraPositionTween({
      target: first,
      currentTarget: null,
      movementMode: 'server-vehicle',
      previousMovementMode: null,
      instant: false
    })
  ).toBe(true)
  expect(
    shouldRestartCameraPositionTween({
      target: first,
      currentTarget: first,
      movementMode: 'server-vehicle',
      previousMovementMode: 'server-vehicle',
      instant: false
    })
  ).toBe(false)
  expect(
    shouldRestartCameraPositionTween({
      target: second,
      currentTarget: first,
      movementMode: 'server-vehicle',
      previousMovementMode: 'server-vehicle',
      instant: false
    })
  ).toBe(true)
  expect(second.x).toBeGreaterThan(first.x)
})

test('samePosition uses epsilon comparison', () => {
  expect(samePosition({ x: 1, y: 2, z: 3 }, { x: 1.00001, y: 2.00001, z: 3.00001 })).toBe(true)
  expect(samePosition({ x: 1, y: 2, z: 3 }, { x: 1.01, y: 2, z: 3 })).toBe(false)
})

test('local vehicle skips position tween', () => {
  expect(usesCameraSyncedVehiclePosition({ renderHints: { localVehicle: true } })).toBe(true)
  expect(getEntityTweenDurationMs({ renderHints: { localVehicle: true } }, false)).toBe(0)
  expect(getEntityTweenDurationMs({ renderHints: { localVehicle: true } }, true)).toBe(0)
})

test('local vehicle skips rotation tween while remote vehicles keep it', () => {
  expect(getEntityRotationTweenDurationMs({ renderHints: { localVehicle: true } }, false)).toBe(0)
  expect(getEntityRotationTweenDurationMs({ renderHints: { localVehicle: false } }, false)).toBe(ENTITY_TWEEN_DURATION_MS)
  expect(getEntityRotationTweenDurationMs(undefined, true)).toBe(0)
})

test('locally ridden vehicle camera-sync policy stays separate from server-vehicle mode', () => {
  expect(usesCameraSyncedVehiclePosition({ renderHints: { localVehicle: true } })).toBe(true)
  expect(usesCameraSyncedVehiclePosition({ renderHints: { localVehicle: true, passengerLayout: 'minecart' } })).toBe(true)
  expect(usesCameraSyncedVehiclePosition({ renderHints: { passengerLayout: 'minecart' } })).toBe(false)
  expect(getCameraMovementTweenDurationMs('local-player')).toBe(50)
})

test('remote entities keep ordinary tween duration', () => {
  expect(usesCameraSyncedVehiclePosition({ renderHints: { localVehicle: false } })).toBe(false)
  expect(getEntityTweenDurationMs({ renderHints: { localVehicle: false } }, false)).toBe(120)
  expect(getEntityTweenDurationMs({}, false)).toBe(120)
  expect(getEntityTweenDurationMs(undefined, false)).toBe(120)
})

test('local vehicle world position uses camera X/Z and vehicle Y', () => {
  const camera = { x: 10, y: 64.5, z: -3 }
  expect(getLocalVehicleWorldPosition(camera, 63.2)).toEqual({
    x: 10,
    y: 63.2,
    z: -3
  })
})

test('intermediate camera frames keep boat X/Z aligned with player', () => {
  const vehicleY = 63.2
  const start = getLocalVehicleWorldPosition({ x: 0, y: 64, z: 0 }, vehicleY)
  const mid = getLocalVehicleWorldPosition({ x: 0.5, y: 64, z: 0 }, vehicleY)
  const end = getLocalVehicleWorldPosition({ x: 1, y: 64, z: 0 }, vehicleY)

  expect(start.x).toBe(0)
  expect(mid.x).toBe(0.5)
  expect(end.x).toBe(1)
  expect(start.z).toBe(mid.z)
  expect(mid.z).toBe(end.z)
  expect(start.y).toBe(vehicleY)
  expect(mid.y).toBe(vehicleY)
  expect(end.y).toBe(vehicleY)
})

test('horse vertical camera lock keeps constant offset from camera across tween progress', () => {
  const eyeHeight = 1.62
  const feetOffset = 0.85
  const expectedGap = -(eyeHeight + feetOffset)
  const rawVehicleY = 64
  const cameraStartY = rawVehicleY + feetOffset + eyeHeight
  const tweenProgress = [0, 0.25, 0.5, 0.75, 1]

  for (const progress of tweenProgress) {
    const cameraY = cameraStartY + progress * 0.8
    const resolved = resolveLocalVehicleWorldPosition({
      cameraWorldPos: { x: 1 + progress, y: cameraY, z: 2 },
      rawVehicleY,
      eyeHeight,
      vehicleName: 'horse',
      vehicleHeight: 1.6,
      verticalCameraLock: 'horse'
    })
    expect(resolved.y - cameraY).toBeCloseTo(expectedGap, 5)
    expect(resolved.x).toBe(1 + progress)
    expect(resolved.z).toBe(2)
  }
})

test('horse vertical camera lock uses vanilla feet offset value', () => {
  const eyeHeight = 1.62
  const cameraY = 66.47
  const resolved = resolveLocalVehicleWorldPosition({
    cameraWorldPos: { x: 0, y: cameraY, z: 0 },
    rawVehicleY: 64,
    eyeHeight,
    vehicleName: 'horse',
    vehicleHeight: 1.6,
    verticalCameraLock: 'horse'
  })
  expect(resolved.y).toBeCloseTo(cameraY - 2.47, 5)
})

test('horse vertical camera lock is variant-aware for donkey and skeleton_horse', () => {
  const eyeHeight = 1.62
  const cameraY = 65

  const donkey = resolveLocalVehicleWorldPosition({
    cameraWorldPos: { x: 0, y: cameraY, z: 0 },
    rawVehicleY: 64,
    eyeHeight,
    vehicleName: 'donkey',
    vehicleHeight: 1.6,
    verticalCameraLock: 'horse'
  })
  expect(donkey.y).toBeCloseTo(cameraY - eyeHeight - 0.6, 5)

  const skeleton = resolveLocalVehicleWorldPosition({
    cameraWorldPos: { x: 0, y: cameraY, z: 0 },
    rawVehicleY: 64,
    eyeHeight,
    vehicleName: 'skeleton_horse',
    vehicleHeight: 1.6,
    verticalCameraLock: 'horse'
  })
  expect(skeleton.y).toBeCloseTo(cameraY - eyeHeight - 0.6625, 5)
})

test('without vertical camera lock resolver keeps raw vehicle Y', () => {
  const camera = { x: 10, y: 64.5, z: -3 }
  const rawVehicleY = 63.2
  expect(
    resolveLocalVehicleWorldPosition({
      cameraWorldPos: camera,
      rawVehicleY,
      eyeHeight: 1.62,
      vehicleName: 'horse',
      vehicleHeight: 1.6
    })
  ).toEqual(getLocalVehicleWorldPosition(camera, rawVehicleY))
})

test('horse vertical camera lock falls back to raw Y when result is non-finite', () => {
  const camera = { x: 1, y: 64, z: 2 }
  const rawVehicleY = 63.5
  expect(
    resolveLocalVehicleWorldPosition({
      cameraWorldPos: camera,
      rawVehicleY,
      eyeHeight: Number.NaN,
      vehicleName: 'horse',
      vehicleHeight: 1.6,
      verticalCameraLock: 'horse'
    })
  ).toEqual(getLocalVehicleWorldPosition(camera, rawVehicleY))
})

test('minecart passenger feet Y is vehicleY - 0.35', () => {
  expect(getMinecartPassengerWorldPosition({ x: 0, y: 64, z: 0 }).y).toBeCloseTo(63.65, 5)
})

test.each([
  ['horse', 1.6, 0.85],
  ['zombie_horse', 1.6, 0.85],
  ['donkey', 1.5, 0.525],
  ['mule', 1.6, 0.6],
  ['skeleton_horse', 1.6, 0.6625]
])('horse variant %s feet offset matches vanilla 1.17.1', (name, height, expectedFeetOffset) => {
  const seat = getHorsePassengerWorldPosition({ x: 0, y: 64, z: 0 }, name, height)
  expect(seat.y).toBeCloseTo(64 + expectedFeetOffset, 5)
})
