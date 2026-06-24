import { describe, expect, it } from 'vitest'
import { Vec3 } from 'vec3'
import { collectBlockEntityMetadata } from './blockEntityMetadata'

describe('collectBlockEntityMetadata', () => {
  it('stores channel light norms on banner metadata', () => {
    const target = { signs: {}, heads: {}, banners: {} }
    const block = {
      name: 'pink_banner',
      getProperties: () => ({ rotation: 0 })
    }
    collectBlockEntityMetadata(
      block,
      1,
      2,
      3,
      target,
      {},
      {
        getChannelLightNorm: (pos: Vec3) => {
          expect(pos).toBeInstanceOf(Vec3)
          return { block: 0.4, sky: 0.8 }
        }
      }
    )
    expect(target.banners['1,2,3']).toEqual({
      isWall: false,
      blockName: 'pink_banner',
      rotation: 0,
      blockLightNorm: 0.4,
      skyLightNorm: 0.8
    })
  })
})
