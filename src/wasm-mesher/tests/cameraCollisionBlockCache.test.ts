import { test, expect } from 'vitest'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { CAMERA_COLLISION_BYTES_PER_SECTION, CameraCollisionBlockCache } from '../../three/cameraCollisionBlockCache'

const VERSION = '1.16.5'

function makeChunkWithStoneFloor(y: number) {
  const mcData = MinecraftData(VERSION)
  const Chunk = Chunks(VERSION) as any
  const chunk = new Chunk(undefined as any)
  const stoneId = mcData.blocksByName.stone.defaultState
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      chunk.setBlockStateId(new Vec3(x, y, z), stoneId)
    }
  }
  return chunk
}

test('CameraCollisionBlockCache: ingestColumn sets solids and skips air sections', () => {
  const cache = new CameraCollisionBlockCache(VERSION)
  cache.setWorldBounds(0, 256)
  const chunk = makeChunkWithStoneFloor(64)
  cache.ingestColumn(0, 0, chunk.toJson())

  expect(cache.isSolidBlock(0, 64, 0)).toBe(true)
  expect(cache.isSolidBlock(15, 64, 15)).toBe(true)
  expect(cache.isSolidBlock(0, 65, 0)).toBe(false)
  expect(cache.isSolidBlock(0, 0, 0)).toBe(false)

  // One 16³ section at y=64 only (not the whole column height).
  expect(cache.getAllocatedSectionCount()).toBe(1)
  expect(cache.getAllocatedBytes()).toBe(CAMERA_COLLISION_BYTES_PER_SECTION)
})

test('CameraCollisionBlockCache: setBlockStateId updates and frees empty sections', () => {
  const cache = new CameraCollisionBlockCache(VERSION)
  cache.setWorldBounds(0, 256)
  const mcData = MinecraftData(VERSION)
  const stoneId = mcData.blocksByName.stone.defaultState

  cache.setBlockStateId(5, 70, 5, stoneId)
  expect(cache.isSolidBlock(5, 70, 5)).toBe(true)
  expect(cache.getAllocatedSectionCount()).toBe(1)

  cache.setBlockStateId(5, 70, 5, 0)
  expect(cache.isSolidBlock(5, 70, 5)).toBe(false)
  expect(cache.getAllocatedSectionCount()).toBe(0)
})

test('CameraCollisionBlockCache: removeColumn frees all section bitsets in column', () => {
  const cache = new CameraCollisionBlockCache(VERSION)
  cache.setWorldBounds(0, 256)
  const mcData = MinecraftData(VERSION)
  const stoneId = mcData.blocksByName.stone.defaultState

  cache.setBlockStateId(0, 64, 0, stoneId)
  cache.setBlockStateId(0, 80, 0, stoneId)
  expect(cache.getAllocatedSectionCount()).toBe(2)

  cache.removeColumn(0, 0)
  expect(cache.getAllocatedSectionCount()).toBe(0)
  expect(cache.isSolidBlock(0, 64, 0)).toBe(false)
})

test('CameraCollisionBlockCache: clear and setWorldBounds drop all sections', () => {
  const cache = new CameraCollisionBlockCache(VERSION)
  cache.setWorldBounds(0, 256)
  const chunk = makeChunkWithStoneFloor(10)
  cache.ingestColumn(16, 32, chunk.toJson())
  expect(cache.getAllocatedSectionCount()).toBeGreaterThan(0)

  cache.clear()
  expect(cache.getAllocatedSectionCount()).toBe(0)

  cache.ingestColumn(16, 32, chunk.toJson())
  cache.setWorldBounds(-64, 320)
  expect(cache.getAllocatedSectionCount()).toBe(0)
})
