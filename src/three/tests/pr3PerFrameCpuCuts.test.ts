import { test, expect, vi, afterEach } from 'vitest'
import * as THREE from 'three'

vi.mock('../entity/EntityMesh', () => ({
  getMesh: vi.fn()
}))

import { ChunkMeshManager } from '../chunkMeshManager'
import type { GlobalLegacyBuffer } from '../globalLegacyBuffer'
import type { WorldRendererThree } from '../worldRendererThree'
import type { MesherGeometryOutput } from '../../mesher-shared/shared'

function makeQuadArrays() {
  const positions = new Float32Array([-1, -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1])
  const colors = new Float32Array(12).fill(1)
  const skyLights = new Float32Array(4).fill(1)
  const blockLights = new Float32Array(4).fill(0)
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
  return { positions, colors, skyLights, blockLights, uvs, indices }
}

function makeBlendOnlyGeometry(): MesherGeometryOutput {
  const blend = makeQuadArrays()
  return {
    sectionYNumber: 0,
    chunkKey: '0,0',
    sectionStartY: 0,
    sectionEndY: 16,
    sectionStartX: 0,
    sectionEndX: 16,
    sectionStartZ: 0,
    sectionEndZ: 16,
    sx: 8,
    sy: 8,
    sz: 8,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    skyLights: new Float32Array(0),
    blockLights: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
    indicesCount: 0,
    using32Array: true,
    tiles: {},
    heads: {},
    signs: {},
    banners: {},
    hadErrors: false,
    blocksCount: 1,
    blend: {
      positions: blend.positions,
      normals: new Float32Array(12),
      colors: blend.colors,
      skyLights: blend.skyLights,
      blockLights: blend.blockLights,
      uvs: blend.uvs,
      indices: blend.indices
    }
  }
}

function makeOpaqueOnlyGeometry(sx = 8, sy = 8, sz = 8): MesherGeometryOutput {
  const opaque = makeQuadArrays()
  return {
    sectionYNumber: 0,
    chunkKey: '0,0',
    sectionStartY: 0,
    sectionEndY: 16,
    sectionStartX: 0,
    sectionEndX: 16,
    sectionStartZ: 0,
    sectionEndZ: 16,
    sx,
    sy,
    sz,
    positions: opaque.positions,
    normals: new Float32Array(12),
    colors: opaque.colors,
    skyLights: opaque.skyLights,
    blockLights: opaque.blockLights,
    uvs: opaque.uvs,
    indices: opaque.indices,
    indicesCount: 6,
    using32Array: true,
    tiles: {},
    heads: {},
    signs: {},
    banners: {},
    hadErrors: false,
    blocksCount: 1
  }
}

function makeMixedGeometry(): MesherGeometryOutput {
  const opaque = makeQuadArrays()
  const blend = makeQuadArrays()
  return {
    sectionYNumber: 0,
    chunkKey: '0,0',
    sectionStartY: 0,
    sectionEndY: 16,
    sectionStartX: 0,
    sectionEndX: 16,
    sectionStartZ: 0,
    sectionEndZ: 16,
    sx: 8,
    sy: 8,
    sz: 8,
    positions: opaque.positions,
    normals: new Float32Array(12),
    colors: opaque.colors,
    skyLights: opaque.skyLights,
    blockLights: opaque.blockLights,
    uvs: opaque.uvs,
    indices: opaque.indices,
    indicesCount: 6,
    using32Array: true,
    tiles: {},
    heads: {},
    signs: {},
    banners: {},
    hadErrors: false,
    blocksCount: 2,
    blend: {
      positions: blend.positions,
      normals: new Float32Array(12),
      colors: blend.colors,
      skyLights: blend.skyLights,
      blockLights: blend.blockLights,
      uvs: blend.uvs,
      indices: blend.indices
    }
  }
}

function createManager(): ChunkMeshManager {
  const scene = new THREE.Scene()
  const material = new THREE.MeshBasicMaterial()
  const worldRenderer = {
    shaderCubeBlocksEnabled: () => false,
    getModule: () => undefined,
    sceneOrigin: {
      track: () => {},
      removeAndUntrack: () => {},
      removeAndUntrackAll: () => {}
    },
    blockEntities: {},
    worldRendererConfig: {}
  } as unknown as WorldRendererThree
  return new ChunkMeshManager(worldRenderer, scene, material, 256, 1)
}

