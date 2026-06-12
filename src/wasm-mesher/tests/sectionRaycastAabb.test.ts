import { test, expect } from 'vitest'
import {
  computeShaderSectionRaycastAabb,
  raycastAabb,
  raycastShaderBlocksAabb,
  raycastSectionAabb,
  sectionAabbIntersectsRay,
} from '../../three/sectionRaycastAabb'
import { LEGACY_SECTION_HALF_EXTENT } from '../../three/legacySectionCull'
import { SHADER_CUBES_WORDS_PER_FACE } from '../bridge/shaderCubeBridge'
import { WORD0 } from '../../three/shaders/cubeBlockShader'

test('raycastSectionAabb: hit along +X (full 16³)', () => {
  const t = raycastSectionAabb(0, 0, 0, 1, 0, 0, 16, 0, 0, 100)
  expect(t).toBeDefined()
  expect(t!).toBeGreaterThanOrEqual(8)
  expect(t!).toBeLessThanOrEqual(24)
})

test('raycastSectionAabb: miss behind ray', () => {
  expect(raycastSectionAabb(0, 0, 0, 1, 0, 0, -32, 0, 0, 100)).toBeUndefined()
})

test('raycastAabb: respects maxDist', () => {
  expect(raycastAabb(0, 0, 0, 1, 0, 0, 100, 0, 0, 108, 0, 8, 10)).toBeUndefined()
})

test('computeShaderSectionRaycastAabb: tight box from one block at local (5,3,7)', () => {
  const words = new Uint32Array(SHADER_CUBES_WORDS_PER_FACE)
  const lx = 5
  const ly = 3
  const lz = 7
  words[0] = lx | (ly << WORD0.LY_SHIFT) | (lz << WORD0.LZ_SHIFT)
  const box = computeShaderSectionRaycastAabb(words, 1, 8, 8, 8)!
  expect(box.minX).toBe(lx)
  expect(box.maxX).toBe(lx + 1)
  expect(box.minY).toBe(ly)
  expect(box.maxY).toBe(ly + 1)
  expect(box.minZ).toBe(lz)
  expect(box.maxZ).toBe(lz + 1)

  const t = raycastAabb(-1, 3.5, 7.5, 1, 0, 0, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, 100)
  expect(t).toBe(6)
})

test('raycastAabb: origin inside box is ignored', () => {
  const t = raycastAabb(5.5, 3.5, 7.5, 0, 0, 1, 5, 3, 7, 6, 4, 8, 100)
  expect(t).toBeUndefined()
})

test('raycastShaderBlocksAabb: hits wall block when origin is inside section aggregate AABB', () => {
  const words = new Uint32Array(SHADER_CUBES_WORDS_PER_FACE * 3)
  words[0] = 8 | (4 << WORD0.LY_SHIFT) | (8 << WORD0.LZ_SHIFT)
  words[4] = 8 | (5 << WORD0.LY_SHIFT) | (8 << WORD0.LZ_SHIFT)
  words[8] = 8 | (6 << WORD0.LY_SHIFT) | (8 << WORD0.LZ_SHIFT)
  const visitGen = new Uint16Array(4096)
  const visitStamp = 1
  const t = raycastShaderBlocksAabb(words, 0, 3, SHADER_CUBES_WORDS_PER_FACE, 8, 8, 8, 4.5, 5.5, 8.5, 1, 0, 0, 10, visitGen, visitStamp)!
  expect(t).toBeGreaterThan(0)
  expect(t).toBeLessThan(4)
})

test('raycastShaderBlocksAabb: ray into empty space does not hit', () => {
  const words = new Uint32Array(SHADER_CUBES_WORDS_PER_FACE)
  words[0] = 8 | (4 << WORD0.LY_SHIFT) | (8 << WORD0.LZ_SHIFT)
  const visitGen = new Uint16Array(4096)
  const visitStamp = 1
  const t = raycastShaderBlocksAabb(words, 0, 1, SHADER_CUBES_WORDS_PER_FACE, 8, 8, 8, 4.5, 5.5, 8.5, -1, 0, 0, 10, visitGen, visitStamp)
  expect(t).toBeUndefined()
})

