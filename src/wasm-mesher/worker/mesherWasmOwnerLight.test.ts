import { describe, expect, it } from 'vitest'
import { createEmptyLightCache, isLightSectionPresent, worldSectionMaskBit } from './mesherWasmLightMerge'
import { applyPackedOwnerSectionsToLightCache } from './mesherWasmOwnerLight'
import { packUnpackedLightSection } from '../../mesher-shared/lightNibblePack'

describe('applyPackedOwnerSectionsToLightCache', () => {
  it('unpacks owner packed channels into the worker column cache without touching other sections', () => {
    const cache = createEmptyLightCache(16)
    const unpacked = new Uint8Array(4096).fill(0)
    unpacked[0] = 9
    const packed = packUnpackedLightSection(unpacked)
    const next = applyPackedOwnerSectionsToLightCache(
      cache,
      [{ sx: 0, sy: 64, sz: 0, blockLight: packed, skyLight: packed }],
      0,
      0,
      0,
      16
    )
    expect(next.blockLight[4 * 4096]).toBe(9)
    expect(next.skyLight[4 * 4096]).toBe(9)
    expect(isLightSectionPresent(next.blockPresent, worldSectionMaskBit(4))).toBe(true)
    expect(next.blockLight[0]).toBe(0)
    expect(isLightSectionPresent(next.blockPresent, worldSectionMaskBit(0))).toBe(false)
  })
})
