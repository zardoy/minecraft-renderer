import { test, expect } from 'vitest'
import { computeShaderSectionRaycastAabb, raycastAabb } from '../../three/sectionRaycastAabb'
import { SHADER_CUBES_WORDS_PER_FACE } from '../bridge/shaderCubeBridge'
import { WORD0 } from '../../three/shaders/cubeBlockShader'

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
