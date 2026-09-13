import { createEmptyLightCache, maskBitSet, mergeUpdateLight, worldSectionMaskBit, type ParsedUpdateLight, type UpdateLightColumnCache } from './mesherWasmLightMerge'
import { unpackPackedLightSection } from '../../mesher-shared/lightNibblePack'

export type OwnerPackedSection = {
  sx: number
  sy: number
  sz: number
  blockLight: Uint8Array
  skyLight?: Uint8Array
}

/** Write owner packed 2048-byte channels into the worker's unpacked column cache. */
export function applyPackedOwnerSectionsToLightCache(
  cache: UpdateLightColumnCache | undefined,
  sections: OwnerPackedSection[],
  worldMinY: number,
  columnWorldX: number,
  columnWorldZ: number,
  numSections: number
): UpdateLightColumnCache {
  const next = cache ? cloneForOwnerWrite(cache) : createEmptyLightCache(numSections)
  const colSx = Math.floor(columnWorldX / 16) * 16
  const colSz = Math.floor(columnWorldZ / 16) * 16
  for (const section of sections) {
    if (section.sx !== colSx || section.sz !== colSz) continue
    const sectionIndex = Math.floor((section.sy - worldMinY) / 16)
    if (sectionIndex < 0 || sectionIndex >= next.numSections) continue
    const start = sectionIndex * 4096
    const block = unpackPackedLightSection(section.blockLight)
    next.blockLight.set(block, start)
    maskBitSet(next.blockPresent, worldSectionMaskBit(sectionIndex))
    if (section.skyLight) {
      const sky = unpackPackedLightSection(section.skyLight)
      next.skyLight.set(sky, start)
      maskBitSet(next.skyPresent, worldSectionMaskBit(sectionIndex))
    }
  }
  return next
}

export function applyRawLightPacketToCaches(opts: {
  ownerOwnsColumn: boolean
  incoming: UpdateLightColumnCache | undefined
  display: UpdateLightColumnCache | undefined
  parsed: ParsedUpdateLight
}): { incoming: UpdateLightColumnCache; display: UpdateLightColumnCache | undefined; dirtyDisplay: boolean } {
  const incoming = mergeUpdateLight(opts.incoming, opts.parsed)
  if (opts.ownerOwnsColumn) {
    return { incoming, display: opts.display, dirtyDisplay: false }
  }
  return { incoming, display: incoming, dirtyDisplay: true }
}

function cloneForOwnerWrite(cache: UpdateLightColumnCache): UpdateLightColumnCache {
  return {
    numSections: cache.numSections,
    trustEdges: cache.trustEdges,
    skyLight: new Uint8Array(cache.skyLight),
    blockLight: new Uint8Array(cache.blockLight),
    skyPresent: new Uint32Array(cache.skyPresent),
    blockPresent: new Uint32Array(cache.blockPresent),
    skyBelow: cache.skyBelow ? new Uint8Array(cache.skyBelow) : undefined,
    skyAbove: cache.skyAbove ? new Uint8Array(cache.skyAbove) : undefined,
    blockBelow: cache.blockBelow ? new Uint8Array(cache.blockBelow) : undefined,
    blockAbove: cache.blockAbove ? new Uint8Array(cache.blockAbove) : undefined
  }
}
