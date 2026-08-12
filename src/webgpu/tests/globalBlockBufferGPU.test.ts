import { describe, expect, it } from 'vitest'
import { GlobalBlockBufferGPU, WORDS_PER_FACE, SECTION_META_STRIDE, RUN_COUNTS_OFFSET, FACE_DIRECTIONS, sortFacesByDirection } from '../globalBlockBufferGPU'
import { WORD0 } from '../../three/shaders/cubeBlockShader'

/** Builds face words with a given direction per face, tagging word1 so we can track order. */
function facesWithDirections(directions: number[]): Uint32Array {
  const out = new Uint32Array(directions.length * WORDS_PER_FACE)
  for (const [i, faceId] of directions.entries()) {
    out[i * WORDS_PER_FACE] = (faceId & 0x7) << WORD0.FACE_SHIFT
    out[i * WORDS_PER_FACE + 1] = i // identity tag
  }
  return out
}

const directionOf = (words: Uint32Array, face: number) => (words[face * WORDS_PER_FACE] >>> WORD0.FACE_SHIFT) & 0x7
const tagOf = (words: Uint32Array, face: number) => words[face * WORDS_PER_FACE + 1]

/** Distinctive words so we can assert the exact bytes landed in the right slot. */
function words(faceCount: number, seed: number): Uint32Array {
  const out = new Uint32Array(faceCount * WORDS_PER_FACE)
  for (let i = 0; i < faceCount; i++) {
    out[i * WORDS_PER_FACE] = seed * 1000 + i
    out[i * WORDS_PER_FACE + 1] = seed
    out[i * WORDS_PER_FACE + 2] = 0
    out[i * WORDS_PER_FACE + 3] = 0
  }
  return out
}

const faceWordsOf = (buffer: GlobalBlockBufferGPU) => buffer.faceWords.array as Uint32Array
const metaOf = (buffer: GlobalBlockBufferGPU) => buffer.sectionMeta.array as Int32Array

