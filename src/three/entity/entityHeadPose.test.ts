import { expect, test } from 'vitest'
import { resolveEntityHeadPose } from './entityHeadPose'

test('uses entity pitch and network head yaw as separate angles', () => {
  expect(resolveEntityHeadPose({ pitch: 0.25, yaw: 1, headYaw: -0.5 })).toEqual({ pitch: 0.25, headYaw: -0.5 })
})

test('falls back to body yaw when head yaw is unavailable', () => {
  expect(resolveEntityHeadPose({ pitch: -0.2, yaw: 1.25 })).toEqual({ pitch: -0.2, headYaw: 1.25 })
})

test('does not propagate missing or non-finite rotations', () => {
  expect(resolveEntityHeadPose({ pitch: Number.NaN, yaw: Number.POSITIVE_INFINITY, headYaw: undefined })).toEqual({ pitch: 0, headYaw: 0 })
})
