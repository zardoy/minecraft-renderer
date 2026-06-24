import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { GlobalBlockBuffer } from '../globalBlockBuffer'
import { createCubeBlockMaterial } from '../shaders/cubeBlockShader'
import { packWord3 } from '../../wasm-mesher/bridge/shaderCubeBridge'

type BufferInternals = {
  pendingRanges: Array<{ start: number, end: number }>
}

function getInternals (buffer: GlobalBlockBuffer): BufferInternals {
  return buffer as unknown as BufferInternals
}

function drainUploads (buffer: GlobalBlockBuffer): void {
  while (getInternals(buffer).pendingRanges.length) buffer.uploadDirtyRange()
}

function makeSectionWords (faceW0: number[]): Uint32Array {
  const words = new Uint32Array(faceW0.length * 4)
  for (let i = 0; i < faceW0.length; i++) {
    words[i * 4] = faceW0[i]!
    words[i * 4 + 1] = 0
    words[i * 4 + 2] = 0
    words[i * 4 + 3] = packWord3(0, 0)
  }
  return words
}

function finishCurrentMove (buffer: GlobalBlockBuffer): void {
  drainUploads(buffer)
  buffer.compactStep()
}

test('GlobalBlockBuffer: new section gated until upload completes', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([1]), 1)
  expect(buffer.getSectionDrawStart('a')).toBeUndefined()

  drainUploads(buffer)
  expect(buffer.getSectionDrawStart('a')).toBe(0)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: remesh double-buffers old geometry until upload', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  drainUploads(buffer)
  const oldStart = buffer.getSectionSlot('a')!.start

  buffer.addSection('a', makeSectionWords([20]), 1)
  expect(buffer.getSectionDrawStart('a')).toBe(oldStart)
  expect(buffer.hasPendingReplace()).toBe(true)

  const w0 = buffer.mesh.geometry.getAttribute('a_w0').array as Uint32Array
  expect(w0[oldStart]).toBe(10)

  const epochBefore = buffer.getUploadEpoch()
  drainUploads(buffer)
  buffer.compactStep()
  expect(buffer.hasPendingReplace()).toBe(false)
  expect(buffer.getUploadEpoch()).toBeGreaterThan(epochBefore)
  finishCurrentMove(buffer)
  expect(buffer.getSectionDrawStart('a')).toBe(buffer.getSectionSlot('a')!.start)
  expect(w0[buffer.getSectionSlot('a')!.start]).toBe(20)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: remesh stays drawable when slot kept (updateSection flow)', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  drainUploads(buffer)
  expect(buffer.getSectionDrawStart('a')).toBe(0)

  // updateSection forRemesh: do NOT removeSection before addSection
  buffer.addSection('a', makeSectionWords([20]), 1)
  expect(buffer.getSectionDrawStart('a')).toBeDefined()
  expect(buffer.hasPendingReplace()).toBe(true)

  drainUploads(buffer)
  buffer.compactStep()
  expect(buffer.hasPendingReplace()).toBe(false)
  finishCurrentMove(buffer)
  expect(buffer.getSectionDrawStart('a')).toBe(buffer.getSectionSlot('a')!.start)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: pre-remove before remesh leaves drawable hole until upload', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([10]), 1)
  drainUploads(buffer)

  buffer.removeSection('a')
  buffer.addSection('a', makeSectionWords([20]), 1)
  expect(buffer.getSectionDrawStart('a')).toBeUndefined()
  expect(buffer.hasPendingReplace()).toBe(false)

  drainUploads(buffer)
  expect(buffer.getSectionDrawStart('a')).toBeDefined()

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: canUseFullDrawShortcut false while uploads pending', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  buffer.addSection('a', makeSectionWords([1, 2, 3]), 3)
  expect(buffer.canUseFullDrawShortcut()).toBe(false)

  drainUploads(buffer)
  expect(buffer.canUseFullDrawShortcut()).toBe(true)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: uploadEpoch increments on partial upload advance', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  const faceCount = 20_000
  const words = new Uint32Array(faceCount * 4)
  for (let i = 0; i < faceCount; i++) {
    words[i * 4] = i + 1
  }
  buffer.addSection('a', words, faceCount)
  const epoch0 = buffer.getUploadEpoch()
  buffer.uploadDirtyRange()
  expect(buffer.getUploadEpoch()).toBe(epoch0 + 1)
  expect(buffer.hasPendingUploads()).toBe(true)

  buffer.dispose()
  mat.dispose()
})

test('GlobalBlockBuffer: uploadEpoch increments when dirty range drains', () => {
  const scene = new THREE.Scene()
  const mat = createCubeBlockMaterial()
  const buffer = new GlobalBlockBuffer(mat, scene)

  const epoch0 = buffer.getUploadEpoch()
  buffer.addSection('a', makeSectionWords([1]), 1)
  drainUploads(buffer)
  expect(buffer.getUploadEpoch()).toBeGreaterThan(epoch0)

  buffer.dispose()
  mat.dispose()
})
