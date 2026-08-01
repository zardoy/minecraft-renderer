import { expect, test } from 'vitest'
import {
  BOAT_PASSENGER_MAX_HEAD_YAW_RAD,
  clampBoatPassengerRelativeHeadYaw,
  getClampedBoatPassengerYaw,
  normalizeYaw,
  normalizeYawDelta,
  resolveBoatPassengerThirdPersonRotation,
  shouldApplyBoatPassengerRotation,
  shouldApplyBoatPassengerThirdPersonRotation
} from './boatPassengerRotation'

const BOAT_YAW = -0.5645049299419149

test('clamp relative head yaw at ±105° boundaries', () => {
  expect(clampBoatPassengerRelativeHeadYaw(BOAT_PASSENGER_MAX_HEAD_YAW_RAD)).toBeCloseTo(BOAT_PASSENGER_MAX_HEAD_YAW_RAD)
  expect(clampBoatPassengerRelativeHeadYaw(-BOAT_PASSENGER_MAX_HEAD_YAW_RAD)).toBeCloseTo(-BOAT_PASSENGER_MAX_HEAD_YAW_RAD)
})

test('clamp relative head yaw beyond both boundaries', () => {
  const over = BOAT_PASSENGER_MAX_HEAD_YAW_RAD + 0.5
  const under = -BOAT_PASSENGER_MAX_HEAD_YAW_RAD - 0.5
  expect(clampBoatPassengerRelativeHeadYaw(over)).toBeCloseTo(BOAT_PASSENGER_MAX_HEAD_YAW_RAD)
  expect(clampBoatPassengerRelativeHeadYaw(under)).toBeCloseTo(-BOAT_PASSENGER_MAX_HEAD_YAW_RAD)
})

test('normalizeYawDelta handles π/-π seam', () => {
  expect(normalizeYawDelta(Math.PI, -Math.PI)).toBeCloseTo(0)
  expect(normalizeYawDelta(-Math.PI, Math.PI)).toBeCloseTo(0)
  expect(normalizeYawDelta(0.1, 2 * Math.PI + 0.1)).toBeCloseTo(0)
})

test('normalizeYaw wraps 2π to 0', () => {
  expect(normalizeYaw(2 * Math.PI)).toBeCloseTo(0)
  expect(normalizeYaw(-2 * Math.PI)).toBeCloseTo(0)
})

test('getClampedBoatPassengerYaw clamps absolute look beyond 105° from boat', () => {
  const requested = BOAT_YAW + 2.5
  const clamped = getClampedBoatPassengerYaw(requested, BOAT_YAW)
  expect(normalizeYawDelta(BOAT_YAW, clamped)).toBeCloseTo(BOAT_PASSENGER_MAX_HEAD_YAW_RAD)
})

test('renderer and camera share the same effective yaw', () => {
  const cameraYaw = BOAT_YAW + 1.9
  const clampedLook = getClampedBoatPassengerYaw(cameraYaw, BOAT_YAW)
  const resolved = resolveBoatPassengerThirdPersonRotation({
    cameraYaw,
    cameraPitch: 0.2,
    vehicleYaw: BOAT_YAW
  })
  expect(resolved.effectiveCameraYaw).toBeCloseTo(clampedLook)
  expect(normalizeYaw(BOAT_YAW + resolved.headYaw)).toBeCloseTo(clampedLook)
})

test('positive camera delta yields positive local head yaw', () => {
  const cameraYaw = BOAT_YAW + 0.5
  const resolved = resolveBoatPassengerThirdPersonRotation({
    cameraYaw,
    cameraPitch: 0,
    vehicleYaw: BOAT_YAW
  })
  expect(resolved.headYaw).toBeGreaterThan(0)
  expect(resolved.headYaw).toBeCloseTo(normalizeYawDelta(BOAT_YAW, cameraYaw))
})

test('head yaw sign follows normalize(cameraYaw - vehicleYaw) without inversion', () => {
  const positive = resolveBoatPassengerThirdPersonRotation({
    cameraYaw: BOAT_YAW + 0.3,
    cameraPitch: 0,
    vehicleYaw: BOAT_YAW
  })
  const negative = resolveBoatPassengerThirdPersonRotation({
    cameraYaw: BOAT_YAW - 0.3,
    cameraPitch: 0,
    vehicleYaw: BOAT_YAW
  })
  expect(positive.headYaw).toBeCloseTo(0.3)
  expect(negative.headYaw).toBeCloseTo(-0.3)
})

