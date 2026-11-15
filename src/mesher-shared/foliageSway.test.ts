import { describe, expect, it } from 'vitest'
import { decodeFoliageSwayLevel, foliageSwayBase, foliageSwayLevel, isFoliageBlockName, tagFoliageUv } from './foliageSway'

describe('foliageSwayBase', () => {
  it('sways plants, anchors the upper half of tall plants one level up', () => {
    expect(foliageSwayBase('short_grass', {}, false)).toBe(0)
    expect(foliageSwayBase('poppy', {}, false)).toBe(0)
    expect(foliageSwayBase('cherry_sapling', {}, false)).toBe(0)
    expect(foliageSwayBase('tall_grass', { half: 'lower' }, false)).toBe(0)
    expect(foliageSwayBase('tall_grass', { half: 'upper' }, false)).toBe(1)
    expect(foliageSwayBase('double_plant', { half: 'upper' }, false)).toBe(1)
  })

  it('never sways full cubes or unrelated blocks', () => {
    // pre-1.13 `grass` is the grass block
    expect(foliageSwayBase('grass', {}, true)).toBe(-1)
    expect(foliageSwayBase('stone', {}, false)).toBe(-1)
    expect(foliageSwayBase('oak_leaves', {}, false)).toBe(-1)
    expect(foliageSwayBase('sugar_cane', {}, false)).toBe(-1)
    expect(isFoliageBlockName('torch')).toBe(false)
  })
})

describe('foliageSwayLevel', () => {
  it('only vertices in the top half of the block move', () => {
    expect(foliageSwayLevel(0, 0)).toBe(0)
    expect(foliageSwayLevel(0, 1)).toBe(1)
    expect(foliageSwayLevel(0, 15 / 16)).toBe(1) // crops end at 15/16
    expect(foliageSwayLevel(1, 0)).toBe(1)
    expect(foliageSwayLevel(1, 1)).toBe(2)
    expect(foliageSwayLevel(-1, 1)).toBe(0)
  })
})

describe('UV tag round trip', () => {
  // atlas size, tile size in px
  const layouts: Array<[number, number]> = [
    [1024, 16],
    [2048, 16],
    [4096, 32],
    [2048, 128]
  ]

  it.each(layouts)('decodes every level for a %ipx atlas with %ipx tiles', (atlas, tile) => {
    const su = tile / atlas
    const u0 = (7 * tile) / atlas
    const v0 = (3 * tile) / atlas
    for (const level of [0, 1, 2]) {
      for (const [bu, bv] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ] as const) {
        const [tu, tv] = tagFoliageUv(bu, bv, level)
        const u = Math.fround(tu * su + u0)
        const v = Math.fround(tv * su + v0)
        expect(decodeFoliageSwayLevel(u, v, atlas, atlas)).toBe(level)
      }
    }
  })

  it('moves the sampled image by a negligible amount', () => {
    const [u, v] = tagFoliageUv(0, 1, 2)
    expect(Math.abs(u)).toBeLessThan(0.001)
    expect(Math.abs(1 - v)).toBeLessThan(0.001)
  })

  it('does not mistake half-pixel model UVs for a tag', () => {
    const v = (3 * 16 + 7.5) / 1024
    expect(decodeFoliageSwayLevel(0, v, 1024, 1024)).toBe(0)
  })
})
