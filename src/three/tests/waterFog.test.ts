import { expect, test } from 'vitest'
import { getWaterFogEnd, getWaterVision, waterFogColorToRgb } from '../waterFog'

test('water vision ramps with sqrt over 30 seconds and then stays at 1', () => {
  expect(getWaterVision(0)).toBe(0)
  expect(getWaterVision(7.5)).toBeCloseTo(0.5)
  expect(getWaterVision(30)).toBe(1)
  expect(getWaterVision(300)).toBe(1)
  expect(getWaterVision(-5)).toBe(0)
})

test('fog distance starts at 24 blocks, reaches 96 and breathing skips the ramp', () => {
  expect(getWaterFogEnd(0, false)).toBe(24)
  expect(getWaterFogEnd(7.5, false)).toBeCloseTo(48)
  expect(getWaterFogEnd(30, false)).toBe(96)
  expect(getWaterFogEnd(0, true)).toBe(96)
})

test('default water fog colour is the vanilla dark navy', () => {
  const [r, g, b] = waterFogColorToRgb(0x05_05_33)
  expect(r).toBeCloseTo(5 / 255)
  expect(g).toBeCloseTo(5 / 255)
  expect(b).toBeCloseTo(51 / 255)
})
