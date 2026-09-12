import { describe, expect, it } from 'vitest'
import {
  LIGHT_BLOCKS_PER_SECTION,
  createEmptyLightCache,
  displayLightColumn,
  isLightSectionPresent,
  mergeUpdateLight,
  worldSectionMaskBit,
  type ParsedUpdateLight,
  type UpdateLightColumnCache
} from './mesherWasmLightMerge'

const NUM_SECTIONS = 16
const WORLD_BYTES = NUM_SECTIONS * LIGHT_BLOCKS_PER_SECTION

function maskWithBits(...bits: number[]): Uint32Array {
  const out = new Uint32Array(2)
  for (const bit of bits) {
    const bitInLong = bit & 63
    if (bitInLong < 32) out[0] |= 1 << bitInLong
    else out[1] |= 1 << (bitInLong - 32)
  }
  return out
}

function emptyParsed(overrides: Partial<ParsedUpdateLight> = {}): ParsedUpdateLight {
  return {
    x: 0,
    z: 0,
    trustEdges: false,
    numSections: NUM_SECTIONS,
    skyLight: new Uint8Array(WORLD_BYTES),
    blockLight: new Uint8Array(WORLD_BYTES),
    skyLightMask: new Uint32Array(2),
    emptySkyLightMask: new Uint32Array(2),
    blockLightMask: new Uint32Array(2),
    emptyBlockLightMask: new Uint32Array(2),
    ...overrides
  }
}

function writeWorldSection(column: Uint8Array, sectionIndex: number, value: number) {
  const start = sectionIndex * LIGHT_BLOCKS_PER_SECTION
  column.fill(value, start, start + LIGHT_BLOCKS_PER_SECTION)
}

function sectionSlice(column: Uint8Array, sectionIndex: number): Uint8Array {
  const start = sectionIndex * LIGHT_BLOCKS_PER_SECTION
  return column.subarray(start, start + LIGHT_BLOCKS_PER_SECTION)
}

function sectionAll(column: Uint8Array, sectionIndex: number, value: number): boolean {
  return sectionSlice(column, sectionIndex).every(v => v === value)
}

