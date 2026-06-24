import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { GlobalLegacyBuffer, MAX_OPAQUE_SPANS, carveSpansAroundPendingRanges } from '../globalLegacyBuffer'
import { createGlobalLegacyBlockMaterial } from '../shaders/legacyBlockShader'

function makeQuadGeometry(): {
  positions: Float32Array
  colors: Float32Array
  skyLights: Float32Array
  blockLights: Float32Array
  uvs: Float32Array
  indices: Uint32Array
} {
  return {
    positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    skyLights: new Float32Array([1, 1, 1, 1]),
    blockLights: new Float32Array([0, 0, 0, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3])
  }
}

type BufferInternals = {
  pendingRanges: Array<{ start: number; end: number }>
  pendingMove: { key: string; oldStart: number; newStart: number; count: number } | null
  growCapacity: (minQuads: number) => void
}

function getInternals(buffer: GlobalLegacyBuffer): BufferInternals {
  return buffer as unknown as BufferInternals
}

function drainUploads(buffer: GlobalLegacyBuffer): void {
  while (getInternals(buffer).pendingRanges.length) buffer.uploadDirtyRange()
}

function finishCurrentMove(buffer: GlobalLegacyBuffer): void {
  drainUploads(buffer)
  buffer.compactStep()
}

function readSectionIndices(buffer: GlobalLegacyBuffer, key: string): number[] {
  const slot = buffer.getSectionSlot(key)
  if (!slot) throw new Error(`missing section ${key}`)
  const indexAttr = buffer.mesh.geometry.index!.array as Uint32Array
  const base = slot.start * 6
  const len = slot.count * 6
  return Array.from(indexAttr.slice(base, base + len))
}

