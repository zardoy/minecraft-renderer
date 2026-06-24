import { describe, expect, it } from 'vitest'
import { applyLightmap, blockEntityBrightness, combinedBlockLight, DEFAULT_LIGHTMAP_PARAMS } from './blockEntityLighting'

describe('blockEntityLighting', () => {
  it('applyLightmap(1) === 1 for default params', () => {
    expect(applyLightmap(1, DEFAULT_LIGHTMAP_PARAMS)).toBe(1)
  })

  it('combinedBlockLight caps sky by skyLevel', () => {
    expect(combinedBlockLight(0, 1, 4 / 15)).toBeCloseTo(4 / 15, 5)
    expect(combinedBlockLight(0.5, 1, 4 / 15)).toBeCloseTo(0.5, 5)
  })

  it('night outdoor blockEntityBrightness matches cap + lightmap', () => {
    const skyLevel = 4 / 15
    const L = combinedBlockLight(0, 1, skyLevel)
    expect(blockEntityBrightness(0, 1, skyLevel)).toBeCloseTo(applyLightmap(L), 5)
  })

  it('linear curve matches raw L at minBrightness 0', () => {
    const p = { curve: 0, minBrightness: 0, gamma: 1 }
    expect(applyLightmap(0.5, p)).toBeCloseTo(0.5, 5)
  })
})
