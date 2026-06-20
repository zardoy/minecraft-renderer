import { test, expect, beforeEach } from 'vitest'
import { WORD0, WORD2 } from '../../three/shaders/cubeBlockShader'
import {
  resetShaderCubeResources,
  getShaderCubeResources,
  isShaderCubeBlock,
  tryBuildShaderCubeInstances,
  buildShaderCubesFromWords,
  countVisibleFaces,
  unpackTexIndexFromWord2,
  decodeSectionBaseFromWords,
  packWord2Empty,
  packWord3,
  SHADER_CUBES_FORMAT_VERSION,
  SHADER_CUBES_WORDS_PER_FACE
} from '../bridge/shaderCubeBridge'
import { GlobalBlockBuffer } from '../../three/globalBlockBuffer'
import { buildVisibleCubeSpans } from '../../three/cubeDrawSpans'
import { createCubeBlockMaterial, computeSectionOriginRel } from '../../three/shaders/cubeBlockShader'
import * as THREE from 'three'
import { renderWasmOutputToGeometry } from '../bridge/render-from-wasm'

const VERSION = '1.16.5'
const STONE = 1

function requireShaderCubeResources() {
  const resources = getShaderCubeResources()
  if (!resources) throw new Error('shader cube resources unavailable in test')
  return resources
}
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
    light_combined: [[255, 255, 255, 255]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const model = {
    elements: [
      {
        faces: {
          up: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          down: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          east: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          west: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          south: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          north: { texture: { u: 0, v: 0, su: 16, sv: 16 } }
        }
      }
    ]
  }
  const ok = tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    {
      sectionOrigin: { x: 0, y: 0, z: 0 },
      sectionHeight: 16,
      tintPalette,
      textureIndexMapping
    },
    words
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
    light_combined: [[128, 128, 128, 128]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const model = {
    elements: [
      {
        faces: {
          up: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
          down: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
          east: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
          west: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
          south: { texture: { u: 16, v: 0, su: 16, sv: 16 } },
          north: { texture: { u: 16, v: 0, su: 16, sv: 16 } }
        }
      }
    ]
  }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    {
      sectionOrigin: { x: 0, y: 16, z: 0 },
      sectionHeight: 16,
      tintPalette,
      textureIndexMapping
    },
    words
  )
  const w0 = words[0]!
  expect(w0 & 0xf).toBe(10) // lx
  expect((w0 >> WORD0.LY_SHIFT) & 0xf).toBe(1) // ly = 17 - 16
  expect((w0 >> WORD0.LZ_SHIFT) & 0xf).toBe(4)
  expect((w0 >> WORD0.FACE_SHIFT) & 7).toBe(2) // east
})

test('isShaderCubeBlock: rejects model rotation and sectionHeight !== 16', () => {
  const { textureIndexMapping } = requireShaderCubeResources()
  const baseModel = {
    elements: [
      {
        faces: {
          up: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          down: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          east: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          west: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          south: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
          north: { texture: { u: 0, v: 0, su: 16, sv: 16 } }
        }
      }
    ]
  }
  expect(isShaderCubeBlock({ blockName: 'stone', blockProps: {}, isCube: true, model: baseModel }, baseModel, 16, textureIndexMapping)).toBe(true)
  expect(isShaderCubeBlock({ blockName: 'stone', blockProps: {}, isCube: true, model: baseModel }, baseModel, 24, textureIndexMapping)).toBe(false)
  expect(
    isShaderCubeBlock({ blockName: 'stone', blockProps: {}, isCube: true, model: { ...baseModel, y: 90 } }, { ...baseModel, y: 90 }, 16, textureIndexMapping)
  ).toBe(false)
})

