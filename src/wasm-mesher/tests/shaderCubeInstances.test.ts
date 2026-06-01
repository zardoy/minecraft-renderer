import { test, expect, beforeEach } from 'vitest'
import { WORD0, WORD2, WORD3 } from '../../three/shaders/cubeBlockShader'
import {
  resetShaderCubeResources,
  getShaderCubeResources,
  isShaderCubeBlock,
  tryBuildShaderCubeInstances,
  buildShaderCubesFromWords,
  countVisibleFaces,
  unpackTexIndexFromWord2,
  decodeSectionBaseFromWords,
  packWord3,
  SHADER_CUBES_FORMAT_VERSION,
  SHADER_CUBES_WORDS_PER_FACE,
} from '../bridge/shaderCubeBridge'
import { GlobalBlockBuffer } from '../../three/globalBlockBuffer'
import { createCubeBlockMaterial } from '../../three/shaders/cubeBlockShader'
import * as THREE from 'three'
import { renderWasmOutputToGeometry } from '../bridge/render-from-wasm'

const VERSION = '1.16.5'
const STONE = 1
/** mc-assets blocksAtlases.json → stone */
const STONE_ATLAS_TILE_INDEX = 552

beforeEach(() => {
  resetShaderCubeResources()
})

test('packWord2: AO diagonal flip sets bit 12', () => {
  const words: number[] = []
  const block = {
    position: [3, 5, 7] as [number, number, number],
    visible_faces: 1 << 0, // up only
    ao_data: [[0, 1, 2, 3]], // 0+3 >= 1+2 → flip
    light_data: [[1, 1, 1, 1]],
    light_combined: [[255, 255, 255, 255]],
  }
  const { textureIndexMapping, tintPalette } = getShaderCubeResources()
  const model = {
    elements: [{
      faces: {
        up: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        down: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        east: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        west: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        south: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        north: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
      },
    }],
  }
  const ok = tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    {
      sectionOrigin: { x: 0, y: 0, z: 0 },
      sectionHeight: 16,
      tintPalette,
      textureIndexMapping,
    },
    words,
  )
  expect(ok).toBe(true)
  expect(words.length).toBe(SHADER_CUBES_WORDS_PER_FACE)
  expect(words[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).not.toBe(0)
})

test('packWord0: section-local lx/ly/lz and face id', () => {
  const words: number[] = []
  const block = {
    position: [10, 17, 4] as [number, number, number],
    visible_faces: 1 << 2, // east
    ao_data: [[3, 3, 3, 3]],
    light_data: [[0.5, 0.5, 0.5, 0.5]],
    light_combined: [[128, 128, 128, 128]],
  }
  const { textureIndexMapping, tintPalette } = getShaderCubeResources()
  const model = {
    elements: [{
      faces: {
        up: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
        down: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
        east: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
        west: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
        south: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
        north: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
      },
    }],
  }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    {
      sectionOrigin: { x: 0, y: 16, z: 0 },
      sectionHeight: 16,
      tintPalette,
      textureIndexMapping,
    },
    words,
  )
  const w0 = words[0]!
  expect(w0 & 0xf).toBe(10) // lx
  expect((w0 >> WORD0.LY_SHIFT) & 0xf).toBe(1) // ly = 17 - 16
  expect((w0 >> WORD0.LZ_SHIFT) & 0xf).toBe(4)
  expect((w0 >> WORD0.FACE_SHIFT) & 7).toBe(2) // east
})

test('isShaderCubeBlock: rejects model rotation and sectionHeight !== 16', () => {
  const { textureIndexMapping } = getShaderCubeResources()
  const baseModel = {
    elements: [{
      faces: {
        up: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        down: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        east: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        west: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        south: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
        north: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
      },
    }],
  }
  expect(isShaderCubeBlock(
    { blockName: 'stone', blockProps: {}, isCube: true, model: baseModel },
    baseModel,
    16,
    textureIndexMapping,
  )).toBe(true)
  expect(isShaderCubeBlock(
    { blockName: 'stone', blockProps: {}, isCube: true, model: baseModel },
    baseModel,
    24,
    textureIndexMapping,
  )).toBe(false)
  expect(isShaderCubeBlock(
    { blockName: 'stone', blockProps: {}, isCube: true, model: { ...baseModel, y: 90 } },
    { ...baseModel, y: 90 },
    16,
    textureIndexMapping,
  )).toBe(false)
})