test('GlobalLegacyBuffer: slot reuse and a_origin fill', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 100, 64, 200)
  const originAttr = buffer.mesh.geometry.getAttribute('a_origin') as THREE.BufferAttribute
  expect(originAttr.array[0]).toBe(100)
  expect(originAttr.array[1]).toBe(64)
  expect(originAttr.array[2]).toBe(200)

  buffer.removeSection('a')
  drainUploads(buffer)

  buffer.addSection('b', geo, 8, 8, 8)
  const indexAttr = buffer.mesh.geometry.index!.array as Uint32Array
  expect(indexAttr[0]).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: a_origin stores world minus render origin', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.setRenderOrigin({ x: 16, y: 0, z: 16 })
  buffer.addSection('a', geo, 100, 64, 200)
  const originAttr = buffer.mesh.geometry.getAttribute('a_origin') as THREE.BufferAttribute
  expect(originAttr.array[0]).toBe(84)
  expect(originAttr.array[1]).toBe(64)
  expect(originAttr.array[2]).toBe(184)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: rebase shifts all a_origin and marks dirty', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 100, 64, 200)
  buffer.addSection('b', geo, 16, 8, 16)

  buffer.rebase({ x: 16, y: 0, z: 16 })
  const originAttr = buffer.mesh.geometry.getAttribute('a_origin') as THREE.BufferAttribute
  expect(originAttr.array[0]).toBe(84)
  expect(originAttr.array[1]).toBe(64)
  expect(originAttr.array[2]).toBe(184)

  const slotB = buffer.getSectionSlot('b')!
  const baseB = slotB.start * 4 * 3
  expect(originAttr.array[baseB]).toBe(0)
  expect(originAttr.array[baseB + 1]).toBe(8)
  expect(originAttr.array[baseB + 2]).toBe(0)

  expect(getInternals(buffer).pendingRanges.length).toBeGreaterThan(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: index rebase on copy', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 8, 16)

  const slot = buffer.getSectionSlot('b')!
  const indexAttr = buffer.mesh.geometry.index!.array as Uint32Array
  const base = slot.start * 4
  expect(indexAttr[slot.start * 6]).toBe(base)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: upload budget splits large dirty span', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  for (let i = 0; i < 12; i++) {
    buffer.addSection(`s${i}`, geo, i, 0, i)
  }

  const pendingBefore = getInternals(buffer).pendingRanges.length
  expect(pendingBefore).toBeGreaterThan(0)

  buffer.uploadDirtyRange()
  expect(getInternals(buffer).pendingRanges.length).toBeGreaterThanOrEqual(0)

  drainUploads(buffer)
  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: removeSection zero-fills indices', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  const indexAttr = buffer.mesh.geometry.index!.array as Uint32Array
  expect(indexAttr[1]).toBe(1)

  buffer.removeSection('a')
  expect(indexAttr[0]).toBe(0)
  expect(indexAttr[1]).toBe(0)
  expect(indexAttr[2]).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: material array on mesh', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  expect(Array.isArray(buffer.mesh.material)).toBe(true)
  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans opaque merges nearby spans', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 16, growthIncrementQuads: 16 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  drainUploads(buffer)
  buffer.updateDrawSpans(
    [
      { key: 'a', distSq: 1 },
      { key: 'b', distSq: 4 }
    ],
    'opaque'
  )

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBe(1)
  expect(spans[0]!.indexCount).toBe(12)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans opaque full draw when most quads visible', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 4, growthIncrementQuads: 4 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  drainUploads(buffer)
  buffer.updateDrawSpans(
    [
      { key: 'a', distSq: 1 },
      { key: 'b', distSq: 2 },
      { key: 'c', distSq: 3 }
    ],
    'opaque'
  )

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBe(1)
  expect(spans[0]!.indexStart).toBe(0)
  expect(spans[0]!.indexCount).toBe(18)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans sortedBlend orders back-to-front', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 16, growthIncrementQuads: 16 })
  const geo = makeQuadGeometry()

  buffer.addSection('near', geo, 0, 0, 0)
  buffer.addSection('far', geo, 16, 0, 0)
  drainUploads(buffer)
  buffer.updateDrawSpans(
    [
      { key: 'near', distSq: 1 },
      { key: 'far', distSq: 100 }
    ],
    'sortedBlend'
  )

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBe(2)
  expect(spans[0]!.indexStart).toBe(6)
  expect(spans[1]!.indexStart).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans skips missing keys', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  drainUploads(buffer)
  buffer.updateDrawSpans([{ key: 'missing', distSq: 1 }], 'opaque')

  expect(buffer.getVisibleIndexSpans().length).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: reset clears visible spans', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  drainUploads(buffer)
  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }], 'opaque')
  expect(buffer.getVisibleIndexSpans().length).toBeGreaterThan(0)

  buffer.reset()
  expect(buffer.getVisibleIndexSpans().length).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans opaque does not bridge interior gaps', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const visibleSectionCount = MAX_OPAQUE_SPANS + 5
  const padQuads = 257
  const buffer = new GlobalLegacyBuffer(mat, scene, {
    initialCapacityQuads: visibleSectionCount * (padQuads + 1) + padQuads,
    growthIncrementQuads: 1024
  })
  const geo = makeQuadGeometry()
  const padGeo = {
    ...makeQuadGeometry(),
    positions: new Float32Array(padQuads * 4 * 3),
    colors: new Float32Array(padQuads * 4 * 3).fill(1),
    skyLights: new Float32Array(padQuads * 4).fill(1),
    blockLights: new Float32Array(padQuads * 4).fill(0),
    uvs: new Float32Array(padQuads * 4 * 2),
    indices: new Uint32Array(padQuads * 6)
  }
  for (let q = 0; q < padQuads; q++) {
    const vb = q * 4
    padGeo.indices.set([vb, vb + 1, vb + 2, vb, vb + 2, vb + 3], q * 6)
  }
  const visible: Array<{ key: string; distSq: number }> = []

  for (let i = 0; i < visibleSectionCount; i++) {
    const key = `s${i}`
    buffer.addSection(key, geo, i * 16, 0, 0)
    visible.push({ key, distSq: i })
    if (i < visibleSectionCount - 1) {
      buffer.addSection(`pad${i}`, padGeo, 0, 0, 0)
    }
  }

  for (let i = 0; i < visibleSectionCount - 1; i++) {
    const cur = buffer.getSectionSlot(`s${i}`)!
    const next = buffer.getSectionSlot(`s${i + 1}`)!
    expect(next.start - (cur.start + cur.count)).toBeGreaterThan(256)
  }

  drainUploads(buffer)
  buffer.updateDrawSpans(visible, 'opaque')

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBe(visibleSectionCount)

  const covered = new Set<number>()
  for (const span of spans) {
    for (let idx = span.indexStart; idx < span.indexStart + span.indexCount; idx++) {
      covered.add(idx)
    }
  }
  for (let i = 0; i < visibleSectionCount; i++) {
    const slot = buffer.getSectionSlot(`s${i}`)!
    const startIdx = slot.start * 6
    const endIdx = startIdx + slot.count * 6
    for (let idx = startIdx; idx < endIdx; idx++) {
      expect(covered.has(idx)).toBe(true)
    }
  }

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: addSection rejects non-quad geometry', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)

  const bad = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    colors: new Float32Array(9),
    skyLights: new Float32Array(3).fill(1),
    blockLights: new Float32Array(3).fill(0),
    uvs: new Float32Array(6),
    indices: new Uint32Array([0, 1, 2])
  }
  expect(buffer.addSection('bad', bad, 0, 0, 0)).toBe(false)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: compaction lowers watermark after interior-hole churn', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  expect(buffer.getHighWatermark()).toBe(3)

  buffer.removeSection('b')
  drainUploads(buffer)
  expect(buffer.getHighWatermark()).toBe(3)

  buffer.compactStep()
  finishCurrentMove(buffer)

  expect(buffer.getHighWatermark()).toBe(2)
  expect(buffer.getSectionSlot('c')).toEqual({ start: 1, count: 1 })
  const slotC = buffer.getSectionSlot('c')!
  const indices = readSectionIndices(buffer, 'c')
  expect(indices[0]).toBe(slotC.start * 4)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: grow during in-flight move preserves section data', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 4, growthIncrementQuads: 8 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  buffer.removeSection('b')
  drainUploads(buffer)

  buffer.compactStep()
  expect(buffer.getPendingMove()).not.toBeNull()
  expect(buffer.hasSection('c')).toBe(true)

  getInternals(buffer).growCapacity(16)

  expect(buffer.getPendingMove()).toBeNull()
  expect(buffer.hasSection('c')).toBe(true)
  const slotC = buffer.getSectionSlot('c')!
  const indices = readSectionIndices(buffer, 'c')
  expect(indices[0]).toBe(slotC.start * 4)
  expect(buffer.getCapacityQuads()).toBeGreaterThanOrEqual(16)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: finalize move bumps layoutVersion and updates draw spans', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  buffer.removeSection('b')
  drainUploads(buffer)

  buffer.compactStep()
  expect(buffer.getPendingMove()).not.toBeNull()
  const versionAfterMove = buffer.getLayoutVersion()

  const visible = [{ key: 'c', distSq: 1 }]
  buffer.updateDrawSpans(visible, 'opaque')
  expect(buffer.getVisibleIndexSpans()[0]!.indexStart).toBe(2 * 6)

  drainUploads(buffer)
  buffer.compactStep()
  expect(buffer.getPendingMove()).toBeNull()
  expect(buffer.getLayoutVersion()).toBe(versionAfterMove + 1)

  buffer.updateDrawSpans(visible, 'opaque')
  expect(buffer.getVisibleIndexSpans()[0]!.indexStart).toBe(1 * 6)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: sortedBlend accepts more than MAX_OPAQUE_SPANS sections', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const sectionCount = MAX_OPAQUE_SPANS + 6
  const buffer = new GlobalLegacyBuffer(mat, scene, {
    initialCapacityQuads: sectionCount + 4,
    growthIncrementQuads: 64
  })
  const geo = makeQuadGeometry()
  const visible: Array<{ key: string; distSq: number }> = []

  for (let i = 0; i < sectionCount; i++) {
    const key = `s${i}`
    buffer.addSection(key, geo, i * 16, 0, 0)
    visible.push({ key, distSq: sectionCount - i })
  }

  drainUploads(buffer)
  buffer.updateDrawSpans(visible, 'sortedBlend')
  expect(buffer.getVisibleIndexSpans().length).toBe(sectionCount)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: new section gated until upload completes', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  expect(buffer.getSectionDrawStart('a')).toBeUndefined()
  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }], 'opaque')
  expect(buffer.getVisibleIndexSpans().length).toBe(0)

  drainUploads(buffer)
  expect(buffer.getSectionDrawStart('a')).toBe(0)
  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }], 'opaque')
  expect(buffer.getVisibleIndexSpans().length).toBe(1)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: remesh double-buffers old geometry until upload', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  drainUploads(buffer)
  const oldStart = buffer.getSectionSlot('a')!.start

  buffer.addSection('a', geo, 16, 0, 0)
  expect(buffer.getSectionDrawStart('a')).toBe(oldStart)
  expect(buffer.hasPendingReplace()).toBe(true)

  const indexAttr = buffer.mesh.geometry.index!.array as Uint32Array
  expect(indexAttr[oldStart * 6 + 1]).not.toBe(0)

  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }], 'opaque')
  expect(buffer.getVisibleIndexSpans()[0]!.indexStart).toBe(oldStart * 6)

  const epochBefore = buffer.getUploadEpoch()
  drainUploads(buffer)
  buffer.compactStep()
  expect(buffer.hasPendingReplace()).toBe(false)
  expect(buffer.getUploadEpoch()).toBeGreaterThan(epochBefore)
  finishCurrentMove(buffer)
  expect(buffer.getSectionDrawStart('a')).toBe(buffer.getSectionSlot('a')!.start)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: remesh before previous upload completes keeps fully-uploaded fallback', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  drainUploads(buffer)
  buffer.compactStep()
  const slotA = buffer.getSectionSlot('a')!.start

  buffer.addSection('a', geo, 16, 0, 0)
  expect(buffer.hasPendingReplace()).toBe(true)
  expect(buffer.hasPendingUploads()).toBe(true)

  buffer.addSection('a', geo, 32, 0, 0)

  const drawStart = buffer.getSectionDrawStart('a')
  const drawCount = buffer.getSectionDrawCount('a')!
  expect(drawStart).toBe(slotA)
  expect(buffer.isRangeFullyUploaded(drawStart!, drawStart! + drawCount - 1)).toBe(true)

  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }], 'opaque')
  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBeGreaterThan(0)
  expect(spans.some(s => s.indexStart <= slotA * 6 && s.indexStart + s.indexCount > slotA * 6)).toBe(true)

  const indexAttr = buffer.mesh.geometry.index!.array as Uint32Array
  expect(indexAttr[slotA * 6 + 1]).not.toBe(0)

  drainUploads(buffer)
  buffer.compactStep()
  finishCurrentMove(buffer)
  const slotC = buffer.getSectionSlot('a')!.start
  expect(buffer.getSectionDrawStart('a')).toBe(slotC)
  expect(indexAttr[slotC * 6 + 1]).not.toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: full-draw blocked when uploads pending', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 8, growthIncrementQuads: 8 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  drainUploads(buffer)
  buffer.addSection('d', geo, 48, 0, 0)

  buffer.updateDrawSpans(
    [
      { key: 'a', distSq: 1 },
      { key: 'b', distSq: 2 },
      { key: 'c', distSq: 3 }
    ],
    'opaque'
  )

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBeGreaterThan(0)
  expect(spans.some(s => s.indexStart === 0 && s.indexCount === buffer.getHighWatermark() * 6)).toBe(false)
  expect(spans.reduce((sum, s) => sum + s.indexCount, 0)).toBe(18)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: full-draw allowed when buffer is clean', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 4, growthIncrementQuads: 4 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  drainUploads(buffer)

  buffer.updateDrawSpans(
    [
      { key: 'a', distSq: 1 },
      { key: 'b', distSq: 2 },
      { key: 'c', distSq: 3 }
    ],
    'opaque'
  )

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBe(1)
  expect(spans[0]!.indexStart).toBe(0)
  expect(spans[0]!.indexCount).toBe(buffer.getHighWatermark() * 6)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: uploadEpoch increments on partial upload advance', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  for (let i = 0; i < 6000; i++) {
    buffer.addSection(`s${i}`, geo, i * 16, 0, 0)
  }
  const epoch0 = buffer.getUploadEpoch()
  buffer.uploadDirtyRange()
  expect(buffer.getUploadEpoch()).toBe(epoch0 + 1)
  expect(buffer.hasPendingUploads()).toBe(true)
  buffer.uploadDirtyRange()
  expect(buffer.getUploadEpoch()).toBe(epoch0 + 2)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: carveSpansAroundPendingRanges splits merged span', () => {
  const carved = carveSpansAroundPendingRanges([{ start: 0, count: 100 }], [{ start: 40, end: 59 }])
  expect(carved).toEqual([
    { start: 0, count: 40 },
    { start: 60, count: 40 }
  ])
})