test('renderWasmOutputToGeometry: stone emits shaderCubes and skips legacy vertices when enabled', () => {
  const block = {
    position: [0, 0, 0] as [number, number, number],
    block_state_id: STONE,
    visible_faces: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5),
    ao_data: Array.from({ length: 6 }, () => [3, 3, 3, 3]),
    light_data: Array.from({ length: 6 }, () => [1, 1, 1, 1]),
    light_combined: Array.from({ length: 6 }, () => [255, 255, 255, 255])
  }
  const out = renderWasmOutputToGeometry({ blocks: [block], block_count: 1, block_iterations: 0 }, VERSION, '0,0,0', { x: 8, y: 8, z: 8 }, undefined, {
    shaderCubes: true
  })
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
    light_data: [[1, 1, 1, 1]]
  }
  const out = renderWasmOutputToGeometry({ blocks: [block], block_count: 1, block_iterations: 0 }, VERSION, '0,0,0', { x: 8, y: 8, z: 8 }, undefined, {
    shaderCubes: false
  })
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
  north: { texture: { u: 0, v: 0, su: 16, sv: 16 } }
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
    light_combined: [[10, 20, 30, 40]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    { sectionOrigin: { x: 0, y: 0, z: 0 }, sectionHeight: 16, tintPalette, textureIndexMapping },
    words
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
    light_combined: [[255, 255, 255, 255]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  const opts = {
    sectionOrigin: { x: 0, y: 0, z: 0 },
    sectionHeight: 16,
    tintPalette,
    textureIndexMapping
  }
  tryBuildShaderCubeInstances(block, { blockName: 'stone', blockProps: {}, isCube: true, model }, model, opts, wordsFlip)
  expect(wordsFlip[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).not.toBe(0)

  // elemFaces [3,0,0,3] → remapped [0,3,3,0]: 0+0 < 3+3 → no diagonal flip
  tryBuildShaderCubeInstances({ ...block, ao_data: [[3, 0, 0, 3]] }, { blockName: 'stone', blockProps: {}, isCube: true, model }, model, opts, wordsNoFlip)
  expect(wordsNoFlip[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).toBe(0)
})

test('doAO false: full bright AO/light and no diagonal flip', () => {
  const words: number[] = []
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 0,
    ao_data: [[0, 0, 0, 0]],
    light_data: [[0, 0, 0, 0]],
    light_combined: [[0, 0, 0, 0]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
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
      doAO: false
    },
    words
  )
  expect(aoCorner0FromWord0(words[0]!)).toBe(3)
  for (let i = 0; i < 4; i++) {
    expect((words[1]! >> (i * 8)) & 0xff).toBe(255)
  }
  expect(words[2]! & (1 << WORD2.DIAGONAL_FLAG_SHIFT)).toBe(0)
})

const SECTION_ORIGIN_ROUND_TRIP_CASES: Array<{ x: number; y: number; z: number }> = [
  { x: 0, y: 16, z: 32 },
  { x: 0, y: 0, z: 0 },
  { x: 524288, y: 0, z: 524288 },
  { x: 1000000, y: 64, z: 1000000 },
  { x: 33000000, y: 0, z: 33000000 },
  { x: -524288, y: 0, z: -524288 },
  { x: -1000000, y: 0, z: -1000000 },
  { x: 1000000, y: 0, z: -1000000 }
]

test.each(SECTION_ORIGIN_ROUND_TRIP_CASES)('section base coords round-trip in word2/word3 at origin (%#)', sectionOrigin => {
  const words: number[] = []
  const block = {
    position: [10, 17, 4] as [number, number, number],
    visible_faces: 1 << 2,
    ao_data: [[3, 3, 3, 3]],
    light_data: [[1, 1, 1, 1]],
    light_combined: [[255, 255, 255, 255]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    { sectionOrigin, sectionHeight: 16, tintPalette, textureIndexMapping },
    words
  )
  const base = decodeSectionBaseFromWords(words[2]!, words[3]!)
  expect(base).toEqual(sectionOrigin)
})

test('packWord2Empty: bit 18 set regardless of high X/Z bits in word2', () => {
  const empty = packWord2Empty()
  expect(empty & (1 << WORD2.EMPTY_SHIFT)).not.toBe(0)
  const withHighBits = empty | (0x3f << WORD2.SECTION_X_HI_SHIFT) | (0x3f << WORD2.SECTION_Z_HI_SHIFT)
  expect(withHighBits & (1 << WORD2.EMPTY_SHIFT)).not.toBe(0)
})

test('section index relative decode past 2^20: exact integer subtract', () => {
  const sectionBlockX = 21_050_000
  const renderOrigin = { x: 21_000_000, y: 0, z: 0 }
  const words: number[] = []
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 2,
    ao_data: [[3, 3, 3, 3]],
    light_data: [[1, 1, 1, 1]],
    light_combined: [[255, 255, 255, 255]]
  }
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const model = { elements: [{ faces: SIX_FACE_TEXTURES }] }
  tryBuildShaderCubeInstances(
    block,
    { blockName: 'stone', blockProps: {}, isCube: true, model },
    model,
    {
      sectionOrigin: { x: sectionBlockX, y: 0, z: 0 },
      sectionHeight: 16,
      tintPalette,
      textureIndexMapping
    },
    words
  )
  const base = decodeSectionBaseFromWords(words[2]!, words[3]!)
  const sX = base.x / 16
  const sectionOriginRel = computeSectionOriginRel(renderOrigin)
  const sXr = sX - sectionOriginRel.x
  expect(sXr * 16).toBe(sectionBlockX - renderOrigin.x)
})

test('GlobalBlockBuffer: free-list reuses slot with EMPTY sentinel', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  const words = new Uint32Array([1, 2, 0, packWord3(0, 0), 3, 4, 0, packWord3(0, 0)])
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

type BufferInternals = {
  pendingRanges: Array<{ start: number; end: number }>
  pendingMove: { key: string; oldStart: number; newStart: number; count: number } | null
}

/** True if some queued (not-yet-uploaded) dirty range covers [start, end] — i.e. it WILL hit the GPU. */
function rangeQueuedForUpload(buffer: GlobalBlockBuffer, start: number, end: number): boolean {
  return getBufferInternals(buffer).pendingRanges.some(r => r.start <= end && r.end >= start)
}

function getBufferInternals(buffer: GlobalBlockBuffer): BufferInternals {
  return buffer as unknown as BufferInternals
}

function drainAllUploads(buffer: GlobalBlockBuffer): void {
  while (getBufferInternals(buffer).pendingRanges.length) buffer.uploadDirtyRange()
}

function makeSectionWords(faceW0: number[]): Uint32Array {
  const words = new Uint32Array(faceW0.length * 4)
  for (let i = 0; i < faceW0.length; i++) {
    words[i * 4] = faceW0[i]!
    words[i * 4 + 1] = 0
    words[i * 4 + 2] = 0
    words[i * 4 + 3] = packWord3(0, 0)
  }
  return words
}

function readSectionFaceWords(buffer: GlobalBlockBuffer, key: string): number[] {
  const slot = buffer.getSectionSlot(key)
  if (!slot) throw new Error(`missing section ${key}`)
  const geo = buffer.mesh.geometry
  const w0 = (geo.getAttribute('a_w0') as THREE.InstancedBufferAttribute).array as Uint32Array
  const w1 = (geo.getAttribute('a_w1') as THREE.InstancedBufferAttribute).array as Uint32Array
  const w2 = (geo.getAttribute('a_w2') as THREE.InstancedBufferAttribute).array as Uint32Array
  const w3 = (geo.getAttribute('a_w3') as THREE.InstancedBufferAttribute).array as Uint32Array
  const out: number[] = []
  for (let i = 0; i < slot.count; i++) {
    const idx = slot.start + i
    out.push(w0[idx]!, w1[idx]!, w2[idx]!, w3[idx]!)
  }
  return out
}

function finishCurrentMove(buffer: GlobalBlockBuffer): void {
  drainAllUploads(buffer)
  buffer.compactStep()
}

function isEmptyFace(buffer: GlobalBlockBuffer, index: number): boolean {
  const w2 = (buffer.mesh.geometry.getAttribute('a_w2') as THREE.InstancedBufferAttribute).array as Uint32Array
  return (w2[index]! & (1 << WORD2.EMPTY_SHIFT)) !== 0
}

test('GlobalBlockBuffer: compaction lowers watermark after interior-hole churn', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', makeSectionWords([30]), 1)
  expect(buffer.mesh.geometry.instanceCount).toBe(3)

  buffer.removeSection('b')
  drainAllUploads(buffer)
  expect(buffer.mesh.geometry.instanceCount).toBe(3)

  buffer.compactStep()
  finishCurrentMove(buffer)

  expect(buffer.mesh.geometry.instanceCount).toBe(2)
  expect(buffer.getSectionSlot('c')).toEqual({ start: 1, count: 1 })
  expect(readSectionFaceWords(buffer, 'c')[0]).toBe(30)
  expect(readSectionFaceWords(buffer, 'a')[0]).toBe(10)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: compaction preserves surviving section data', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([11, 12]), 2)
  buffer.addSection('b', makeSectionWords([21]), 1)
  buffer.addSection('c', makeSectionWords([31, 32, 33]), 3)
  const expectedA = readSectionFaceWords(buffer, 'a')
  const expectedC = readSectionFaceWords(buffer, 'c')

  buffer.removeSection('b')
  drainAllUploads(buffer)
  buffer.compactStep()
  finishCurrentMove(buffer)

  expect(readSectionFaceWords(buffer, 'a')).toEqual(expectedA)
  expect(readSectionFaceWords(buffer, 'c')).toEqual(expectedC)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: compaction defers instanceCount shrink until upload completes', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', makeSectionWords([30]), 1)
  buffer.removeSection('b')
  drainAllUploads(buffer)

  buffer.compactStep()
  expect(getBufferInternals(buffer).pendingMove).not.toBeNull()
  expect(buffer.mesh.geometry.instanceCount).toBe(3)

  finishCurrentMove(buffer)
  expect(getBufferInternals(buffer).pendingMove).toBeNull()
  expect(buffer.mesh.geometry.instanceCount).toBe(2)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: compaction runs one move at a time', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', makeSectionWords([30]), 1)
  buffer.addSection('d', makeSectionWords([40]), 1)
  buffer.addSection('e', makeSectionWords([50]), 1)
  buffer.removeSection('b')
  buffer.removeSection('d')
  drainAllUploads(buffer)

  buffer.compactStep()
  const moveAfterFirst = getBufferInternals(buffer).pendingMove
  expect(moveAfterFirst).not.toBeNull()

  buffer.compactStep()
  expect(getBufferInternals(buffer).pendingMove).toEqual(moveAfterFirst)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: compaction skips when fragmentation is below threshold', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', makeSectionWords([30]), 1)
  buffer.addSection('d', makeSectionWords([40]), 1)
  buffer.removeSection('b')
  drainAllUploads(buffer)
  expect(buffer.mesh.geometry.instanceCount).toBe(4)

  buffer.compactStep()
  expect(getBufferInternals(buffer).pendingMove).toBeNull()
  expect(buffer.mesh.geometry.instanceCount).toBe(4)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: interior-fallback move uploads EMPTY over old slot still in draw range', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  // A[0,2) B[2,2) C[4,3) — remove A; C (count 3) cannot fit hole [0,2), so B moves down.
  buffer.addSection('a', makeSectionWords([10, 11]), 2)
  buffer.addSection('b', makeSectionWords([20, 21]), 2)
  buffer.addSection('c', makeSectionWords([30, 31, 32]), 3)
  expect(buffer.mesh.geometry.instanceCount).toBe(7)

  buffer.removeSection('a')
  drainAllUploads(buffer)

  buffer.compactStep()
  expect(getBufferInternals(buffer).pendingMove?.key).toBe('b')
  expect(getBufferInternals(buffer).pendingMove?.oldStart).toBe(2)
  finishCurrentMove(buffer)

  // Guards the High fix: the vacated old slot [2,3] is still inside the draw range, so it MUST be
  // queued for GPU upload (markDirty). Checking isEmptyFace alone is insufficient — the CPU-backed
  // attribute array is cleared regardless; only the pending upload range proves the GPU is told.
  expect(rangeQueuedForUpload(buffer, 2, 3)).toBe(true)

  expect(buffer.mesh.geometry.instanceCount).toBe(7)
  expect(buffer.getSectionSlot('b')).toEqual({ start: 0, count: 2 })
  expect(readSectionFaceWords(buffer, 'b')[0]).toBe(20)
  expect(isEmptyFace(buffer, 2)).toBe(true)
  expect(isEmptyFace(buffer, 3)).toBe(true)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: removeSection during pending move clears old GPU copy', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', makeSectionWords([30]), 1)
  buffer.removeSection('b')
  drainAllUploads(buffer)

  buffer.compactStep()
  expect(getBufferInternals(buffer).pendingMove?.key).toBe('c')

  buffer.removeSection('c')
  expect(getBufferInternals(buffer).pendingMove).toBeNull()
  // The in-flight old copy at index 2 must be queued for upload, not just cleared in CPU memory.
  expect(rangeQueuedForUpload(buffer, 2, 2)).toBe(true)
  drainAllUploads(buffer)

  expect(buffer.hasSection('c')).toBe(false)
  expect(isEmptyFace(buffer, 2)).toBe(true)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: takeSectionData during pending move clears old GPU copy', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10, 11]), 2)
  buffer.addSection('b', makeSectionWords([20, 21]), 2)
  buffer.addSection('c', makeSectionWords([30, 31, 32]), 3)
  buffer.removeSection('a')
  drainAllUploads(buffer)

  buffer.compactStep()
  expect(getBufferInternals(buffer).pendingMove?.key).toBe('b')

  const taken = buffer.takeSectionData('b')
  expect(taken?.words[0]).toBe(20)
  expect(taken?.words[4]).toBe(21)
  expect(getBufferInternals(buffer).pendingMove).toBeNull()
  // The in-flight old copy at [2,3] must be queued for upload, not just cleared in CPU memory.
  expect(rangeQueuedForUpload(buffer, 2, 3)).toBe(true)
  drainAllUploads(buffer)

  expect(buffer.hasSection('b')).toBe(false)
  expect(isEmptyFace(buffer, 2)).toBe(true)
  expect(isEmptyFace(buffer, 3)).toBe(true)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: takeSectionData reads relocated section slot', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  const cWords = makeSectionWords([30, 31])
  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', cWords, 2)
  buffer.removeSection('b')
  drainAllUploads(buffer)
  buffer.compactStep()
  finishCurrentMove(buffer)

  const taken = buffer.takeSectionData('c')
  expect(taken?.count).toBe(2)
  expect(taken?.words[0]).toBe(30)
  expect(taken?.words[4]).toBe(31)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: pendingMove draw start uses oldStart for visible spans', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  buffer.addSection('b', makeSectionWords([20]), 1)
  buffer.addSection('c', makeSectionWords([30]), 1)
  buffer.removeSection('b')
  drainAllUploads(buffer)

  buffer.compactStep()
  const move = buffer.getPendingMove()
  expect(move?.key).toBe('c')

  const slotStart = buffer.getSectionSlot('c')!.start
  expect(buffer.getSectionDrawStart('c')).toBe(move!.oldStart)
  expect(buffer.getSectionDrawStart('c')).not.toBe(slotStart)

  const spans = buildVisibleCubeSpans([{ start: buffer.getSectionDrawStart('c')!, count: 1 }], buffer.getHighWatermark())
  expect(spans[0]?.start).toBe(move!.oldStart)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: uploadDirtyRange budgets large dirty span across frames', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  const faceCount = 20_000
  const words = new Uint32Array(faceCount * 4)
  for (let i = 0; i < faceCount; i++) {
    const src = i * 4
    words[src] = i + 1
    words[src + 1] = 0
    words[src + 2] = 0
    words[src + 3] = packWord3(0, 0)
  }
  buffer.addSection('big', words, faceCount)

  const w0Attr = buffer.mesh.geometry.getAttribute('a_w0') as THREE.InstancedBufferAttribute
  buffer.uploadDirtyRange()
  expect(w0Attr.updateRanges[0].start).toBe(0)
  expect(w0Attr.updateRanges[0].count).toBe(15_000)

  buffer.uploadDirtyRange()
  expect(w0Attr.updateRanges[0].start).toBe(15_000)
  expect(w0Attr.updateRanges[0].count).toBe(5_000)

  buffer.uploadDirtyRange()
  expect((buffer as unknown as { pendingRanges: unknown[] }).pendingRanges).toHaveLength(0)

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
