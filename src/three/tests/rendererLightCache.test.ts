import { describe, expect, it } from 'vitest'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { RENDERER_LIGHT_BYTES_PER_SECTION, RendererLightCache } from '../rendererLightCache'

const VERSION = '1.16.5'

function makeChunk() {
  const Chunk = Chunks(VERSION) as any
  return new Chunk(undefined as any)
}

function makePresentZeroSection(y = 64) {
  const mcData = MinecraftData(VERSION)
  const chunk = makeChunk()
  const stoneId = mcData.blocksByName.stone.defaultState
  chunk.setBlockStateId(new Vec3(8, y, 8), stoneId)
  // Allocate light sections, then zero them. All-zero light is otherwise omitted
  // and must stay the fullbright "absent section" fallback.
  chunk.setBlockLight(new Vec3(8, y, 8), 1)
  chunk.setSkyLight(new Vec3(8, y, 8), 1)
  chunk.setBlockLight(new Vec3(8, y, 8), 0)
  chunk.setSkyLight(new Vec3(8, y, 8), 0)
  return chunk
}

function makeLitBlock(blockLight: number, skyLight: number, x = 8, y = 64, z = 8) {
  const mcData = MinecraftData(VERSION)
  const chunk = makeChunk()
  const stoneId = mcData.blocksByName.stone.defaultState
  chunk.setBlockStateId(new Vec3(x, y, z), stoneId)
  chunk.setBlockLight(new Vec3(x, y, z), blockLight)
  chunk.setSkyLight(new Vec3(x, y, z), skyLight)
  return chunk
}

describe('RendererLightCache', () => {
  it('returns fullbright for a missing column or absent section', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    expect(cache.getLight(8, 64, 8)).toEqual({ block: 0, sky: 1 })

    cache.ingestColumn(0, 0, makeChunk().toJson())
    expect(cache.getLight(8, 64, 8)).toEqual({ block: 0, sky: 1 })
  })

  it('applies +2 floor for a present raw-zero section and clamps at 15', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    cache.ingestColumn(0, 0, makePresentZeroSection().toJson())
    expect(cache.getLight(8, 64, 8).block).toBeCloseTo(2 / 15, 5)
    expect(cache.getLight(8, 64, 8).sky).toBeCloseTo(2 / 15, 5)

    cache.ingestColumn(0, 0, makeLitBlock(14, 14).toJson())
    expect(cache.getLight(8, 64, 8)).toEqual({ block: 1, sky: 1 })
  })

  it('reads packed channels at negative chunk coordinates', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    cache.ingestColumn(-16, -16, makeLitBlock(13, 4, 15, 64, 15).toJson())
    const light = cache.getLight(-1, 64, -1)
    expect(light.block).toBeCloseTo(15 / 15, 5)
    expect(light.sky).toBeCloseTo(6 / 15, 5)
  })

  it('does not bump column revision on identical re-ingest', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    const json = makeLitBlock(10, 5).toJson()
    const first = cache.ingestColumn(0, 0, json)
    const second = cache.ingestColumn(0, 0, json)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.revision).toBe(first.revision)
    expect(cache.getColumnRevision(0, 0)).toBe(first.revision)
  })

  it('bumps revision when light changes and forgets removed columns', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    const first = cache.ingestColumn(0, 0, makeLitBlock(3, 0).toJson())
    const second = cache.ingestColumn(0, 0, makeLitBlock(12, 0).toJson())
    expect(second.changed).toBe(true)
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(cache.getLight(8, 64, 8).block).toBeCloseTo(14 / 15, 5)

    const globalBefore = cache.getGlobalRevision()
    cache.removeColumn(0, 0)
    expect(cache.getLight(8, 64, 8)).toEqual({ block: 0, sky: 1 })
    expect(cache.getGlobalRevision()).toBe(globalBefore)
    expect(cache.getAllocatedSectionCount()).toBe(0)
  })

  it('does not bump global revision on ingest of another column', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    cache.ingestColumn(0, 0, makeLitBlock(3, 0).toJson())
    const globalBefore = cache.getGlobalRevision()
    cache.ingestColumn(16, 0, makeLitBlock(12, 0).toJson())
    expect(cache.getGlobalRevision()).toBe(globalBefore)
    expect(cache.getColumnRevision(16, 0)).toBeGreaterThan(0)
  })

  it('keeps prior column state when ingest fails', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    const ok = cache.ingestColumn(0, 0, makeLitBlock(8, 0).toJson())
    const failed = cache.ingestColumn(0, 0, { not: 'a-chunk' })
    expect(failed.changed).toBe(false)
    expect(failed.revision).toBe(ok.revision)
    expect(cache.getLight(8, 64, 8).block).toBeCloseTo(10 / 15, 5)
  })

  it('clear and bounds change drop light and bump the global revision', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    cache.ingestColumn(16, 32, makeLitBlock(15, 15).toJson())
    expect(cache.getAllocatedBytes()).toBeGreaterThanOrEqual(RENDERER_LIGHT_BYTES_PER_SECTION)
    const globalBefore = cache.getGlobalRevision()
    cache.clear()
    expect(cache.getLight(24, 64, 40)).toEqual({ block: 0, sky: 1 })
    expect(cache.getGlobalRevision()).toBeGreaterThan(globalBefore)
  })
})

describe('RendererLightCache 1.18+', () => {
  const VERSION_118 = '1.18.2'
  const MIN_Y = -64
  const WORLD_HEIGHT = 384

  function make118Chunk() {
    const Chunk = Chunks(VERSION_118) as any
    return new Chunk({ minY: MIN_Y, worldHeight: WORLD_HEIGHT })
  }

  function make118LitBlock(blockLight: number, skyLight: number, x = 8, y = -60, z = 8) {
    const mcData = MinecraftData(VERSION_118)
    const chunk = make118Chunk()
    const stoneId = mcData.blocksByName.stone.defaultState
    chunk.setBlockStateId(new Vec3(x, y, z), stoneId)
    chunk.setBlockLight(new Vec3(x, y, z), blockLight)
    chunk.setSkyLight(new Vec3(x, y, z), skyLight)
    return chunk
  }

  it('packs and reads light in a negative-Y section', () => {
    const cache = new RendererLightCache(VERSION_118)
    cache.setWorldBounds(MIN_Y, WORLD_HEIGHT)
    cache.ingestColumn(0, 0, make118LitBlock(11, 3).toJson())
    const light = cache.getLight(8, -60, 8)
    expect(light.block).toBeCloseTo(13 / 15, 5)
    expect(light.sky).toBeCloseTo(5 / 15, 5)
    expect(cache.getLight(8, -64, 8).block).toBeGreaterThan(0)
  })
})
