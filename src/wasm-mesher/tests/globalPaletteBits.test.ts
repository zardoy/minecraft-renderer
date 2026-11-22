import { describe, expect, test } from 'vitest'
import { getGlobalPaletteBits } from '../bridge/convertChunk'

describe('getGlobalPaletteBits', () => {
  test('is ceillog2 of the block state and biome registry sizes', () => {
    // 20342 states, 61 biomes
    expect(getGlobalPaletteBits('1.18.2')).toEqual({ blocks: 15, biomes: 6 })
    // 65 biomes need a seventh bit
    expect(getGlobalPaletteBits('1.21.4')).toEqual({ blocks: 15, biomes: 7 })
  })

  test('needs no extra bit for a power-of-two registry', () => {
    // 64 biomes fit in 6 bits (Mth.ceillog2(64) = 6)
    expect(getGlobalPaletteBits('1.20.4').biomes).toBe(6)
  })
})
