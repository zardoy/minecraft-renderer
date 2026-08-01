import { expect, test } from 'vitest'
import { VANILLA_117_HORSE_ENTITY_SCALES } from './horseEntityScale'

test('vanilla 1.17.1 horse family entity scales', () => {
  expect(VANILLA_117_HORSE_ENTITY_SCALES.horse).toBe(1.1)
  expect(VANILLA_117_HORSE_ENTITY_SCALES.donkey).toBe(0.87)
  expect(VANILLA_117_HORSE_ENTITY_SCALES.mule).toBe(0.92)
  expect(VANILLA_117_HORSE_ENTITY_SCALES.skeleton_horse).toBe(1.0)
  expect(VANILLA_117_HORSE_ENTITY_SCALES.zombie_horse).toBe(1.0)
})
