/** 16³ unpacked light values per section. */
export const LIGHT_BLOCKS_PER_SECTION = 4096

export type ParsedUpdateLight = {
  x: number
  z: number
  trustEdges: boolean
  numSections: number
  skyLight: Uint8Array
  blockLight: Uint8Array
  skyLightMask: Uint32Array
  emptySkyLightMask: Uint32Array
  blockLightMask: Uint32Array
  emptyBlockLightMask: Uint32Array
  skyBelow?: Uint8Array
  skyAbove?: Uint8Array
  blockBelow?: Uint8Array
  blockAbove?: Uint8Array
}

export type UpdateLightColumnCache = {
  numSections: number
  trustEdges: boolean
  skyLight: Uint8Array
  blockLight: Uint8Array
  skyPresent: Uint32Array
  blockPresent: Uint32Array
  skyBelow?: Uint8Array
  skyAbove?: Uint8Array
  blockBelow?: Uint8Array
  blockAbove?: Uint8Array
}

export function worldSectionMaskBit(sectionIndex: number): number {
  return sectionIndex + 1
}

export function lightMaskWordCount(numSections: number): number {
  const bits = numSections + 2
  return Math.max(2, Math.ceil(bits / 64) * 2)
}

export function maskBitGet(mask: Uint32Array, i: number): boolean {
  const longIdx = i >> 6
  const bitInLong = i & 63
  const pair = longIdx * 2
  if (pair + 1 >= mask.length) return false
  const val = bitInLong < 32 ? mask[pair]! : mask[pair + 1]!
  const bit = bitInLong & 31
  return ((val >>> bit) & 1) === 1
}

export function maskBitSet(mask: Uint32Array, i: number): void {
  const longIdx = i >> 6
  const bitInLong = i & 63
  const pair = longIdx * 2
  if (pair + 1 >= mask.length) return
  if (bitInLong < 32) mask[pair] = (mask[pair]! | (1 << bitInLong)) >>> 0
  else mask[pair + 1] = (mask[pair + 1]! | (1 << (bitInLong - 32))) >>> 0
}

export function isLightSectionPresent(present: Uint32Array, maskBit: number): boolean {
  return maskBitGet(present, maskBit)
}

export function createEmptyLightCache(numSections: number): UpdateLightColumnCache {
  const worldBytes = numSections * LIGHT_BLOCKS_PER_SECTION
  const words = lightMaskWordCount(numSections)
  return {
    numSections,
    trustEdges: false,
    skyLight: new Uint8Array(worldBytes),
    blockLight: new Uint8Array(worldBytes),
    skyPresent: new Uint32Array(words),
    blockPresent: new Uint32Array(words)
  }
}

function copySection(dest: Uint8Array, src: Uint8Array, sectionIndex: number, value?: number) {
  const start = sectionIndex * LIGHT_BLOCKS_PER_SECTION
  const end = start + LIGHT_BLOCKS_PER_SECTION
  if (value !== undefined) {
    dest.fill(value, start, end)
    return
  }
  if (src.length < end) return
  dest.set(src.subarray(start, end), start)
}

function mergePadding(hasData: boolean, incoming?: Uint8Array): Uint8Array {
  if (hasData && incoming && incoming.length === LIGHT_BLOCKS_PER_SECTION) {
    return new Uint8Array(incoming)
  }
  return new Uint8Array(LIGHT_BLOCKS_PER_SECTION)
}