test('shouldApplyBoatPassengerRotation excludes minecart and horse without third-person requirement', () => {
  const base = {
    isAnchoredPassenger: true,
    vehicleYaw: BOAT_YAW
  }
  expect(shouldApplyBoatPassengerRotation({ ...base, vehicleName: 'boat' })).toBe(true)
  expect(shouldApplyBoatPassengerRotation({ ...base, vehicleName: 'minecart' })).toBe(false)
  expect(shouldApplyBoatPassengerRotation({ ...base, vehicleName: 'horse' })).toBe(false)
})

test('shouldApplyBoatPassengerThirdPersonRotation excludes minecart and horse', () => {
  const base = {
    isThirdPerson: true,
    isAnchoredPassenger: true,
    vehicleYaw: BOAT_YAW
  }
  expect(shouldApplyBoatPassengerThirdPersonRotation({ ...base, vehicleName: 'boat' })).toBe(true)
  expect(shouldApplyBoatPassengerThirdPersonRotation({ ...base, vehicleName: 'minecart' })).toBe(false)
  expect(shouldApplyBoatPassengerThirdPersonRotation({ ...base, vehicleName: 'horse' })).toBe(false)
})

test('first mount frame without anchor uses camera fallback gate', () => {
  expect(
    shouldApplyBoatPassengerThirdPersonRotation({
      isThirdPerson: true,
      isAnchoredPassenger: false,
      vehicleName: 'boat',
      vehicleYaw: BOAT_YAW
    })
  ).toBe(false)
})

test('first dismount frame without anchor uses camera fallback gate', () => {
  expect(
    shouldApplyBoatPassengerThirdPersonRotation({
      isThirdPerson: true,
      isAnchoredPassenger: false,
      vehicleName: undefined,
      vehicleYaw: undefined
    })
  ).toBe(false)
})

test('non-finite or missing vehicle yaw disables boat branch', () => {
  expect(
    shouldApplyBoatPassengerThirdPersonRotation({
      isThirdPerson: true,
      isAnchoredPassenger: true,
      vehicleName: 'boat',
      vehicleYaw: Number.NaN
    })
  ).toBe(false)
  expect(getClampedBoatPassengerYaw(1.2, Number.NaN)).toBe(1.2)
  expect(getClampedBoatPassengerYaw(Number.NaN, BOAT_YAW)).toBeNaN()
})

test('acceptance identity: headYaw ≈ clamp(normalize(cameraYaw - boatYaw))', () => {
  const cameraYaw = BOAT_YAW + 1.1
  const resolved = resolveBoatPassengerThirdPersonRotation({
    cameraYaw,
    cameraPitch: -0.4,
    vehicleYaw: BOAT_YAW
  })
  const expectedHead = clampBoatPassengerRelativeHeadYaw(normalizeYawDelta(BOAT_YAW, cameraYaw))
  expect(resolved.bodyYaw).toBeCloseTo(BOAT_YAW)
  expect(resolved.headYaw).toBeCloseTo(expectedHead)
  expect(resolved.effectiveCameraYaw).toBeCloseTo(normalizeYaw(BOAT_YAW + expectedHead))
  expect(resolved.headPitch).toBeCloseTo(0.4)
})

test('helmet head armor copies skin head yaw after boat passenger rotation', () => {
  const resolved = resolveBoatPassengerThirdPersonRotation({
    cameraYaw: BOAT_YAW + 0.45,
    cameraPitch: -0.2,
    vehicleYaw: BOAT_YAW
  })
  const skinHead = { x: resolved.headPitch, y: resolved.headYaw, z: 0 }
  const helmet = { x: 0, y: 0, z: 0 }
  helmet.x = -skinHead.x
  helmet.y = skinHead.y
  helmet.z = skinHead.z
  expect(helmet.y).toBeCloseTo(resolved.headYaw)
  expect(helmet.x).toBeCloseTo(-resolved.headPitch)
})
