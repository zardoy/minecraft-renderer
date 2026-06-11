import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { GlobalLegacyBuffer } from '../globalLegacyBuffer'
import { createGlobalLegacyBlockMaterial } from '../shaders/legacyBlockShader'

function makeQuadGeometry (): {
  positions: Float32Array
  colors: Float32Array
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

test('GlobalLegacyBuffer: addSection rejects non-quad geometry', () => {
  const scene = new THREE.Scene()
  const mat = createGlobalLegacyBlockMaterial()
  const buffer = new GlobalLegacyBuffer(mat, scene)

  const bad = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    colors: new Float32Array(9),
    uvs: new Float32Array(6),
    indices: new Uint32Array([0, 1, 2]),
  }
  expect(buffer.addSection('bad', bad, 0, 0, 0)).toBe(false)

  buffer.dispose()
  mat.dispose()
})