describe('GlobalBlockBufferGPU', () => {
  it('stores interleaved words verbatim, without de-interleaving', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    const input = words(4, 7)
    expect(buffer.addSection('a', input, 4, 1, 2, 3)).toBe(true)

    // The mesher layout must survive untouched — this is the CPU copy we removed.
    expect(faceWordsOf(buffer).slice(0, 4 * WORDS_PER_FACE)).toEqual(input)
  })

  it('publishes section metadata for the cull pass', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', words(10, 1), 10, -5, 3, 42)

    const meta = metaOf(buffer)
    expect([meta[0], meta[1], meta[2]]).toEqual([-5, 3, 42])
    expect(meta[3]).toBe(0) // faceStart
    expect(meta[4]).toBe(10) // faceCount
  })

  it('overwrites in place when a section is re-added at the same size', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', words(8, 1), 8, 0, 0, 0)
    buffer.addSection('b', words(8, 2), 8, 1, 0, 0)

    const before = metaOf(buffer)[3]
    buffer.addSection('a', words(8, 9), 8, 0, 0, 0)

    // Same slot reused: no allocator churn, and 'b' must not have moved.
    expect(metaOf(buffer)[3]).toBe(before)
    expect(faceWordsOf(buffer)[0]).toBe(9000)
    expect(buffer.sectionCount).toBe(2)
  })

  it('reuses a freed range for a later same-size section', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', words(16, 1), 16, 0, 0, 0)
    buffer.addSection('b', words(16, 2), 16, 1, 0, 0)

    buffer.removeSection('a')
    buffer.addSection('c', words(16, 3), 16, 2, 0, 0)

    // 'c' should land in a's hole (offset 0), not extend the high-watermark.
    expect(faceWordsOf(buffer)[0]).toBe(3000)
    expect(buffer.usedFaces).toBe(32)
  })

  it('reclaims the trailing block instead of fragmenting', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', words(16, 1), 16, 0, 0, 0)
    buffer.addSection('b', words(16, 2), 16, 1, 0, 0)
    expect(buffer.usedFaces).toBe(32)

    buffer.removeSection('b')
    expect(buffer.usedFaces).toBe(16)
    expect(buffer.fragmentation).toBe(0)
  })

  it('marks removed sections empty so the cull pass skips them', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', words(4, 1), 4, 1, 1, 1)
    buffer.removeSection('a')

    const meta = metaOf(buffer)
    expect(meta[4]).toBe(0) // faceCount zeroed
    expect(buffer.sectionCount).toBe(0)
  })

  it('refuses to grow past the adapter capacity ceiling', () => {
    // maxCapacityFaces below the growth increment means the first overflow must fail
    // rather than allocate a buffer the device cannot bind.
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 64, maxCapacityFaces: 64 })
    expect(buffer.addSection('a', words(64, 1), 64, 0, 0, 0)).toBe(true)
    expect(buffer.addSection('b', words(1, 2), 1, 1, 0, 0)).toBe(false)
  })

  it('reports fragmentation from interior holes', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', words(16, 1), 16, 0, 0, 0)
    buffer.addSection('b', words(16, 2), 16, 1, 0, 0)
    buffer.addSection('c', words(16, 3), 16, 2, 0, 0)

    buffer.removeSection('b') // interior hole, cannot be reclaimed by trailing coalesce
    expect(buffer.fragmentation).toBeCloseTo(16 / 48, 5)
  })

  it('recycles metadata slots so the cull dispatch does not grow unbounded', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 4096 })
    for (let i = 0; i < 10; i++) buffer.addSection(`s${i}`, words(8, i), 8, i, 0, 0)
    const peak = buffer.sectionDispatchCount

    for (let i = 0; i < 10; i++) buffer.removeSection(`s${i}`)
    for (let i = 0; i < 10; i++) buffer.addSection(`t${i}`, words(8, i), 8, i, 0, 0)

    expect(buffer.sectionDispatchCount).toBe(peak)
  })

  it('groups faces into contiguous runs by direction', () => {
    const input = facesWithDirections([5, 0, 3, 0, 5, 2])
    const { words, runCounts } = sortFacesByDirection(input, 6)

    const order = Array.from({ length: 6 }, (_, f) => directionOf(words, f))
    expect(order).toEqual([0, 0, 2, 3, 5, 5])
    expect([...runCounts]).toEqual([2, 0, 1, 1, 0, 2])
  })

  it('keeps faces stable within a direction run', () => {
    // Three UP faces tagged 0,1,2 interleaved with other directions.
    const input = facesWithDirections([0, 4, 0, 1, 0])
    const { words } = sortFacesByDirection(input, 5)

    // The UP run occupies slots 0..2 and must preserve the original relative order.
    expect([tagOf(words, 0), tagOf(words, 1), tagOf(words, 2)]).toEqual([0, 2, 4])
  })

  it('run counts sum to the face count', () => {
    const input = facesWithDirections([0, 1, 2, 3, 4, 5, 5, 5, 1])
    const { runCounts } = sortFacesByDirection(input, 9)
    expect(runCounts.reduce((a, b) => a + b, 0)).toBe(9)
  })

  it('publishes per-direction run counts the cull pass reserves from', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', facesWithDirections([0, 0, 3, 5]), 4, 0, 0, 0)

    const meta = metaOf(buffer)
    const runs = Array.from({ length: FACE_DIRECTIONS }, (_, d) => meta[RUN_COUNTS_OFFSET + d])
    expect(runs).toEqual([2, 0, 0, 1, 0, 1])
    // Runs must tile the section exactly, or the cull pass would emit stale faces.
    expect(runs.reduce((a, b) => a + b, 0)).toBe(meta[4])
  })

  it('stores faces in sorted order so run offsets address the right faces', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', facesWithDirections([2, 0, 2, 1]), 4, 0, 0, 0)

    const stored = faceWordsOf(buffer)
    expect([0, 1, 2, 3].map(f => directionOf(stored, f))).toEqual([0, 1, 2, 2])
  })

  it('clears run counts when a section is removed', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 1024 })
    buffer.addSection('a', facesWithDirections([0, 1, 2]), 3, 0, 0, 0)
    buffer.removeSection('a')

    const meta = metaOf(buffer)
    const runs = Array.from({ length: FACE_DIRECTIONS }, (_, d) => meta[RUN_COUNTS_OFFSET + d])
    expect(runs).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('sizes the metadata buffer to the stride', () => {
    const buffer = new GlobalBlockBufferGPU({ initialCapacityFaces: 64, maxSections: 4 })
    expect(metaOf(buffer).length).toBe(4 * SECTION_META_STRIDE)
  })
})
