import { describe, expect, it } from 'vitest'
import { createEmptyLightCache, isLightSectionPresent, worldSectionMaskBit, type ParsedUpdateLight } from './mesherWasmLightMerge'
import { applyPackedOwnerSectionsToLightCache, applyRawLightPacketToCaches, ownerDeltaSectionWorldYs } from './mesherWasmOwnerLight'
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

  it('writes a section delta in place without cloning the full column arrays', () => {
    const cache = createEmptyLightCache(16)
    cache.blockLight[0] = 4
    cache.skyLight[0] = 7
    const blockRef = cache.blockLight
    const skyRef = cache.skyLight
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
    expect(next.blockLight).toBe(blockRef)
    expect(next.skyLight).toBe(skyRef)
    expect(next.blockLight[0]).toBe(4)
    expect(next.skyLight[0]).toBe(7)
    expect(next.blockLight[4 * 4096]).toBe(9)
  })

  it('lists only the published section Y origins for a column', () => {
    expect(
      ownerDeltaSectionWorldYs(
        [
          { sx: 0, sy: 64, sz: 0 },
          { sx: 16, sy: 64, sz: 0 },
          { sx: 0, sy: 80, sz: 0 }
        ],
        0,
        0
      )
    ).toEqual([64, 80])
  })
})

describe('applyRawLightPacketToCaches', () => {
  function parsedBlock(sectionIndex: number, value: number): ParsedUpdateLight {
    const blockLight = new Uint8Array(16 * 4096)
    blockLight.fill(value, sectionIndex * 4096, (sectionIndex + 1) * 4096)
    const blockLightMask = new Uint32Array(2)
    blockLightMask[0] = 1 << (sectionIndex + 1)
    return {
      x: 0,
      z: 0,
      trustEdges: true,
      numSections: 16,
      skyLight: new Uint8Array(16 * 4096),
      blockLight,
      skyLightMask: new Uint32Array(2),
      emptySkyLightMask: new Uint32Array(2),
      blockLightMask,
      emptyBlockLightMask: new Uint32Array(2)
    }
  }

  it('writes incoming server light into the display cache when the owner does not own the column', () => {
    const result = applyRawLightPacketToCaches({
      ownerOwnsColumn: false,
      incoming: undefined,
      display: undefined,
      parsed: parsedBlock(4, 9)
    })
    expect(result.dirtyDisplay).toBe(true)
    expect(result.display?.blockLight[4 * 4096]).toBe(9)
    expect(result.incoming.blockLight[4 * 4096]).toBe(9)
  })

  it('keeps incoming server light separate and does not overwrite owner display cache', () => {
    const display = createEmptyLightCache(16)
    display.blockLight[4 * 4096] = 3
    const result = applyRawLightPacketToCaches({
      ownerOwnsColumn: true,
      incoming: undefined,
      display,
      parsed: parsedBlock(4, 9)
    })
    expect(result.dirtyDisplay).toBe(false)
    expect(result.display?.blockLight[4 * 4096]).toBe(3)
    expect(result.incoming.blockLight[4 * 4096]).toBe(9)
  })
})