test('renderWasmOutputToGeometry: stone emits shaderCubes and skips legacy vertices when enabled', () => {
  const block = {
    position: [0, 0, 0] as [number, number, number],
    block_state_id: STONE,
    visible_faces: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5),
    ao_data: Array.from({ length: 6 }, () => [3, 3, 3, 3]),
    light_data: Array.from({ length: 6 }, () => [1, 1, 1, 1]),
    light_combined: Array.from({ length: 6 }, () => [255, 255, 255, 255]),
  }
  const out = renderWasmOutputToGeometry(
    { blocks: [block], block_count: 1, block_iterations: 0 },
    VERSION,
    '0,0,0',
    { x: 8, y: 8, z: 8 },
    undefined,
    { shaderCubes: true },
  )
  expect(out.shaderCubes?.count).toBe(6)
  expect(out.shaderCubes?.formatVersion).toBe(SHADER_CUBES_FORMAT_VERSION)
  expect(out.shaderCubes?.words.length).toBe(6 * SHADER_CUBES_WORDS_PER_FACE)
  expect(out.geometry.positions.length).toBe(0)
  expect(out.geometry.indices.length).toBe(0)
  const words = out.shaderCubes!.words
  for (let i = 0; i < words.length; i += SHADER_CUBES_WORDS_PER_FACE) {
    expect(unpackTexIndexFromWord2(words[i + 2]!)).toBe(STONE_ATLAS_TILE_INDEX)
  }
})

test('renderWasmOutputToGeometry: shaderCubes false keeps legacy path for stone', () => {
  const block = {
    position: [0, 0, 0] as [number, number, number],
    block_state_id: STONE,
    visible_faces: 1 << 0,
    ao_data: [[3, 3, 3, 3]],
    light_data: [[1, 1, 1, 1]],
  }
  const out = renderWasmOutputToGeometry(
    { blocks: [block], block_count: 1, block_iterations: 0 },
    VERSION,
    '0,0,0',
    { x: 8, y: 8, z: 8 },
    undefined,
    { shaderCubes: false },
  )
  expect(out.shaderCubes).toBeUndefined()
  expect(out.geometry.positions.length).toBeGreaterThan(0)
})

test('buildShaderCubesFromWords: empty → undefined', () => {
  expect(buildShaderCubesFromWords([])).toBeUndefined()
})

test('countVisibleFaces', () => {
  expect(countVisibleFaces(0b101010)).toBe(3)
})

const SIX_FACE_TEXTURES = {
  up: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
  down: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
  east: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
  west: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
  south: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
  north: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
}

function aoCorner0FromWord0(w0: number): number {
  return (w0 >> WORD0.AO_SHIFT) & 3
}

test('south face: AO corners remapped to shader order (elemFaces [0,3,1,2] → shader [2,3,0,1])', () => {
  const words: number[] = []
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 4, // south
    ao_data: [[0, 3, 1, 2]],
    light_data: [[1, 1, 1, 1]],
    light_combined: [[10, 20, 30, 40]],
  }
  const { textureIndexMapping, tintPalette } = getShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    { sectionOrigin: { x: 0, y: 0, z: 0 }, sectionHeight: 16, tintPalette, textureIndexMapping },
    words,
  )
  // Shader vi=0 must get elemFaces ao[2]=1, not ao[0]=0
  expect(aoCorner0FromWord0(words[0]!)).toBe(1)
  // Shader vi=1 → ao[3]=2
  expect((words[0]! >> (WORD0.AO_SHIFT + WORD0.AO_BITS_PER_CORNER)) & 3).toBe(2)
})

