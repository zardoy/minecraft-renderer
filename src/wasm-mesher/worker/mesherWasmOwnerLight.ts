import {
  cloneLightCache,
  createEmptyLightCache,
  maskBitSet,
  mergeUpdateLight,
  worldSectionMaskBit,
  type ParsedUpdateLight,
  type UpdateLightColumnCache
} from './mesherWasmLightMerge'
import { unpackPackedLightSection } from '../../mesher-shared/lightNibblePack'

export type OwnerPackedSection = {
  sx: number
  sy: number
  sz: number
  blockLight: Uint8Array
  skyLight?: Uint8Array
}

/** World-origin Y of published sections that belong to this column. */
export function ownerDeltaSectionWorldYs(
  sections: Array<{ sx: number; sy: number; sz: number }>,
  columnWorldX: number,
  columnWorldZ: number
): number[] {
  const colSx = Math.floor(columnWorldX / 16) * 16
  const colSz = Math.floor(columnWorldZ / 16) * 16
  const ys: number[] = []
  const seen = new Set<number>()
  for (const section of sections) {
    if (section.sx !== colSx || section.sz !== colSz) continue
    if (seen.has(section.sy)) continue
    seen.add(section.sy)
    ys.push(section.sy)
  }
  return ys
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
  const next = cache ?? createEmptyLightCache(numSections)
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

/** First owner takeover: clone incoming onto display once. Later deltas write display in place. */
export function detachDisplayOnOwnerTakeover(opts: {
  incoming: UpdateLightColumnCache | undefined
  display: UpdateLightColumnCache | undefined
}): { incoming: UpdateLightColumnCache | undefined; display: UpdateLightColumnCache | undefined } {
  if (!opts.incoming) return { incoming: undefined, display: opts.display }
  if (opts.display == null || opts.display === opts.incoming) {
    return { incoming: opts.incoming, display: cloneLightCache(opts.incoming) }
  }
  return { incoming: opts.incoming, display: opts.display }
}

export function applyOwnerPublicationToColumnCaches(opts: {
  incoming: UpdateLightColumnCache | undefined
  display: UpdateLightColumnCache | undefined
  sections: OwnerPackedSection[]
  worldMinY: number
  columnWorldX: number
  columnWorldZ: number
  numSections: number
}): { incoming: UpdateLightColumnCache | undefined; display: UpdateLightColumnCache } {
  const detached = detachDisplayOnOwnerTakeover({ incoming: opts.incoming, display: opts.display })
  return {
    incoming: detached.incoming,
    display: applyPackedOwnerSectionsToLightCache(
      detached.display,
      opts.sections,
      opts.worldMinY,
      opts.columnWorldX,
      opts.columnWorldZ,
      opts.numSections
    )
  }
}

export function revertDisplayToIncoming(opts: {
  incoming: UpdateLightColumnCache | undefined
  display: UpdateLightColumnCache | undefined
}): { incoming: UpdateLightColumnCache | undefined; display: UpdateLightColumnCache | undefined } {
  if (!opts.incoming) return { incoming: undefined, display: opts.display }
  return { incoming: opts.incoming, display: cloneLightCache(opts.incoming) }
}