function mergeChannel(
  destValues: Uint8Array,
  destPresent: Uint32Array,
  srcValues: Uint8Array,
  dataMask: Uint32Array,
  emptyMask: Uint32Array,
  numSections: number,
  destBelow: Uint8Array | undefined,
  destAbove: Uint8Array | undefined,
  incomingBelow: Uint8Array | undefined,
  incomingAbove: Uint8Array | undefined
): { below?: Uint8Array; above?: Uint8Array } {
  let below = destBelow
  let above = destAbove
  const totalBits = numSections + 2
  for (let bit = 0; bit < totalBits; bit++) {
    const hasData = maskBitGet(dataMask, bit)
    const hasEmpty = maskBitGet(emptyMask, bit)
    if (!hasData && !hasEmpty) continue

    if (bit === 0) {
      below = mergePadding(hasData, incomingBelow)
      maskBitSet(destPresent, 0)
      continue
    }
    if (bit === numSections + 1) {
      above = mergePadding(hasData, incomingAbove)
      maskBitSet(destPresent, bit)
      continue
    }

    const sectionIndex = bit - 1
    if (hasData) copySection(destValues, srcValues, sectionIndex)
    else copySection(destValues, srcValues, sectionIndex, 0)
    maskBitSet(destPresent, bit)
  }
  return { below, above }
}

export function mergeUpdateLight(cache: UpdateLightColumnCache | undefined, parsed: ParsedUpdateLight): UpdateLightColumnCache {
  const next = cache ? cloneLightCache(cache) : createEmptyLightCache(parsed.numSections)
  next.trustEdges = parsed.trustEdges
  next.numSections = parsed.numSections

  const skyPad = mergeChannel(
    next.skyLight,
    next.skyPresent,
    parsed.skyLight,
    parsed.skyLightMask,
    parsed.emptySkyLightMask,
    parsed.numSections,
    next.skyBelow,
    next.skyAbove,
    parsed.skyBelow,
    parsed.skyAbove
  )
  next.skyBelow = skyPad.below
  next.skyAbove = skyPad.above

  const blockPad = mergeChannel(
    next.blockLight,
    next.blockPresent,
    parsed.blockLight,
    parsed.blockLightMask,
    parsed.emptyBlockLightMask,
    parsed.numSections,
    next.blockBelow,
    next.blockAbove,
    parsed.blockBelow,
    parsed.blockAbove
  )
  next.blockBelow = blockPad.below
  next.blockAbove = blockPad.above

  return next
}

export function cloneLightCache(cache: UpdateLightColumnCache): UpdateLightColumnCache {
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

export function displayLightColumn(cache: UpdateLightColumnCache, channel: 'sky' | 'block', fill = channel === 'sky' ? 15 : 0): Uint8Array {
  const src = channel === 'sky' ? cache.skyLight : cache.blockLight
  const present = channel === 'sky' ? cache.skyPresent : cache.blockPresent
  const out = new Uint8Array(cache.numSections * LIGHT_BLOCKS_PER_SECTION)
  for (let s = 0; s < cache.numSections; s++) {
    const start = s * LIGHT_BLOCKS_PER_SECTION
    const end = start + LIGHT_BLOCKS_PER_SECTION
    if (maskBitGet(present, worldSectionMaskBit(s))) {
      out.set(src.subarray(start, end), start)
    } else {
      out.fill(fill, start, end)
    }
  }
  return out
}

export function parsedUpdateLightFromWasm(parsed: any, numSections: number): ParsedUpdateLight {
  return {
    x: parsed.x as number,
    z: parsed.z as number,
    trustEdges: Boolean(parsed.trustEdges),
    numSections,
    skyLight: parsed.skyLight as Uint8Array,
    blockLight: parsed.blockLight as Uint8Array,
    skyLightMask: (parsed.skyLightMask as Uint32Array) ?? new Uint32Array(2),
    emptySkyLightMask: (parsed.emptySkyLightMask as Uint32Array) ?? new Uint32Array(2),
    blockLightMask: (parsed.blockLightMask as Uint32Array) ?? new Uint32Array(2),
    emptyBlockLightMask: (parsed.emptyBlockLightMask as Uint32Array) ?? new Uint32Array(2),
    skyBelow: parsed.skyBelow as Uint8Array | undefined,
    skyAbove: parsed.skyAbove as Uint8Array | undefined,
    blockBelow: parsed.blockBelow as Uint8Array | undefined,
    blockAbove: parsed.blockAbove as Uint8Array | undefined
  }
}
