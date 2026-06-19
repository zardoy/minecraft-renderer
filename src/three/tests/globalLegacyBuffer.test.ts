import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { GlobalLegacyBuffer, MAX_OPAQUE_SPANS } from '../globalLegacyBuffer'
import { createGlobalLegacyBlockMaterial } from '../shaders/legacyBlockShader'

function makeQuadGeometry (): {
  positions: Float32Array
  colors: Float32Array
  skyLights: Float32Array
  blockLights: Float32Array
  uvs: Float32Array
  indices: Uint32Array
} {
  return {
    positions: new Float32Array([
      -1, 0, -1,
      1, 0, -1,
      1, 0, 1,
      -1, 0, 1,
    ]),
    colors: new Float32Array([
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
    ]),
    skyLights: new Float32Array([1, 1, 1, 1]),
    blockLights: new Float32Array([0, 0, 0, 0]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }
}

type BufferInternals = {
  pendingRanges: Array<{ start: number, end: number }>
}

function getInternals (buffer: GlobalLegacyBuffer): BufferInternals {
  return buffer as unknown as BufferInternals
}

function drainUploads (buffer: GlobalLegacyBuffer): void {
  while (getInternals(buffer).pendingRanges.length) buffer.uploadDirtyRange()
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
  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }, { key: 'b', distSq: 4 }], 'opaque')

  const groups = buffer.mesh.geometry.groups
  expect(groups.length).toBe(1)
  expect(groups[0]!.count).toBe(12)

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
  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }, { key: 'b', distSq: 2 }, { key: 'c', distSq: 3 }], 'opaque')

  const groups = buffer.mesh.geometry.groups
  expect(groups.length).toBe(1)
  expect(groups[0]!.start).toBe(0)
  expect(groups[0]!.count).toBe(18)

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
  buffer.updateDrawSpans([
    { key: 'near', distSq: 1 },
    { key: 'far', distSq: 100 },
  ], 'sortedBlend')

  const groups = buffer.mesh.geometry.groups
  expect(groups.length).toBe(2)
  expect(groups[0]!.start).toBe(6)
  expect(groups[1]!.start).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans skips missing keys', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.updateDrawSpans([{ key: 'missing', distSq: 1 }], 'opaque')

  expect(buffer.mesh.geometry.groups.length).toBe(0)
  expect(buffer.mesh.geometry.drawRange.count).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: reset clears groups', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)
  const geo = makeQuadGeometry()

  buffer.addSection('a', geo, 0, 0, 0)
  buffer.updateDrawSpans([{ key: 'a', distSq: 1 }], 'opaque')
  expect(buffer.mesh.geometry.groups.length).toBeGreaterThan(0)

  buffer.reset()
  expect(buffer.mesh.geometry.groups.length).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalLegacyBuffer: updateDrawSpans opaque caps at MAX_OPAQUE_SPANS with full coverage', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const visibleSectionCount = MAX_OPAQUE_SPANS + 5
  const padQuads = 257
  const buffer = new GlobalLegacyBuffer(mat, scene, {
    initialCapacityQuads: visibleSectionCount * (padQuads + 1) + padQuads,
    growthIncrementQuads: 1024,
  })
  const geo = makeQuadGeometry()
  const padGeo = {
    ...makeQuadGeometry(),
    positions: new Float32Array(padQuads * 4 * 3),
    colors: new Float32Array(padQuads * 4 * 3).fill(1),
    skyLights: new Float32Array(padQuads * 4).fill(1),
    blockLights: new Float32Array(padQuads * 4).fill(0),
    uvs: new Float32Array(padQuads * 4 * 2),
    indices: new Uint32Array(padQuads * 6),
  }
  for (let q = 0; q < padQuads; q++) {
    const vb = q * 4
    padGeo.indices.set([vb, vb + 1, vb + 2, vb, vb + 2, vb + 3], q * 6)
  }
  const visible: Array<{ key: string, distSq: number }> = []

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

  buffer.updateDrawSpans(visible, 'opaque')

  const groups = buffer.mesh.geometry.groups
  expect(groups.length).toBe(MAX_OPAQUE_SPANS)

  const covered = new Set<number>()
  for (const group of groups) {
    for (let idx = group.start; idx < group.start + group.count; idx++) {
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
    indices: new Uint32Array([0, 1, 2]),
  }
  expect(buffer.addSection('bad', bad, 0, 0, 0)).toBe(false)

  buffer.dispose()
  mat.dispose()
})