describe('mergeUpdateLight', () => {
  it('does not bake omitted sky as authoritative 15 on the first packet', () => {
    const skyLight = new Uint8Array(WORLD_BYTES)
    writeWorldSection(skyLight, 1, 3)
    const cache = mergeUpdateLight(
      undefined,
      emptyParsed({
        skyLight,
        skyLightMask: maskWithBits(worldSectionMaskBit(1))
      })
    )

    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(1))).toBe(true)
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(0))).toBe(false)
    expect(sectionAll(cache.skyLight, 1, 3)).toBe(true)
    expect(sectionAll(cache.skyLight, 0, 15)).toBe(false)
    expect(displayLightColumn(cache, 'sky', 15)[0]).toBe(15)
    expect(displayLightColumn(cache, 'sky')[LIGHT_BLOCKS_PER_SECTION]).toBe(3)
  })

  it('preserves an omitted neighbor section across a repeated partial delta', () => {
    const firstSky = new Uint8Array(WORLD_BYTES)
    writeWorldSection(firstSky, 0, 7)
    let cache = mergeUpdateLight(
      undefined,
      emptyParsed({
        skyLight: firstSky,
        skyLightMask: maskWithBits(worldSectionMaskBit(0))
      })
    )

    const secondSky = new Uint8Array(WORLD_BYTES)
    writeWorldSection(secondSky, 1, 4)
    cache = mergeUpdateLight(
      cache,
      emptyParsed({
        skyLight: secondSky,
        skyLightMask: maskWithBits(worldSectionMaskBit(1))
      })
    )

    expect(sectionAll(cache.skyLight, 0, 7)).toBe(true)
    expect(sectionAll(cache.skyLight, 1, 4)).toBe(true)
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(0))).toBe(true)
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(1))).toBe(true)
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(2))).toBe(false)
  })

  it('zeros a section when the empty-bit is set', () => {
    const firstSky = new Uint8Array(WORLD_BYTES)
    writeWorldSection(firstSky, 0, 7)
    let cache = mergeUpdateLight(
      undefined,
      emptyParsed({
        skyLight: firstSky,
        skyLightMask: maskWithBits(worldSectionMaskBit(0))
      })
    )

    cache = mergeUpdateLight(
      cache,
      emptyParsed({
        emptySkyLightMask: maskWithBits(worldSectionMaskBit(0))
      })
    )

    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(0))).toBe(true)
    expect(sectionAll(cache.skyLight, 0, 0)).toBe(true)
    expect(displayLightColumn(cache, 'sky', 15)[0]).toBe(0)
  })

  it('updates sky and block independently', () => {
    const skyLight = new Uint8Array(WORLD_BYTES)
    const blockLight = new Uint8Array(WORLD_BYTES)
    writeWorldSection(skyLight, 0, 12)
    writeWorldSection(blockLight, 0, 5)
    let cache = mergeUpdateLight(
      undefined,
      emptyParsed({
        skyLight,
        blockLight,
        skyLightMask: maskWithBits(worldSectionMaskBit(0)),
        blockLightMask: maskWithBits(worldSectionMaskBit(0))
      })
    )

    cache = mergeUpdateLight(
      cache,
      emptyParsed({
        emptyBlockLightMask: maskWithBits(worldSectionMaskBit(0))
      })
    )

    expect(sectionAll(cache.skyLight, 0, 12)).toBe(true)
    expect(sectionAll(cache.blockLight, 0, 0)).toBe(true)
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(0))).toBe(true)
    expect(isLightSectionPresent(cache.blockPresent, worldSectionMaskBit(0))).toBe(true)
  })

  it('records padding bits without writing them into the world column', () => {
    const skyBelow = new Uint8Array(LIGHT_BLOCKS_PER_SECTION).fill(9)
    const cache = mergeUpdateLight(
      undefined,
      emptyParsed({
        skyBelow,
        skyLightMask: maskWithBits(0)
      })
    )

    expect(isLightSectionPresent(cache.skyPresent, 0)).toBe(true)
    expect(cache.skyBelow).toBeDefined()
    expect(cache.skyBelow!.every(v => v === 9)).toBe(true)
    expect(sectionAll(cache.skyLight, 0, 0)).toBe(true)
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(0))).toBe(false)
  })

  it('applies captured 1.17.1 empty-block bits without seeding omitted sky as 15', () => {
    const cache = mergeUpdateLight(
      undefined,
      emptyParsed({
        trustEdges: true,
        emptyBlockLightMask: maskWithBits(1, 2, 3, 4, 5)
      })
    )

    expect(cache.trustEdges).toBe(true)
    for (let s = 0; s <= 4; s++) {
      expect(isLightSectionPresent(cache.blockPresent, worldSectionMaskBit(s))).toBe(true)
      expect(sectionAll(cache.blockLight, s, 0)).toBe(true)
    }
    expect(isLightSectionPresent(cache.skyPresent, worldSectionMaskBit(0))).toBe(false)
    expect(sectionAll(cache.skyLight, 0, 15)).toBe(false)
    expect(displayLightColumn(cache, 'sky', 15)[0]).toBe(15)
  })

  it('keeps trustEdges from the latest packet without changing merge rules', () => {
    const cache = mergeUpdateLight(createEmptyLightCache(NUM_SECTIONS), emptyParsed({ trustEdges: true }))
    expect(cache.trustEdges).toBe(true)
  })
})

describe('displayLightColumn', () => {
  it('fills only absent world sections and leaves explicit zeros', () => {
    const cache: UpdateLightColumnCache = createEmptyLightCache(NUM_SECTIONS)
    writeWorldSection(cache.blockLight, 2, 0)
    cache.blockPresent = maskWithBits(worldSectionMaskBit(2))

    const displayed = displayLightColumn(cache, 'block', 0)
    expect(sectionAll(displayed, 2, 0)).toBe(true)
    expect(sectionAll(displayed, 1, 0)).toBe(true)
  })
})