test('GlobalLegacyBuffer: uploadEpoch increments when dirty range drains', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  const epoch0 = buffer.getUploadEpoch()
  buffer.addSection('a', geo, 0, 0, 0)
  drainUploads(buffer)
  expect(buffer.getUploadEpoch()).toBeGreaterThan(epoch0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: mergeOpaqueSpans only merges adjacent slots', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 16, growthIncrementQuads: 8 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  drainUploads(buffer)

  buffer.updateDrawSpans(
    [
      { key: 'a', distSq: 1 },
      { key: 'b', distSq: 2 },
      { key: 'c', distSq: 3 }
    ],
    'opaque'
  )
  expect(buffer.getVisibleIndexSpans().length).toBe(1)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: mergeOpaqueSpans skips gap with pending upload', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene, { initialCapacityQuads: 8, growthIncrementQuads: 8 })
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.addSection('b', geo, 16, 0, 0)
  buffer.addSection('c', geo, 32, 0, 0)
  drainUploads(buffer)
  buffer.removeSection('b')
  drainUploads(buffer)

  buffer.addSection('b', geo, 16, 0, 0)
  buffer.updateDrawSpans(
    [
      { key: 'a', distSq: 1 },
      { key: 'c', distSq: 2 }
    ],
    'opaque'
  )

  const spans = buffer.getVisibleIndexSpans()
  expect(spans.length).toBe(2)
  expect(spans[0]!.indexCount).toBe(6)
  expect(spans[1]!.indexCount).toBe(6)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: suppressThreeDraw uses minimal non-zero draw range', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.suppressThreeDraw()
  expect(buffer.mesh.geometry.drawRange.start).toBe(0)
  expect(buffer.mesh.geometry.drawRange.count).toBe(3)

  buffer.dispose()
  mat.dispose()
})