test('raycastShaderBlocksAabb: eye inside solid block uses exit distance', () => {
  const lx = 5
  const ly = 3
  const lz = 7
  const sectionCenterX = 8
  const sectionCenterY = 8
  const sectionCenterZ = 8
  const words = new Uint32Array(SHADER_CUBES_WORDS_PER_FACE)
  words[0] = lx | (ly << WORD0.LY_SHIFT) | (lz << WORD0.LZ_SHIFT)
  const visitGen = new Uint16Array(4096)
  const visitStamp = 1
  const ox = sectionCenterX - 8 + lx + 0.5
  const oy = sectionCenterY - 8 + ly + 0.5
  const oz = sectionCenterZ - 8 + lz + 0.5
  const t = raycastShaderBlocksAabb(
    words, 0, 1, SHADER_CUBES_WORDS_PER_FACE,
    sectionCenterX, sectionCenterY, sectionCenterZ,
    ox, oy, oz, 0, 0, 1, 10, visitGen, visitStamp,
  )!
  expect(t).toBeGreaterThan(0)
  expect(t).toBeLessThanOrEqual(10)
  expect(t).toBeCloseTo(0.5, 5)
})

test('raycastShaderBlocksAabb: SoA stride-1 layout (GlobalBlockBuffer style)', () => {
  const w0 = new Uint32Array(2)
  w0[0] = 8 | (4 << WORD0.LY_SHIFT) | (8 << WORD0.LZ_SHIFT)
  w0[1] = 8 | (5 << WORD0.LY_SHIFT) | (8 << WORD0.LZ_SHIFT)
  const visitGen = new Uint16Array(4096)
  const visitStamp = 1
  const t = raycastShaderBlocksAabb(w0, 0, 2, 1, 8, 8, 8, 4.5, 5.5, 8.5, 1, 0, 0, 10, visitGen, visitStamp)!
  expect(t).toBeGreaterThan(0)
  expect(t).toBeLessThan(4)
})

const SECTION_HALF = LEGACY_SECTION_HALF_EXTENT + 0.01

test('sectionAabbIntersectsRay: ray toward section center within far', () => {
  expect(sectionAabbIntersectsRay(8, 8, 8, 4, 8, 8, 1, 0, 0, 4, SECTION_HALF)).toBe(true)
})

test('sectionAabbIntersectsRay: far shorter than gap to section', () => {
  expect(sectionAabbIntersectsRay(8, 8, 8, -20, 8, 8, 1, 0, 0, 3, SECTION_HALF)).toBe(false)
})

test('sectionAabbIntersectsRay: parallel offset ray misses box', () => {
  expect(sectionAabbIntersectsRay(8, 8, 8, -20, 8, -20, 1, 0, 0, 100, SECTION_HALF)).toBe(false)
})

test('sectionAabbIntersectsRay: origin inside box', () => {
  expect(sectionAabbIntersectsRay(8, 8, 8, 8, 8, 8, 0, 1, 0, 4, SECTION_HALF)).toBe(true)
})

test('raycastAabb: narrow floor slab blocks downward ray', () => {
  const words = new Uint32Array(SHADER_CUBES_WORDS_PER_FACE * 2)
  words[0] = 4 | (0 << WORD0.LY_SHIFT) | (4 << WORD0.LZ_SHIFT)
  words[4] = 5 | (0 << WORD0.LY_SHIFT) | (4 << WORD0.LZ_SHIFT)
  const box = computeShaderSectionRaycastAabb(words, 2, 8, 8, 8)!
  const t = raycastAabb(4.5, 10, 4.5, 0, -1, 0, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, 20)
  expect(t).toBeDefined()
  expect(t!).toBeGreaterThan(0)
  expect(t!).toBeLessThan(10)
})