test('south face: diagonal flip uses remapped AO (differs from raw elemFaces formula)', () => {
  const wordsFlip: number[] = []
  const wordsNoFlip: number[] = []
  const ao = [0, 3, 1, 2] // raw: 0+2 < 3+1 → no flip; remapped [1,2,3,0]: 1+0 >= 2+3 → flip
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 4,
    ao_data: [ao],
    light_data: [[1, 1, 1, 1]],
    light_combined: [[255, 255, 255, 255]],
  }
  const { textureIndexMapping, tintPalette } = getShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  const opts = {
    sectionOrigin: { x: 0, y: 0, z: 0 },
    sectionHeight: 16,
    tintPalette,
    textureIndexMapping,
  }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    opts,
    wordsFlip,
  )
  expect(wordsFlip[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).not.toBe(0)

  // elemFaces [3,0,0,3] → remapped [0,3,3,0]: 0+0 < 3+3 → no diagonal flip
  tryBuildShaderCubeInstances(
    { ...block, ao_data: [[3, 0, 0, 3]] },
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    opts,
    wordsNoFlip,
  )
  expect(wordsNoFlip[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).toBe(0)
})

test('doAO false: full bright AO/light and no diagonal flip', () => {
  const words: number[] = []
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 0,
    ao_data: [[0, 0, 0, 0]],
    light_data: [[0, 0, 0, 0]],
    light_combined: [[0, 0, 0, 0]],
  }
  const { textureIndexMapping, tintPalette } = getShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    {
      sectionOrigin: { x: 0, y: 0, z: 0 },
      sectionHeight: 16,
      tintPalette,
      textureIndexMapping,
      doAO: false,
    },
    words,
  )
  expect(aoCorner0FromWord0(words[0]!)).toBe(3)
  for (let i = 0; i < 4; i++) {
    expect((words[1]! >> (i * 8)) & 0xff).toBe(255)
  }
  expect(words[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).toBe(0)
})

test('section base coords round-trip in word2/word3', () => {
  const words: number[] = []
  const block = {
    position: [10, 17, 4] as [number, number, number],
    visible_faces: 1 << 2,
    ao_data: [[3, 3, 3, 3]],
    light_data: [[1, 1, 1, 1]],
    light_combined: [[255, 255, 255, 255]],
  }
  const { textureIndexMapping, tintPalette } = getShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  const sectionOrigin = { x: 0, y: 16, z: 32 }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    { sectionOrigin, sectionHeight: 16, tintPalette, textureIndexMapping },
    words,
  )
  const base = decodeSectionBaseFromWords(words[2]!, words[3]!)
  expect(base).toEqual(sectionOrigin)
  const sX = (words[3]! & 0xffff) - WORD3.SECTION_BIAS
  const sZ = ((words[3]! >>> 16) & 0xffff) - WORD3.SECTION_BIAS
  const sY = ((words[2]! >>> WORD2.SECTION_Y_SHIFT) & 0x1f) - 4
  expect(sX * 16).toBe(sectionOrigin.x)
  expect(sY * 16).toBe(sectionOrigin.y)
  expect(sZ * 16).toBe(sectionOrigin.z)
})

test('GlobalBlockBuffer: free-list reuses slot with EMPTY sentinel', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  const words = new Uint32Array([
    1, 2, 0, packWord3(0, 0),
    3, 4, 0, packWord3(0, 0),
  ])
  buffer.addSection('a', words, 2)
  expect(buffer.mesh.geometry.instanceCount).toBe(2)

  buffer.removeSection('a')
  const w2Attr = buffer.mesh.geometry.getAttribute('a_w2') as THREE.InstancedBufferAttribute
  expect(w2Attr.array[0]! & (1 << WORD2.EMPTY_SHIFT)).not.toBe(0)
  expect(w2Attr.array[1]! & (1 << WORD2.EMPTY_SHIFT)).not.toBe(0)

  const wordsB = new Uint32Array([5, 6, 0, packWord3(16, 0)])
  buffer.addSection('b', wordsB, 1)
  expect(buffer.mesh.geometry.getAttribute('a_w0').array[0]).toBe(5)

  buffer.dispose()
  mat.dispose()
})

test('getShaderCubeResources: returns null without loadedData.tints (no throw)', () => {
  const prev = (globalThis as any).loadedData
  ;(globalThis as any).loadedData = {}
  resetShaderCubeResources()
  expect(getShaderCubeResources()).toBeNull()
  ;(globalThis as any).loadedData = prev
  resetShaderCubeResources()
})