type ManagerInternals = {
  legacyCullSections: Map<string, { worldX: number; worldY: number; worldZ: number }>
  registerLegacyCullSection: (key: string, wx: number, wy: number, wz: number) => void
  maybeUnregisterLegacyCullSection: (key: string) => void
}

function getLegacyCullSections(manager: ChunkMeshManager): Map<string, { worldX: number; worldY: number; worldZ: number }> {
  return (manager as unknown as ManagerInternals).legacyCullSections
}

function makeCamera(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  camera.position.set(x, y, z)
  camera.lookAt(8, 8, 8)
  camera.updateMatrixWorld()
  return camera
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('legacyCullSections: gains key on blend add, removed after cleanup', () => {
  const manager = createManager()
  const key = '0,0,0'

  manager.updateSection(key, makeBlendOnlyGeometry())
  expect(getLegacyCullSections(manager).has(key)).toBe(true)

  manager.cleanupSection(key)
  expect(getLegacyCullSections(manager).has(key)).toBe(false)

  manager.dispose()
})

test('legacyCullSections: mixed opaque+blend keeps key until both buffers cleared', () => {
  const manager = createManager()
  const key = '0,0,0'

  manager.updateSection(key, makeMixedGeometry())
  expect(getLegacyCullSections(manager).has(key)).toBe(true)
  expect(manager.globalLegacyBuffer?.hasSection(key)).toBe(true)
  expect(manager.globalLegacyBlendBuffer?.hasSection(key)).toBe(true)

  manager.globalLegacyBuffer?.removeSection(key)
  expect(getLegacyCullSections(manager).has(key)).toBe(true)

  manager.globalLegacyBlendBuffer?.removeSection(key)
  ;(manager as unknown as ManagerInternals).maybeUnregisterLegacyCullSection(key)
  expect(getLegacyCullSections(manager).has(key)).toBe(false)

  manager.cleanupSection(key)
  manager.dispose()
})

test('updateSectionCullAndSort: same visible set skips span rebuild on camera move', () => {
  const manager = createManager()
  const key = '0,0,0'
  manager.updateSection(key, makeBlendOnlyGeometry())

  const blendBuffer = manager.globalLegacyBlendBuffer!
  const updateDrawSpansSpy = vi.spyOn(blendBuffer, 'updateDrawSpans')

  const camera1 = makeCamera(8, 8, 20)
  manager.updateSectionCullAndSort(camera1, 8, 8, 20)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(1)

  while (blendBuffer.hasPendingUploads()) blendBuffer.uploadDirtyRange()

  manager.updateSectionCullAndSort(camera1, 8, 8, 20)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(2)

  const camera2 = makeCamera(8, 8, 18)
  manager.updateSectionCullAndSort(camera2, 8, 8, 18)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(2)

  manager.cleanupSection(key)
  manager.dispose()
})

test('updateSectionCullAndSort: layoutVersion change forces span rebuild', () => {
  const manager = createManager()
  const key = '0,0,0'
  manager.updateSection(key, makeBlendOnlyGeometry())

  const blendBuffer = manager.globalLegacyBlendBuffer!
  const updateDrawSpansSpy = vi.spyOn(blendBuffer, 'updateDrawSpans')

  const camera = makeCamera(8, 8, 20)
  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(1)

  blendBuffer.removeSection(key)
  blendBuffer.addSection(key, makeBlendOnlyGeometry().blend!, 8, 8, 8)
  ;(manager as unknown as ManagerInternals).registerLegacyCullSection(key, 8, 8, 8)

  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(2)

  manager.cleanupSection(key)
  manager.dispose()
})

function drainLegacyUploads(buffer: GlobalLegacyBuffer): void {
  while (buffer.hasPendingUploads()) buffer.uploadDirtyRange()
}

function simulateRenderCullGate(manager: ChunkMeshManager, camera: THREE.PerspectiveCamera, x: number, y: number, z: number): void {
  for (const buf of [manager.globalLegacyBuffer, manager.globalLegacyBlendBuffer, manager.globalBlockBuffer]) {
    if (!buf) continue
    buf.compactStep()
    if (buf.hasPendingUploads()) buf.uploadDirtyRange()
  }
  manager.markCullDirtyIfBufferStateChanged()
  if (manager.cullDirty) {
    manager.updateSectionCullAndSort(camera, x, y, z)
    manager.clearCullDirty()
  }
}

test('markCullDirtyIfBufferStateChanged: finalize layout bump marks cull dirty', () => {
  const manager = createManager()
  const key = '0,0,0'
  manager.updateSection(key, makeOpaqueOnlyGeometry(8, 8, 8))

  const opaqueBuf = manager.globalLegacyBuffer!
  drainLegacyUploads(opaqueBuf)

  const camera = makeCamera(8, 8, 20)
  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  manager.clearCullDirty()

  opaqueBuf.addSection(
    key,
    {
      positions: makeQuadArrays().positions,
      colors: makeQuadArrays().colors,
      skyLights: makeQuadArrays().skyLights,
      blockLights: makeQuadArrays().blockLights,
      uvs: makeQuadArrays().uvs,
      indices: makeQuadArrays().indices
    },
    16,
    8,
    8
  )
  drainLegacyUploads(opaqueBuf)
  opaqueBuf.compactStep()
  expect(opaqueBuf.hasPendingReplace()).toBe(false)

  manager.markCullDirtyIfBufferStateChanged()
  expect(manager.cullDirty).toBe(true)

  manager.cleanupSection(key)
  manager.dispose()
})

test('simulateRenderCullGate: finalize remesh refreshes visible spans without camera move', () => {
  const manager = createManager()
  const key = '0,0,0'
  const camera = makeCamera(8, 8, 20)

  manager.updateSection(key, makeOpaqueOnlyGeometry(8, 8, 8))
  const opaqueBuf = manager.globalLegacyBuffer!
  drainLegacyUploads(opaqueBuf)
  simulateRenderCullGate(manager, camera, 8, 8, 20)

  const slotA = opaqueBuf.getSectionSlot(key)!.start
  opaqueBuf.updateDrawSpans([{ key, distSq: 1 }], 'opaque')
  expect(opaqueBuf.getVisibleIndexSpans()[0]!.indexStart).toBe(slotA * 6)

  manager.updateSection(key, makeOpaqueOnlyGeometry(16, 8, 8))
  for (let i = 0; i < 32 && (manager.hasPendingBufferWork() || opaqueBuf.hasPendingReplace() || opaqueBuf.hasPendingUploads()); i++) {
    simulateRenderCullGate(manager, camera, 8, 8, 20)
  }

  expect(opaqueBuf.hasPendingReplace()).toBe(false)
  expect(opaqueBuf.hasPendingUploads()).toBe(false)

  const drawStart = opaqueBuf.getSectionDrawStart(key)!
  const spans = opaqueBuf.getVisibleIndexSpans()
  expect(spans.length).toBeGreaterThan(0)
  expect(spans[0]!.indexStart).toBe(drawStart * 6)

  manager.cleanupSection(key)
  manager.dispose()
})

test('updateSectionCullAndSort: defrag finalize forces span rebuild with static camera', () => {
  const manager = createManager()
  const keys = ['0,0,0', '1,0,0', '2,0,0'] as const

  for (let i = 0; i < keys.length; i++) {
    manager.updateSection(keys[i]!, makeOpaqueOnlyGeometry(8, 8, 8 + i * 8))
  }

  const opaqueBuf = manager.globalLegacyBuffer!
  const updateDrawSpansSpy = vi.spyOn(opaqueBuf, 'updateDrawSpans')
  const camera = makeCamera(8, 8, 20)

  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(1)

  opaqueBuf.removeSection('1,0,0')
  drainLegacyUploads(opaqueBuf)
  opaqueBuf.compactStep()
  drainLegacyUploads(opaqueBuf)
  opaqueBuf.compactStep()

  manager.updateSectionCullAndSort(camera, 8, 8, 20)
  expect(updateDrawSpansSpy).toHaveBeenCalledTimes(2)

  for (const key of keys) manager.cleanupSection(key)
  manager.dispose()
})
